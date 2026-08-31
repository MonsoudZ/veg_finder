import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateRestaurant } from "../src/catalog-input.js";
import { openSQLiteStore } from "../src/database.js";
import { TIERS } from "../src/extraction.js";
import { autoPublishTiers, proposeMenu, stableItemID } from "../src/proposals.js";

const VEGAN_PAGE = `<html><body>
  <p>We are a 100% vegan kitchen.</p>
  <li>Chana Masala Bowl $12.00</li>
  <li>Jackfruit Tacos $13.50</li>
</body></html>`;

const LABELLED_PAGE = `<html><body>
  <p>VG = Vegan, V = Vegetarian</p>
  <li>Roasted Cauliflower (VG) $11</li>
  <li>Halloumi Skewers (V) $13</li>
  <li>Lamb Kofta $18</li>
</body></html>`;

const UNMARKED_PAGE = `<html><body>
  <li>Veggie Burger $14</li>
  <li>Garden Salad $9</li>
</body></html>`;

async function storeWithRestaurant(label, overrides = {}) {
  const store = openSQLiteStore(join(mkdtempSync(join(tmpdir(), `vf-${label}-`)), "c.sqlite"));
  const input = validateRestaurant({
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    name: "Green Kitchen", neighborhood: "Capitol Hill", address: "1 Main St",
    latitude: 39.74, longitude: -104.98, menuURL: "https://example.com/menu",
    ...overrides
  });
  assert.equal(input.valid, true, input.errors.join("; "));
  await store.upsertRestaurant(input.value);
  return { store, id: input.value.id };
}

const serving = (html) => async () => new Response(html);

test("an operator-declared vegan restaurant publishes without review", async () => {
  const { store, id } = await storeWithRestaurant("auto", { menuProfile: "fully_vegan" });
  const result = await proposeMenu(store, await store.getCheckTarget(id), {
    fetchImpl: serving(VEGAN_PAGE)
  });

  assert.equal(result.tier, TIERS.FULLY_VEGAN);
  assert.equal(result.published, true);
  assert.equal(result.items.length, 2);

  const restaurant = await store.getRestaurant(id);
  assert.equal(restaurant.coverageStatus, "Complete");
  assert.equal(restaurant.menuItems.length, 2);
  assert.match(restaurant.coverageScope, /whole menu is vegan/);
  assert.equal((await store.getReviewQueue()).length, 0, "publishing must drain the queue");
  await store.close();
});

test("a labelled menu proposes but does not publish under the default policy", async () => {
  const { store, id } = await storeWithRestaurant("labelled");
  const result = await proposeMenu(store, await store.getCheckTarget(id), {
    fetchImpl: serving(LABELLED_PAGE)
  });

  assert.equal(result.tier, TIERS.LABELLED_MENU);
  assert.equal(result.items.length, 2);
  assert.equal(result.published, false, "the default policy publishes only fully-vegan menus");
  assert.match(result.reasons.join(" "), /not configured to publish without review/);

  const restaurant = await store.getRestaurant(id);
  assert.equal(restaurant.menuItems.length, 0, "an unpublished proposal must not reach the app");
  assert.equal(restaurant.coverageStatus, "Needs review");
  await store.close();
});

test("an operator can widen the policy to publish labelled menus", async () => {
  const { store, id } = await storeWithRestaurant("labelled-auto");
  const result = await proposeMenu(store, await store.getCheckTarget(id), {
    fetchImpl: serving(LABELLED_PAGE),
    tiers: autoPublishTiers("fully_vegan,labelled_menu")
  });

  assert.equal(result.published, true);
  const restaurant = await store.getRestaurant(id);
  assert.deepEqual(
    restaurant.menuItems.map((item) => [item.name, item.dietaryStatus]),
    [["Roasted Cauliflower", "Vegan"], ["Halloumi Skewers", "Vegetarian"]]
  );
  assert.match(restaurant.coverageScope, /own dietary legend/);
  await store.close();
});

test("an unmarked menu publishes nothing at all", async () => {
  const { store, id } = await storeWithRestaurant("manual");
  const result = await proposeMenu(store, await store.getCheckTarget(id), {
    fetchImpl: serving(UNMARKED_PAGE),
    tiers: autoPublishTiers("fully_vegan,labelled_menu,manual")
  });

  assert.equal(result.tier, TIERS.MANUAL);
  assert.equal(result.items.length, 0);
  assert.equal(result.published, false, "even a permissive policy has nothing to publish");
  assert.equal((await store.getRestaurant(id)).menuItems.length, 0);
  await store.close();
});

test("an operator can opt a restaurant out of automated extraction", async () => {
  const { store, id } = await storeWithRestaurant("optout", { menuProfile: "manual" });
  let fetched = 0;
  const result = await proposeMenu(store, await store.getCheckTarget(id), {
    fetchImpl: async () => { fetched += 1; return new Response(VEGAN_PAGE); }
  });

  assert.equal(result.tier, TIERS.MANUAL);
  assert.equal(result.published, false);
  assert.equal(fetched, 0, "an opted-out restaurant should not even be fetched");
  await store.close();
});

test("re-extracting an unchanged menu keeps item identity and history stable", async () => {
  const { store, id } = await storeWithRestaurant("stable", { menuProfile: "fully_vegan" });
  const target = await store.getCheckTarget(id);
  await proposeMenu(store, target, { fetchImpl: serving(VEGAN_PAGE) });
  const first = (await store.getRestaurant(id)).menuItems.map((item) => item.id).sort();

  await proposeMenu(store, await store.getCheckTarget(id), { fetchImpl: serving(VEGAN_PAGE) });
  const second = (await store.getRestaurant(id)).menuItems.map((item) => item.id).sort();

  assert.deepEqual(second, first, "a stable dish must keep its id across runs");
  const versions = store.database.prepare(
    "SELECT COUNT(*) AS count FROM menu_item_versions"
  ).get().count;
  assert.equal(versions, 2, "an unchanged re-extraction must not churn version history");
  await store.close();
});

test("derived item ids are stable, namespaced, and valid UUIDs", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const a = stableItemID("11111111-1111-4111-8111-111111111111", "Chana Bowl");
  assert.match(a, uuid);
  assert.equal(a, stableItemID("11111111-1111-4111-8111-111111111111", "  chana bowl  "));
  assert.notEqual(a, stableItemID("22222222-2222-4222-8222-222222222222", "Chana Bowl"));
});

test("the default policy publishes only what the restaurant asserts about itself", () => {
  const defaults = autoPublishTiers(undefined);
  // Both defaults are whole-restaurant facts an operator records, leaving no
  // per-dish judgement to make.
  assert.deepEqual([...defaults].sort(), ["fully_vegan", "fully_vegetarian"]);
  // Anything requiring a judgement per dish stays behind review.
  assert.equal(defaults.has("labelled_menu"), false);
  assert.equal(defaults.has("llm_assisted"), false);
  assert.equal(defaults.has("manual"), false);
  assert.deepEqual([...autoPublishTiers("")], [], "an empty setting publishes nothing");
});

test("a source that cannot be fetched fails loudly rather than publishing", async () => {
  const { store, id } = await storeWithRestaurant("broken", { menuProfile: "fully_vegan" });
  await assert.rejects(
    proposeMenu(store, await store.getCheckTarget(id), {
      fetchImpl: async () => { throw new Error("connection refused"); }
    }),
    /connection refused/
  );
  assert.equal((await store.getRestaurant(id)).menuItems.length, 0);
  await store.close();
});

test("a whole-menu claim on a linked page drafts every dish but publishes none", async () => {
  // The Cake Bar: 32 cakes on a menu page that never says vegan, and the claim
  // that covers all of them on the home page. Worth drafting from; not worth
  // publishing unseen, because a linked page may be describing a sister
  // restaurant rather than this one.
  const { store, id } = await storeWithRestaurant("linked-claim", {
    claimURL: "https://example.com/about"
  });
  const target = await store.getCheckTarget(id);

  const result = await proposeMenu(store, target, {
    fetchImpl: async (url) => new Response(
      String(url).endsWith("/about")
        ? "<html><body><h1>Denver's Favorite Vegan Bakery</h1></body></html>"
        : UNMARKED_PAGE
    ),
    tiers: autoPublishTiers()
  });

  assert.equal(result.tier, TIERS.FULLY_VEGAN);
  assert.equal(result.items.length, 2);
  assert.equal(result.published, false, "a linked claim must not publish unseen");
  assert.ok(result.reasons.some((reason) => /Vegan Bakery/.test(reason)), "the claim is quoted");
  assert.ok(result.reasons.some((reason) => /one reviewer confirms it/.test(reason)));

  // One confirmation covers the whole menu, so all of it reaches the queue.
  const pending = await store.listProposals({ restaurantID: id, status: "pending" });
  assert.equal(pending.length, 2);
  await store.close();
});

test("a claim page that stops resolving is reported, not silently ignored", async () => {
  const { store, id } = await storeWithRestaurant("claim-gone", {
    claimURL: "https://example.com/about"
  });
  const target = await store.getCheckTarget(id);

  const result = await proposeMenu(store, target, {
    fetchImpl: async (url) => String(url).endsWith("/about")
      ? new Response("nope", { status: 404 })
      : new Response(UNMARKED_PAGE),
    tiers: autoPublishTiers()
  });

  // Losing the claim costs coverage, never correctness: the restaurant falls
  // back to what its own menu says, which here is nothing.
  assert.equal(result.tier, TIERS.MANUAL);
  assert.equal(result.published, false);
  assert.ok(
    result.reasons.some((reason) => /returned HTTP 404/.test(reason)),
    `a dead claim page must not look like a restaurant that never made a claim: ${result.reasons}`
  );
  await store.close();
});

test("a PDF menu says it cannot be read rather than blaming a missing legend", async () => {
  const { store, id } = await storeWithRestaurant("pdf-menu");
  const target = await store.getCheckTarget(id);

  const result = await proposeMenu(store, target, {
    fetchImpl: async () => new Response("%PDF-1.4 stream binary residue"),
    tiers: autoPublishTiers()
  });

  assert.equal(result.tier, TIERS.MANUAL);
  assert.equal(result.items.length, 0);
  assert.match(result.reasons[0], /PDF or other binary document/);
  assert.ok(
    !result.reasons.some((reason) => /legend/.test(reason)),
    "a PDF's problem is not that it published no legend"
  );
  await store.close();
});
