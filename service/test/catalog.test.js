import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkMenus } from "../src/checker.js";
import { catalogFromDatabase, importSeed, openDatabase } from "../src/database.js";

test("seed publishes every stored menu item and modification note", () => {
  const directory = mkdtempSync(join(tmpdir(), "vegfinder-test-"));
  const database = openDatabase(join(directory, "catalog.sqlite"));
  importSeed(database);

  const catalog = catalogFromDatabase(database);
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
  database.close();
});

test("menu checker flags a changed official source for review", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vegfinder-check-test-"));
  const database = openDatabase(join(directory, "catalog.sqlite"));
  importSeed(database);
  database.prepare("UPDATE restaurants SET extraction_mode = 'browser_required' WHERE name = 'Jelly Cafe'").run();
  const logger = { log() {}, error() {} };
  let browserChecks = 0;
  const browserFetchImpl = async () => {
    browserChecks += 1;
    return "<main>Browser menu version</main>";
  };

  await checkMenus(database, {
    fetchImpl: async () => new Response("<main>Menu version one</main>"),
    browserFetchImpl,
    logger
  });
  await checkMenus(database, {
    fetchImpl: async () => new Response("<main>Menu version two</main>"),
    browserFetchImpl: async () => {
      browserChecks += 1;
      return "<main>Changed browser menu version</main>";
    },
    logger
  });

  const row = database.prepare(`
    SELECT COUNT(*) AS count FROM restaurants WHERE review_required = 1
  `).get();
  assert.equal(row.count, 10);
  assert.equal(browserChecks, 2);
  const catalog = catalogFromDatabase(database);
  assert.ok(catalog.restaurants.every((restaurant) => restaurant.coverageStatus === "Needs review"));
  database.close();
});
