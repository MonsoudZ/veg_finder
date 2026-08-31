import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkMenus } from "../src/checker.js";
import { openSQLiteStore } from "../src/database.js";
import { defaultSeedPath } from "../src/paths.js";

// Writes a copy of the audited seed with a different audit timestamp, standing in
// for an operator who has (or has not) reconciled the menus against their sources.
function seedAuditedAt(auditedAt, { coverageStatus = "Complete" } = {}) {
  const seed = JSON.parse(readFileSync(defaultSeedPath, "utf8"));
  seed.restaurants = seed.restaurants.map((restaurant) => ({
    ...restaurant, auditedAt, coverageStatus
  }));
  const path = join(mkdtempSync(join(tmpdir(), "vegfinder-seed-")), "catalog.seed.json");
  writeFileSync(path, JSON.stringify(seed));
  return path;
}

// Drives the checker twice so the second run sees a different fingerprint and
// demotes every restaurant to 'Needs review'.
async function demoteEveryRestaurant(store) {
  const logger = { log() {}, error() {} };
  await checkMenus(store, { fetchImpl: async () => new Response("<main>one</main>"), logger });
  await checkMenus(store, { fetchImpl: async () => new Response("<main>two</main>"), logger });
}

function openTemporaryStore(label) {
  return openSQLiteStore(join(mkdtempSync(join(tmpdir(), `vegfinder-${label}-`)), "catalog.sqlite"));
}

test("seed publishes every stored menu item and modification note", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vegfinder-test-"));
  const store = openSQLiteStore(join(directory, "catalog.sqlite"));
  await store.importSeed();

  const catalog = await store.getCatalog();
  assert.equal(catalog.restaurants.length, 10);
  assert.ok(catalog.restaurants.every((restaurant) => restaurant.menuItems.length > 0));
  assert.equal(catalog.restaurants.flatMap((restaurant) => restaurant.menuItems).length, 128);
  assert.equal(catalog.restaurants.find((restaurant) => restaurant.name === "Jelly Cafe").menuItems.length, 14);
  assert.ok(catalog.restaurants.every((restaurant) => restaurant.coverageStatus === "Complete"));
  assert.ok(catalog.restaurants.every((restaurant) => restaurant.auditedAt));

  const modifiedItems = catalog.restaurants
    .flatMap((restaurant) => restaurant.menuItems)
    .filter((item) => item.dietaryStatus.includes("made"));
  assert.ok(modifiedItems.length > 0);
  assert.ok(modifiedItems.every((item) => item.modificationNote?.length > 0));
  const versionCount = store.database.prepare(
    "SELECT COUNT(*) AS count FROM menu_item_versions"
  ).get().count;
  assert.equal(versionCount, 128);
  await store.close();
});

test("menu checker flags a changed official source for review", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vegfinder-check-test-"));
  const store = openSQLiteStore(join(directory, "catalog.sqlite"));
  await store.importSeed();
  store.database.prepare("UPDATE restaurants SET extraction_mode = 'browser_required' WHERE name = 'Jelly Cafe'").run();
  const logger = { log() {}, error() {} };
  let browserChecks = 0;
  const browserFetchImpl = async () => {
    browserChecks += 1;
    return "<main>Browser menu version</main>";
  };

  await checkMenus(store, {
    fetchImpl: async () => new Response("<main>Menu version one</main>"),
    browserFetchImpl,
    logger
  });
  await checkMenus(store, {
    fetchImpl: async () => new Response("<main>Menu version two</main>"),
    browserFetchImpl: async () => {
      browserChecks += 1;
      return "<main>Changed browser menu version</main>";
    },
    logger
  });

  const row = store.database.prepare(`
    SELECT COUNT(*) AS count FROM restaurants WHERE review_required = 1
  `).get();
  assert.equal(row.count, 10);
  assert.equal(browserChecks, 2);
  const catalog = await store.getCatalog();
  assert.ok(catalog.restaurants.every((restaurant) => restaurant.coverageStatus === "Needs review"));
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM menu_check_runs").get().count, 20);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM menu_source_snapshots").get().count, 20);
  await store.close();
});

test("re-seeding without a fresh audit cannot re-publish a demoted restaurant", async () => {
  const store = openTemporaryStore("stale-reseed");
  await store.importSeed();
  await demoteEveryRestaurant(store);
  assert.equal((await store.getReviewQueue()).length, 10);

  // Same audit timestamp as the seed already in the database: nothing was reconciled.
  await store.importSeed(seedAuditedAt("2026-08-30T00:00:00Z"));

  const catalog = await store.getCatalog();
  assert.ok(
    catalog.restaurants.every((restaurant) => restaurant.coverageStatus === "Needs review"),
    "a seed with no fresh audit must not clear the checker's demotion"
  );
  assert.equal((await store.getReviewQueue()).length, 10);
  await store.close();
});

test("an advanced audit timestamp republishes and drains the review queue", async () => {
  const store = openTemporaryStore("reconciled");
  await store.importSeed();
  await demoteEveryRestaurant(store);
  assert.equal((await store.getReviewQueue()).length, 10);

  await store.importSeed(seedAuditedAt("2026-09-15T00:00:00Z"));

  const catalog = await store.getCatalog();
  assert.ok(catalog.restaurants.every((restaurant) => restaurant.coverageStatus === "Complete"));
  assert.ok(catalog.restaurants.every((restaurant) => restaurant.auditedAt.startsWith("2026-09-15")));
  assert.equal((await store.getReviewQueue()).length, 0, "reconciliation must drain the queue");
  await store.close();
});

test("a seed may demote a restaurant at any time", async () => {
  const store = openTemporaryStore("demote");
  await store.importSeed();
  assert.equal((await store.getReviewQueue()).length, 0);

  await store.importSeed(seedAuditedAt("2026-09-15T00:00:00Z", { coverageStatus: "Needs review" }));

  const catalog = await store.getCatalog();
  assert.ok(catalog.restaurants.every((restaurant) => restaurant.coverageStatus === "Needs review"));
  assert.equal((await store.getReviewQueue()).length, 10, "a demotion must reach the queue");
  await store.close();
});

test("a fresh audit clears a recorded check failure", async () => {
  const store = openTemporaryStore("check-error");
  await store.importSeed();
  const logger = { log() {}, error() {} };
  await checkMenus(store, {
    fetchImpl: async () => { throw new Error("source unreachable"); },
    logger
  });
  assert.equal((await store.getReviewQueue()).length, 10);

  await store.importSeed(seedAuditedAt("2026-09-15T00:00:00Z"));

  assert.equal((await store.getReviewQueue()).length, 0);
  const remaining = store.database
    .prepare("SELECT COUNT(*) AS count FROM restaurants WHERE check_error IS NOT NULL").get();
  assert.equal(remaining.count, 0);
  await store.close();
});
