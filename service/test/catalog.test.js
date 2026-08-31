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

test("a PDF menu is fingerprinted whole rather than HTML-stripped", async () => {
  const store = openTemporaryStore("pdf-source");
  await store.importSeed();
  const logger = { log() {}, error() {} };

  // Two PDFs differing only in a price. Tag-stripping a PDF deletes nearly all
  // of it, so a normalized fingerprint would miss the change entirely.
  const pdf = (price) =>
    new Response(`%PDF-1.4\n<</Type/Catalog>>\nstream\nAvocado Toast ${price}\nendstream`, {
      headers: { "content-type": "application/pdf" }
    });

  await checkMenus(store, { fetchImpl: async () => pdf("$12"), logger });
  const first = store.database.prepare("SELECT source_hash FROM restaurants LIMIT 1").get().source_hash;

  await checkMenus(store, { fetchImpl: async () => pdf("$14"), logger });
  const second = store.database.prepare("SELECT source_hash FROM restaurants LIMIT 1").get().source_hash;

  assert.notEqual(second, first, "a changed PDF menu must change the fingerprint");
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM restaurants WHERE review_required = 1").get().count,
    10,
    "and must send the restaurant back for review"
  );

  const snapshot = store.database.prepare(
    "SELECT normalized_source FROM menu_source_snapshots LIMIT 1"
  ).get().normalized_source;
  assert.match(snapshot, /application\/pdf.*fingerprinted whole/, "binary sources record what they were");
  await store.close();
});

test("an HTML menu is still normalized before fingerprinting", async () => {
  const store = openTemporaryStore("html-source");
  await store.importSeed();
  const logger = { log() {}, error() {} };

  // Same visible menu, different markup — normalizing must treat these as equal.
  await checkMenus(store, {
    fetchImpl: async () => new Response("<div><p>Avocado Toast $12</p></div>",
      { headers: { "content-type": "text/html" } }),
    logger
  });
  await checkMenus(store, {
    fetchImpl: async () => new Response("<section><span>Avocado  Toast  $12</span></section>",
      { headers: { "content-type": "text/html; charset=utf-8" } }),
    logger
  });

  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM restaurants WHERE review_required = 1").get().count,
    0,
    "a markup-only change must not be reported as a menu change"
  );
  await store.close();
});

test("the seed carries verification method and menu profile", async () => {
  // These are how a restaurant is routed: menu_profile decides which extraction
  // tier may touch it, verification_method decides how it is re-checked. The
  // seed importer used to drop both, so they existed only in whichever database
  // an operator had edited by hand and a fresh deploy silently lost them.
  const store = openTemporaryStore("seed-routing");
  await store.importSeed();

  const hudson = store.database
    .prepare("SELECT verification_method, check_url FROM restaurants WHERE name = 'Hudson Hill'")
    .get();
  assert.equal(hudson.verification_method, "menu_document");
  assert.ok(hudson.check_url, "a document menu keeps its URL so it can still be fingerprinted");

  // Everything the seed does not mark falls back to the same defaults it always had.
  const others = store.database.prepare(`
    SELECT COUNT(*) AS count FROM restaurants
    WHERE name <> 'Hudson Hill' AND verification_method <> 'official_url'
  `).get();
  assert.equal(others.count, 0);
  assert.equal(
    store.database.prepare("SELECT COUNT(*) AS count FROM restaurants WHERE menu_profile <> 'unknown'").get().count,
    0
  );
  await store.close();
});

test("the seed records where a whole-menu claim is published", async () => {
  const store = openTemporaryStore("seed-claim");
  await store.importSeed();
  const cakeBar = store.database
    .prepare("SELECT claim_url FROM restaurants WHERE name = 'The Cake Bar'").get();
  assert.equal(cakeBar.claim_url, "https://www.thecakebardenver.com/");
  await store.close();
});
