import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateRestaurant } from "../src/catalog-input.js";
import { checkMenus } from "../src/checker.js";
import { openSQLiteStore } from "../src/database.js";
import { summarizeCheck } from "../src/notifier.js";
import { DatabaseSync } from "node:sqlite";

const quiet = { log() {}, error() {} };

function freshStore(label) {
  return openSQLiteStore(join(mkdtempSync(join(tmpdir(), `vf-${label}-`)), "c.sqlite"));
}

function paperMenuRestaurant(overrides = {}) {
  return {
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    name: "Corner Taqueria",
    neighborhood: "Capitol Hill",
    address: "5 Main St",
    latitude: 39.74,
    longitude: -104.98,
    verificationMethod: "in_person",
    ...overrides
  };
}

test("a restaurant with no online menu can be entered", () => {
  const result = validateRestaurant(paperMenuRestaurant());
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.equal(result.value.menuURL, null);
  assert.equal(result.value.verificationMethod, "in_person");
});

test("claiming an official URL still requires one", () => {
  const result = validateRestaurant(paperMenuRestaurant({ verificationMethod: "official_url" }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /menuURL is required unless verificationMethod/);
});

test("an unknown verification method is rejected", () => {
  const result = validateRestaurant(paperMenuRestaurant({ verificationMethod: "someone_told_me" }));
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /verificationMethod must be one of/);
});

test("an offline restaurant is stored and served without a menu URL", async () => {
  const store = freshStore("offline-store");
  const input = validateRestaurant(paperMenuRestaurant());
  await store.upsertRestaurant(input.value);

  const restaurant = await store.getRestaurant(input.value.id);
  assert.equal(restaurant.menuURL, null);
  assert.equal(restaurant.verificationMethod, "in_person");
  await store.close();
});

test("a recently verified offline record is left alone", async () => {
  const store = freshStore("offline-fresh");
  await store.upsertRestaurant(validateRestaurant(paperMenuRestaurant()).value);
  await store.reconcileRestaurant(paperMenuRestaurant().id, {
    coverageStatus: "Complete",
    menuItems: [{
      id: "cccccccc-0000-4000-8000-000000000001", name: "Nopales Taco", description: "Grilled cactus",
      price: "$4", dietaryStatus: "Vegan", modificationNote: null,
      sourceEvidence: "Confirmed in person 2026-08-31: corn tortilla, no lard"
    }]
  });

  let fetched = 0;
  const results = await checkMenus(store, {
    fetchImpl: async () => { fetched += 1; return new Response("<main>x</main>"); },
    logger: quiet
  });

  assert.equal(fetched, 0, "an offline record has nothing to fetch");
  assert.equal(results[0].status, "ok");
  assert.equal((await store.getReviewQueue()).length, 0);
  await store.close();
});

test("an offline record past its review window is re-queued", async () => {
  const store = freshStore("offline-stale");
  await store.upsertRestaurant(validateRestaurant(paperMenuRestaurant()).value);
  await store.reconcileRestaurant(paperMenuRestaurant().id, {
    coverageStatus: "Complete",
    menuItems: [{
      id: "cccccccc-0000-4000-8000-000000000001", name: "Nopales Taco", description: "Grilled cactus",
      price: "$4", dietaryStatus: "Vegan", modificationNote: null,
      sourceEvidence: "Confirmed in person: corn tortilla, no lard"
    }]
  });
  assert.equal((await store.getReviewQueue()).length, 0);

  // Same record, judged a year later.
  const results = await checkMenus(store, {
    logger: quiet,
    now: () => new Date(Date.now() + 365 * 86_400_000)
  });

  assert.equal(results[0].status, "review_due");
  assert.match(results[0].error, /in person 365 days ago/);
  assert.equal((await store.getReviewQueue()).length, 1, "a stale human record must come back for review");
  assert.equal((await store.getRestaurant(paperMenuRestaurant().id)).coverageStatus, "Needs review");
  await store.close();
});

test("re-verifying an offline record clears it again", async () => {
  const store = freshStore("offline-recheck");
  const id = paperMenuRestaurant().id;
  await store.upsertRestaurant(validateRestaurant(paperMenuRestaurant()).value);
  const menuItems = [{
    id: "cccccccc-0000-4000-8000-000000000001", name: "Nopales Taco", description: "Grilled cactus",
    price: "$4", dietaryStatus: "Vegan", modificationNote: null,
    sourceEvidence: "Confirmed in person: corn tortilla, no lard"
  }];
  await store.reconcileRestaurant(id, { coverageStatus: "Complete", menuItems });

  await checkMenus(store, { logger: quiet, now: () => new Date(Date.now() + 365 * 86_400_000) });
  assert.equal((await store.getReviewQueue()).length, 1);

  await store.reconcileRestaurant(id, { coverageStatus: "Complete", menuItems });
  assert.equal((await store.getReviewQueue()).length, 0, "a fresh visit must clear the review");
  await store.close();
});

test("a never-audited offline record is queued immediately", async () => {
  const store = freshStore("offline-never");
  await store.upsertRestaurant(validateRestaurant(paperMenuRestaurant()).value);

  const results = await checkMenus(store, { logger: quiet });
  assert.equal(results[0].status, "review_due");
  assert.match(results[0].error, /never audited/);
  await store.close();
});

test("re-verification due is reported in the alert, not silently queued", () => {
  const summary = summarizeCheck(
    [{ id: "a", name: "Corner Taqueria", status: "review_due", error: "Verified in person 365 days ago" }],
    [{ id: "a", name: "Corner Taqueria" }]
  );
  assert.equal(summary.shouldNotify, true);
  assert.match(summary.text, /Re-verification due \(1\)/);
  assert.match(summary.text, /Corner Taqueria — Verified in person 365 days ago/);
  assert.deepEqual(summary.detail.reviewDue, ["Corner Taqueria"]);
});

test("a developer database from before these columns existed still opens", async () => {
  // Regression: index creation once ran inside the CREATE TABLE block, so an
  // index on a column added later failed the open for every existing database.
  const path = join(mkdtempSync(join(tmpdir(), "vf-legacy-")), "c.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE restaurants (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, neighborhood TEXT NOT NULL, address TEXT NOT NULL,
    latitude REAL NOT NULL, longitude REAL NOT NULL, menu_url TEXT NOT NULL, check_url TEXT,
    extraction_mode TEXT NOT NULL DEFAULT (char(99)), verified_at TEXT NOT NULL,
    coverage_status TEXT NOT NULL DEFAULT (char(99)), coverage_scope TEXT NOT NULL DEFAULT (char(99)),
    audited_at TEXT, last_checked_at TEXT, source_hash TEXT,
    review_required INTEGER NOT NULL DEFAULT 0, check_error TEXT)`);
  legacy.prepare(`INSERT INTO restaurants
      (id, name, neighborhood, address, latitude, longitude, menu_url, extraction_mode,
       verified_at, coverage_status, coverage_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("11111111-1111-4111-8111-111111111111", "Legacy Dev Row", "Capitol Hill", "1 Main",
         39.73, -104.98, "https://example.com", "change_detection",
         "2026-01-01T00:00:00Z", "Complete", "scope");
  legacy.close();

  const store = openSQLiteStore(path);
  const carried = await store.getRestaurant("11111111-1111-4111-8111-111111111111");
  assert.equal(carried.name, "Legacy Dev Row", "existing rows must survive the rebuild");
  assert.equal(carried.verificationMethod, "official_url");

  await store.upsertRestaurant(validateRestaurant(paperMenuRestaurant()).value);
  assert.equal(
    (await store.getRestaurant(paperMenuRestaurant().id)).menuURL, null,
    "the rebuilt table must accept a restaurant with no menu URL"
  );
  await store.close();
});

// A PDF or image menu is the one source that gets both checks. Its bytes
// fingerprint, so an edit is caught like any other menu; but nothing can read
// its dishes, so the items were transcribed by a person and that transcription
// needs re-checking on a clock like any other human observation.
function documentMenuRestaurant(overrides = {}) {
  return {
    id: "bbbbbbbb-0000-4000-8000-000000000002",
    name: "Hudson Hill",
    neighborhood: "Capitol Hill",
    address: "619 E 13th Ave",
    latitude: 39.73673,
    longitude: -104.9793,
    menuURL: "https://example.com/order",
    checkURL: "https://example.com/menu.pdf",
    verificationMethod: "menu_document",
    ...overrides
  };
}

const pdf = (price) => async () => new Response(
  `%PDF-1.4 stream Chickpea Salad ${price} endstream`,
  { headers: { "content-type": "application/pdf" } }
);

async function storeWith(label, input) {
  const store = freshStore(label);
  const validated = validateRestaurant(input);
  assert.equal(validated.valid, true, validated.errors.join("; "));
  await store.upsertRestaurant(validated.value);
  return store;
}

test("a document menu is still fingerprinted, so an edit to it is caught", async () => {
  const store = await storeWith("doc-fingerprint", documentMenuRestaurant());
  const id = "bbbbbbbb-0000-4000-8000-000000000002";
  // Audited today, so the age clock cannot be what raises a review here.
  store.database.prepare("UPDATE restaurants SET audited_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);

  await checkMenus(store, { fetchImpl: pdf("14"), logger: quiet });
  const [unchanged] = await checkMenus(store, { fetchImpl: pdf("14"), logger: quiet });
  assert.equal(unchanged.status, "ok", "an unedited document with a fresh audit is fine");

  const [changed] = await checkMenus(store, { fetchImpl: pdf("16"), logger: quiet });
  assert.equal(changed.status, "changed", "a repriced PDF must still be noticed");
  await store.close();
});

test("a document menu is re-queued when its transcription goes stale", async () => {
  const store = await storeWith("doc-clock", documentMenuRestaurant());
  const id = "bbbbbbbb-0000-4000-8000-000000000002";
  await checkMenus(store, { fetchImpl: pdf("14"), logger: quiet });

  // Same bytes, so no fingerprint change — but the person who read this menu
  // did so 200 days ago, and no fingerprint can tell you a dish was already
  // wrong when it was transcribed.
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  store.database.prepare("UPDATE restaurants SET audited_at = ? WHERE id = ?").run(old, id);

  const [result] = await checkMenus(store, {
    fetchImpl: pdf("14"), logger: quiet, offlineReviewDays: 90
  });
  assert.equal(result.status, "review_due");
  assert.match(result.error, /transcribing a document menu/);
  assert.match(result.error, /re-verification due after 90 days/);
  assert.equal((await store.getReviewQueue()).length, 1);
  await store.close();
});

test("an ordinary web menu never picks up the transcription clock", async () => {
  // Only menu_document carries both checks. A fetchable HTML menu is re-read on
  // every cycle, so ageing it as well would re-queue a restaurant that nothing
  // is actually wrong with.
  const store = await storeWith("html-no-clock", documentMenuRestaurant({
    checkURL: "https://example.com/menu", verificationMethod: "official_url"
  }));
  const id = "bbbbbbbb-0000-4000-8000-000000000002";
  const html = async () => new Response("<main>Chickpea Salad 14</main>");
  await checkMenus(store, { fetchImpl: html, logger: quiet });

  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  store.database.prepare("UPDATE restaurants SET audited_at = ? WHERE id = ?").run(old, id);

  const [result] = await checkMenus(store, { fetchImpl: html, logger: quiet, offlineReviewDays: 90 });
  assert.equal(result.status, "ok");
  await store.close();
});
