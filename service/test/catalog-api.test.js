import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateMenuItems, validateRestaurant } from "../src/catalog-input.js";
import { openSQLiteStore } from "../src/database.js";
import { distanceKm } from "../src/geo.js";

const CAPITOL_HILL = { latitude: 39.7340, longitude: -104.9800 };

function freshStore(label) {
  const store = openSQLiteStore(join(mkdtempSync(join(tmpdir(), `vf-${label}-`)), "c.sqlite"));
  return store;
}

function restaurantInput(overrides = {}) {
  return {
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    name: "Test Kitchen",
    neighborhood: "Capitol Hill",
    address: "100 E Colfax Ave",
    latitude: 39.7402,
    longitude: -104.9847,
    menuURL: "https://example.com/menu",
    ...overrides
  };
}

function menuItem(overrides = {}) {
  return {
    id: "cccccccc-0000-4000-8000-000000000001",
    name: "Chana Bowl",
    description: "Chickpeas",
    price: "$12",
    dietaryStatus: "Vegan",
    sourceEvidence: "Menu marks this VG",
    ...overrides
  };
}

test("nearby returns only restaurants inside the radius, nearest first", async () => {
  const store = freshStore("near");
  await store.importSeed();

  const page = await store.getCatalogPage({ ...CAPITOL_HILL, radiusKm: 2, limit: 50 });
  assert.ok(page.restaurants.length > 0);

  const distances = page.restaurants.map(
    (r) => distanceKm(CAPITOL_HILL.latitude, CAPITOL_HILL.longitude, r.latitude, r.longitude)
  );
  assert.deepEqual(distances, [...distances].sort((a, b) => a - b), "must be distance ordered");
  assert.ok(distances.every((km) => km <= 2), "must not leak results outside the radius");

  const tight = await store.getCatalogPage({ ...CAPITOL_HILL, radiusKm: 0.25, limit: 50 });
  assert.ok(tight.restaurants.length < page.restaurants.length);
  await store.close();
});

test("nearby honours its limit", async () => {
  const store = freshStore("near-limit");
  await store.importSeed();
  const page = await store.getCatalogPage({ ...CAPITOL_HILL, radiusKm: 50, limit: 3 });
  assert.equal(page.restaurants.length, 3);
  await store.close();
});

test("the cursor walks the whole catalog exactly once", async () => {
  const store = freshStore("page");
  await store.importSeed();

  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await store.getCatalogPage({ limit: 3, cursor });
    seen.push(...page.restaurants.map((restaurant) => restaurant.id));
    cursor = page.nextCursor;
    pages += 1;
    assert.ok(pages < 20, "pagination must terminate");
  } while (cursor);

  assert.equal(seen.length, 10);
  assert.equal(new Set(seen).size, 10, "no restaurant may appear on two pages");
  assert.ok(pages > 1, "the catalog must actually have been split");
  await store.close();
});

test("a tampered cursor is ignored rather than trusted", async () => {
  const store = freshStore("cursor");
  await store.importSeed();
  const page = await store.getCatalogPage({ limit: 5, cursor: "not-a-real-cursor" });
  assert.equal(page.restaurants.length, 5, "an unreadable cursor restarts from the beginning");
  await store.close();
});

test("delta sync returns nothing until something changes", async () => {
  const store = freshStore("delta");
  await store.importSeed();

  const initial = await store.getCatalogPage({ limit: 100 });
  assert.equal(initial.restaurants.length, 10);

  const quiet = await store.getCatalogPage({ since: initial.syncedAt, limit: 100 });
  assert.equal(quiet.restaurants.length, 0, "an unchanged catalog must produce an empty delta");

  await store.upsertRestaurant(validateRestaurant(restaurantInput()).value);

  const delta = await store.getCatalogPage({ since: initial.syncedAt, limit: 100 });
  assert.equal(delta.restaurants.length, 1);
  assert.equal(delta.restaurants[0].name, "Test Kitchen");
  await store.close();
});

test("a new restaurant is unpublished and queued for review", async () => {
  const store = freshStore("create");
  const { created } = await store.upsertRestaurant(validateRestaurant(restaurantInput()).value);
  assert.equal(created, true);

  const restaurant = await store.getRestaurant(restaurantInput().id);
  assert.equal(restaurant.coverageStatus, "Needs review");
  assert.equal(restaurant.menuItems.length, 0, "nothing may be published before it is audited");
  assert.equal((await store.getReviewQueue()).length, 1);

  const again = await store.upsertRestaurant(validateRestaurant(restaurantInput({ name: "Renamed" })).value);
  assert.equal(again.created, false);
  assert.equal((await store.getRestaurant(restaurantInput().id)).name, "Renamed");
  await store.close();
});

test("reconciling publishes the menu, stamps the audit, and drains the queue", async () => {
  const store = freshStore("reconcile");
  await store.upsertRestaurant(validateRestaurant(restaurantInput()).value);

  const before = new Date().toISOString();
  const restaurant = await store.reconcileRestaurant(restaurantInput().id, {
    coverageStatus: "Complete",
    coverageScope: "All qualifying dishes",
    menuItems: validateMenuItems([
      menuItem(),
      menuItem({
        id: "cccccccc-0000-4000-8000-000000000002",
        name: "Street Tacos",
        dietaryStatus: "Can be made vegan",
        modificationNote: "Ask for no crema",
        sourceEvidence: "Menu lists crema as removable"
      })
    ]).value
  });

  assert.equal(restaurant.coverageStatus, "Complete");
  assert.equal(restaurant.menuItems.length, 2);
  assert.ok(restaurant.auditedAt >= before, "reconciling must advance the audit timestamp");
  assert.equal((await store.getReviewQueue()).length, 0);

  // node:sqlite returns null-prototype rows, so compare the values not the shape.
  const versions = store.database.prepare(
    "SELECT change_kind, COUNT(*) AS count FROM menu_item_versions GROUP BY change_kind"
  ).all();
  assert.equal(versions.length, 1);
  assert.equal(versions[0].change_kind, "published");
  assert.equal(versions[0].count, 2);
  await store.close();
});

test("reconciling with an empty menu unpublishes everything", async () => {
  const store = freshStore("reconcile-empty");
  await store.upsertRestaurant(validateRestaurant(restaurantInput()).value);
  await store.reconcileRestaurant(restaurantInput().id, {
    coverageStatus: "Complete", menuItems: validateMenuItems([menuItem()]).value
  });
  await store.reconcileRestaurant(restaurantInput().id, {
    coverageStatus: "Needs review", menuItems: []
  });

  const restaurant = await store.getRestaurant(restaurantInput().id);
  assert.equal(restaurant.menuItems.length, 0);
  assert.equal(restaurant.coverageStatus, "Needs review");
  assert.equal((await store.getReviewQueue()).length, 1, "demoting must re-queue it");
  await store.close();
});

test("reconciling an unknown restaurant reports not found", async () => {
  const store = freshStore("reconcile-missing");
  const result = await store.reconcileRestaurant("dddddddd-0000-4000-8000-000000000009", {
    coverageStatus: "Complete", menuItems: []
  });
  assert.equal(result, null);
  await store.close();
});

test("restaurant input is rejected before it can reach the catalog", () => {
  assert.equal(validateRestaurant(restaurantInput()).valid, true);
  const cases = [
    [{ id: "nope" }, /id must be a UUID/],
    [{ name: "" }, /name is required/],
    [{ latitude: 200 }, /latitude must be a number/],
    [{ menuURL: "javascript:alert(1)" }, /menuURL must be an http/],
    [{ extractionMode: "guess" }, /extractionMode must be one of/]
  ];
  for (const [override, pattern] of cases) {
    const result = validateRestaurant(restaurantInput(override));
    assert.equal(result.valid, false, `${JSON.stringify(override)} should be rejected`);
    assert.ok(result.errors.some((error) => pattern.test(error)), result.errors.join("; "));
  }
});

test("menu input enforces the rules the app relies on", () => {
  assert.equal(validateMenuItems([menuItem()]).valid, true);

  const missingNote = validateMenuItems([menuItem({ dietaryStatus: "Can be made vegan" })]);
  assert.equal(missingNote.valid, false);
  assert.match(missingNote.errors[0], /modificationNote is required/);

  const strayNote = validateMenuItems([menuItem({ modificationNote: "Remove cheese" })]);
  assert.equal(strayNote.valid, false);
  assert.match(strayNote.errors[0], /only valid for a modified dish/);

  const noEvidence = validateMenuItems([menuItem({ sourceEvidence: "  " })]);
  assert.equal(noEvidence.valid, false);
  assert.match(noEvidence.errors[0], /sourceEvidence is required/);

  const badStatus = validateMenuItems([menuItem({ dietaryStatus: "Probably vegan" })]);
  assert.equal(badStatus.valid, false);
  assert.match(badStatus.errors[0], /dietaryStatus must be one of/);

  const duplicated = validateMenuItems([menuItem(), menuItem()]);
  assert.equal(duplicated.valid, false);
  assert.match(duplicated.errors.join(" "), /duplicated/);
});

test("a delta scoped to a radius can still be paged to completion", async () => {
  // Distance ranking cannot page. A delta must, or a client with more changes
  // than fit in one page silently loses the rest.
  const store = freshStore("delta-paged");
  await store.importSeed();

  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await store.getCatalogPage({
      since: "2000-01-01T00:00:00.000Z", ...CAPITOL_HILL, radiusKm: 50, limit: 3, cursor
    });
    seen.push(...page.restaurants.map((r) => r.id));
    cursor = page.nextCursor;
    assert.ok(++pages < 20, "pagination must terminate");
  } while (cursor);

  assert.equal(seen.length, 10, "every changed restaurant in range must be reachable");
  assert.equal(new Set(seen).size, 10);
  assert.ok(pages > 1, "the delta must actually have been split");
  await store.close();
});

test("a delta respects the radius it was given", async () => {
  const store = freshStore("delta-radius");
  await store.importSeed();
  await store.upsertRestaurant(validateRestaurant(restaurantInput({
    name: "Far Away", latitude: 40.5, longitude: -104.98
  })).value);

  const near = await store.getCatalogPage({
    since: "2000-01-01T00:00:00.000Z", ...CAPITOL_HILL, radiusKm: 5, limit: 100
  });
  assert.ok(!near.restaurants.some((r) => r.name === "Far Away"), "out-of-range changes are not sent");

  const wide = await store.getCatalogPage({
    since: "2000-01-01T00:00:00.000Z", ...CAPITOL_HILL, radiusKm: 200, limit: 100
  });
  assert.ok(wide.restaurants.some((r) => r.name === "Far Away"));
  await store.close();
});

test("the sync watermark is the newest record seen, not the last one listed", async () => {
  const store = freshStore("watermark");
  await store.importSeed();
  // Touch a restaurant that sorts last by distance and first by name, so an
  // ordering-based watermark would be wrong.
  const [first] = (await store.getCatalogPage({ limit: 1 })).restaurants;
  await store.reconcileRestaurant(first.id, {
    coverageStatus: "Complete",
    menuItems: [{
      id: "cccccccc-0000-4000-8000-000000000009", name: "New Dish", description: "",
      price: "$9", dietaryStatus: "Vegan", modificationNote: null, sourceEvidence: "menu"
    }]
  });

  const page = await store.getCatalogPage({ ...CAPITOL_HILL, radiusKm: 50, limit: 100 });
  const newest = page.restaurants.map((r) => r.updatedAt).sort().at(-1);
  assert.equal(page.syncedAt, newest, "a watermark past an unseen change would lose it");

  // Using it must return nothing further.
  const after = await store.getCatalogPage({ since: page.syncedAt, ...CAPITOL_HILL, radiusKm: 50, limit: 100 });
  assert.equal(after.restaurants.length, 0);
  await store.close();
});
