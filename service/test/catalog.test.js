import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkMenus } from "../src/checker.js";
import { openSQLiteStore } from "../src/database.js";

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
