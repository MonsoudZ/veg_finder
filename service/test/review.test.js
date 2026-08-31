import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateRestaurant } from "../src/catalog-input.js";
import { openSQLiteStore } from "../src/database.js";
import { autoPublishTiers, proposeMenu } from "../src/proposals.js";

const LABELLED = `<html><body>
  <p>VG = Vegan, V = Vegetarian</p>
  <li>Roasted Cauliflower (VG)</li><li>$11</li>
  <li>Halloumi Skewers (V)</li><li>$13</li>
</body></html>`;

const ID = "bbbbbbbb-0000-4000-8000-000000000001";

async function storeWithRestaurant(label) {
  const store = openSQLiteStore(join(mkdtempSync(join(tmpdir(), `vf-${label}-`)), "c.sqlite"));
  await store.upsertRestaurant(validateRestaurant({
    id: ID, name: "Corner Bistro", neighborhood: "Capitol Hill", address: "1 Main St",
    latitude: 39.74, longitude: -104.98, menuURL: "https://example.com/menu"
  }).value);
  return store;
}

const draft = (name, status = "Vegan") => ({
  id: "cccccccc-0000-4000-8000-00000000000" + name.length,
  name, description: "", price: "$11", dietaryStatus: status,
  modificationNote: null, sourceEvidence: `${name} (VG) $11`
});

test("a draft that cannot publish is kept for a reviewer instead of discarded", async () => {
  const store = await storeWithRestaurant("held");
  const result = await proposeMenu(store, await store.getCheckTarget(ID), {
    fetchImpl: async () => new Response(LABELLED)
  });

  assert.equal(result.published, false, "labelled menus wait for review by default");
  const pending = await store.listProposals({ status: "pending" });
  assert.equal(pending.length, 2, "the drafts must survive the request that produced them");
  assert.equal(pending[0].restaurantName, "Corner Bistro");
  assert.deepEqual(
    pending.map((p) => p.item.name), ["Roasted Cauliflower", "Halloumi Skewers"],
    "drafts keep menu order so the reviewer's list does not reshuffle"
  );
  assert.match(pending[0].item.sourceEvidence, /\(VG\)/, "evidence travels with the draft");
  await store.close();
});

test("a draft that publishes on its own is not also queued for review", async () => {
  const store = await storeWithRestaurant("published");
  store.database.prepare("UPDATE restaurants SET menu_profile='fully_vegan' WHERE id=?").run(ID);

  const result = await proposeMenu(store, await store.getCheckTarget(ID), {
    fetchImpl: async () => new Response("<p>We are 100% vegan</p><li>Bowl</li><li>$12</li>")
  });

  assert.equal(result.published, true);
  assert.equal((await store.listProposals({ status: "pending" })).length, 0);
  await store.close();
});

test("re-drafting replaces what is still pending but preserves decisions already made", async () => {
  const store = await storeWithRestaurant("replace");
  await store.saveProposals(ID, { tier: "labelled_menu", items: [draft("Cauliflower"), draft("Halloumi")] });

  const [first] = await store.listProposals({ status: "pending" });
  assert.equal(await store.decideProposal(first.id, { status: "rejected", note: "contains anchovy" }), true);

  await store.saveProposals(ID, { tier: "labelled_menu", items: [draft("Aubergine")] });

  const pending = await store.listProposals({ status: "pending" });
  const rejected = await store.listProposals({ status: "rejected" });
  assert.deepEqual(pending.map((p) => p.item.name), ["Aubergine"], "stale drafts are replaced");
  assert.equal(rejected.length, 1, "a decision already made is history and survives re-drafting");
  assert.equal(rejected[0].note, "contains anchovy");
  await store.close();
});

test("a proposal cannot be decided twice", async () => {
  const store = await storeWithRestaurant("twice");
  await store.saveProposals(ID, { tier: "labelled_menu", items: [draft("Cauliflower")] });
  const [proposal] = await store.listProposals({ status: "pending" });

  assert.equal(await store.decideProposal(proposal.id, { status: "accepted" }), true);
  assert.equal(
    await store.decideProposal(proposal.id, { status: "rejected" }), false,
    "a second decision must not silently overwrite the first"
  );
  assert.equal((await store.listProposals({ status: "accepted" })).length, 1);
  await store.close();
});

test("proposals are listable per restaurant and carry their tier", async () => {
  const store = await storeWithRestaurant("filter");
  await store.upsertRestaurant(validateRestaurant({
    id: "bbbbbbbb-0000-4000-8000-000000000002", name: "Other Place", neighborhood: "Capitol Hill",
    address: "2 Main St", latitude: 39.74, longitude: -104.98, menuURL: "https://example.com/m"
  }).value);
  await store.saveProposals(ID, { tier: "labelled_menu", items: [draft("Cauliflower")] });
  await store.saveProposals("bbbbbbbb-0000-4000-8000-000000000002",
    { tier: "llm_assisted", items: [draft("Tempeh")] });

  assert.equal((await store.listProposals({ restaurantID: ID })).length, 1);
  assert.equal((await store.listProposals({})).length, 2);
  assert.equal((await store.listProposals({ restaurantID: ID }))[0].tier, "labelled_menu");
  await store.close();
});

test("accepting drafts and publishing them puts exactly those items in the catalog", async () => {
  const store = await storeWithRestaurant("publish");
  await proposeMenu(store, await store.getCheckTarget(ID), {
    fetchImpl: async () => new Response(LABELLED),
    tiers: autoPublishTiers("")
  });

  const pending = await store.listProposals({ status: "pending" });
  assert.equal(pending.length, 2);
  const keepThis = pending.find((p) => p.item.name === "Roasted Cauliflower");
  const dropThis = pending.find((p) => p.item.name === "Halloumi Skewers");
  await store.decideProposal(keepThis.id, { status: "accepted" });
  await store.decideProposal(dropThis.id, { status: "rejected", note: "halloumi is not vegan here" });

  // What the review page does on Publish: reconcile with kept + accepted.
  const accepted = (await store.listProposals({ status: "accepted" })).map((p) => p.item);
  const restaurant = await store.reconcileRestaurant(ID, {
    coverageStatus: "Complete", menuItems: accepted
  });

  assert.deepEqual(restaurant.menuItems.map((i) => i.name), ["Roasted Cauliflower"]);
  assert.equal(restaurant.coverageStatus, "Complete");
  assert.equal((await store.getReviewQueue()).length, 0, "publishing clears the review");
  await store.close();
});
