import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatSummary, importCandidates, readCandidates, reportOf, zeroTouchRatio
} from "../src/candidate-import.js";
import { stableRestaurantID } from "../src/catalog-input.js";
import { openSQLiteStore } from "../src/database.js";
import { autoPublishTiers } from "../src/proposals.js";

const QUIET = { log() {}, error() {} };

const LABELLED = `<html><body>
  <p>VG = Vegan, V = Vegetarian</p>
  <li>Roasted Cauliflower (VG)</li><li>$11</li>
</body></html>`;
const WHOLLY_VEGAN = "<p>We are a 100% vegan restaurant</p><li>Chana Bowl</li><li>$12</li>";
const UNLABELLED = "<li>Garden Salad</li><li>$9</li><li>Veggie Burger</li><li>$14</li>";

const candidate = (overrides = {}) => ({
  name: "Corner Bistro",
  neighborhood: "Capitol Hill",
  address: "100 E Colfax Ave",
  latitude: 39.7402,
  longitude: -104.9847,
  menuURL: "https://example.com/menu",
  ...overrides
});

const freshStore = (label) =>
  openSQLiteStore(join(mkdtempSync(join(tmpdir(), `vf-${label}-`)), "c.sqlite"));

const serve = (html) => async () => new Response(html);

test("candidates arrive without ids and get one derived from the real restaurant", () => {
  const { candidates, invalid } = readCandidates({ restaurants: [candidate()] });

  assert.equal(invalid.length, 0);
  assert.equal(candidates[0].id, stableRestaurantID("Corner Bistro", "100 E Colfax Ave"));
  assert.equal(
    candidates[0].id,
    stableRestaurantID("  corner bistro ", "100 E  Colfax   Ave"),
    "spacing and case must not mint a second identity for one restaurant"
  );
  assert.notEqual(
    candidates[0].id,
    stableRestaurantID("Corner Bistro", "200 E Colfax Ave"),
    "a chain repeats its name, so the address has to count"
  );
});

test("a malformed entry is reported and the rest of the file still imports", async () => {
  // An import of hundreds must not be lost because one entry is missing a
  // longitude, and whoever fixes it has to be told which one.
  const { candidates, invalid } = readCandidates({
    restaurants: [
      candidate(),
      candidate({ name: "No Coordinates", longitude: undefined }),
      candidate({ name: "Second Good", address: "200 E Colfax Ave" })
    ]
  });

  assert.equal(candidates.length, 2);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].name, "No Coordinates");
  assert.equal(invalid[0].index, 1, "the reader names the entry to fix");
  assert.match(invalid[0].errors.join(" "), /longitude/);
});

test("a file that is not a list of restaurants fails before anything is written", () => {
  assert.match(readCandidates({ places: [] }).fatal, /array/);
  assert.match(readCandidates("nonsense").fatal, /array/);
  assert.equal(readCandidates([candidate()]).candidates.length, 1, "a bare array is accepted too");
});

test("an imported restaurant is unaudited, unpublished, and in the review queue", async () => {
  const store = freshStore("import");
  const { candidates } = readCandidates([candidate()]);

  await importCandidates(store, candidates, {
    extract: false, delayMs: 0, logger: QUIET
  });

  const restaurant = await store.getRestaurant(candidates[0].id);
  assert.equal(restaurant.name, "Corner Bistro");
  assert.equal(restaurant.coverageStatus, "Needs review");
  assert.deepEqual(restaurant.menuItems, [], "a bulk import must not publish a menu it never read");
  assert.equal((await store.getReviewQueue()).length, 1);
  await store.close();
});

test("re-running an import leaves an audited restaurant untouched", async () => {
  // The guarantee that makes a bulk import safe to repeat: a discovery pass rerun
  // next month must not overwrite menus somebody has since audited.
  const store = freshStore("rerun");
  const { candidates } = readCandidates([candidate()]);
  await importCandidates(store, candidates, { extract: false, delayMs: 0, logger: QUIET });

  await store.reconcileRestaurant(candidates[0].id, {
    coverageStatus: "Complete",
    menuItems: [{
      id: "cccccccc-0000-4000-8000-000000000001", name: "Chana Bowl", description: "",
      price: "$12", dietaryStatus: "Vegan", modificationNote: null,
      sourceEvidence: "Menu marks this VG"
    }]
  });

  const second = await importCandidates(store, candidates, {
    extract: true, delayMs: 0, logger: QUIET,
    fetchImpl: async () => { throw new Error("must not refetch an existing restaurant"); }
  });

  assert.equal(second.created.length, 0);
  assert.equal(second.existing.length, 1);
  const restaurant = await store.getRestaurant(candidates[0].id);
  assert.equal(restaurant.coverageStatus, "Complete", "the audit survives a re-import");
  assert.deepEqual(restaurant.menuItems.map((item) => item.name), ["Chana Bowl"]);
  await store.close();
});

test("a discovered restaurant already entered by hand is recognised, not duplicated", async () => {
  // The failure this catches is the expensive one. Restaurants entered by hand
  // carry hand-assigned ids, so a discovery pass over a city already covered
  // matches none of them by id and would import a second, unaudited copy of
  // every restaurant somebody had verified.
  const store = freshStore("dedupe");
  await store.upsertRestaurant({
    id: "00000000-0000-4000-8000-000000000004",
    name: "City, O' City", neighborhood: "Capitol Hill", address: "206 E 13th Ave",
    latitude: 39.7373, longitude: -104.9817, menuURL: "https://example.com/menu",
    checkURL: null, claimURL: null, extractionMode: "change_detection",
    menuProfile: "unknown", verificationMethod: "official_url",
    coverageScope: "Qualifying items found on the official menu"
  });

  const { candidates } = readCandidates([
    // Same restaurant, a different source's spelling and its own coordinate.
    candidate({ name: "City O' City", address: "206 E 13th Ave, Denver",
      latitude: 39.7374, longitude: -104.9818 }),
    // A genuinely different restaurant at the same address.
    candidate({ name: "Somewhere Else", address: "206 E 13th Ave, Denver",
      latitude: 39.7373, longitude: -104.9817 }),
    // Same name, other side of the city: a second location, not a duplicate.
    candidate({ name: "City O' City", address: "1 Far Away Rd",
      latitude: 39.7900, longitude: -105.0400 })
  ]);

  const summary = await importCandidates(store, candidates, {
    extract: false, delayMs: 0, logger: QUIET
  });

  assert.deepEqual(summary.existing.map((entry) => entry.matchedBy), ["name and location"]);
  assert.equal(
    summary.existing[0].id, "00000000-0000-4000-8000-000000000004",
    "it reports the id the catalog already knows, not the derived one"
  );
  assert.deepEqual(
    summary.created.map((entry) => entry.name), ["Somewhere Else", "City O' City"],
    "a different name here, and the same name elsewhere, are both new restaurants"
  );
  await store.close();
});

test("a dry run reports what it would do and writes nothing", async () => {
  const store = freshStore("dry");
  const { candidates } = readCandidates([candidate()]);

  const summary = await importCandidates(store, candidates, {
    dryRun: true, delayMs: 0, logger: QUIET,
    fetchImpl: async () => { throw new Error("a dry run must not fetch"); }
  });

  assert.equal(summary.created.length, 1);
  assert.equal(await store.getRestaurant(candidates[0].id), null, "nothing was written");
  await store.close();
});

test("extraction sorts an import into published, drafted, and hand work", async () => {
  // The whole point of the import: a restaurant that states its own whole menu is
  // vegan becomes coverage at no human cost, a labelled menu becomes review
  // material, and an unlabelled one becomes an honest admission of hand work.
  const store = freshStore("sorted");
  const { candidates } = readCandidates([
    candidate({ name: "Wholly Vegan", address: "1 A St", menuProfile: "fully_vegan",
      menuURL: "https://example.com/vegan" }),
    candidate({ name: "Labelled Menu", address: "2 B St", menuURL: "https://example.com/labelled" }),
    candidate({ name: "No Legend", address: "3 C St", menuURL: "https://example.com/plain" })
  ]);

  const pages = {
    "https://example.com/vegan": WHOLLY_VEGAN,
    "https://example.com/labelled": LABELLED,
    "https://example.com/plain": UNLABELLED
  };
  const summary = await importCandidates(store, candidates, {
    delayMs: 0, logger: QUIET, tiers: autoPublishTiers(undefined),
    fetchImpl: async (url) => new Response(pages[url])
  });

  assert.deepEqual(summary.published.map((entry) => entry.name), ["Wholly Vegan"]);
  assert.deepEqual(summary.drafted.map((entry) => entry.name), ["Labelled Menu"]);
  assert.deepEqual(summary.unreadable.map((entry) => entry.name), ["No Legend"]);

  const published = await store.getRestaurant(candidates[0].id);
  assert.equal(published.coverageStatus, "Complete");
  assert.deepEqual(published.menuItems.map((item) => item.name), ["Chana Bowl"]);

  const drafted = await store.getRestaurant(candidates[1].id);
  assert.deepEqual(drafted.menuItems, [], "a labelled menu waits for a person");
  assert.equal((await store.listProposals({ restaurantID: candidates[1].id })).length, 1);

  const ratio = zeroTouchRatio(summary);
  assert.deepEqual(
    { published: ratio.published, examined: ratio.examined }, { published: 1, examined: 3 }
  );
  assert.match(formatSummary(summary), /Zero-touch coverage: 33% \(1 of 3\)/);
  await store.close();
});

test("a batch is measured in items, because that is what a reviewer spends", async () => {
  // Restaurant counts read a batch too harshly. Forty awaiting review is a good
  // result at a click each and a bad one at ten decisions each, and the
  // restaurant count is identical either way.
  const report = reportOf({
    created: new Array(9).fill({}), existing: [],
    published: [{ name: "A", tier: "fully_vegan", items: 20 },
                { name: "B", tier: "fully_vegan", items: 12 }],
    drafted: [{ name: "C", tier: "labelled_menu", items: 2 },
              { name: "D", tier: "labelled_menu", items: 4 },
              { name: "E", tier: "labelled_menu", items: 32 }],
    unreadable: [{ name: "F" }, { name: "G" }],
    failed: [{ name: "H", reason: "ENOTFOUND" }]
  });

  assert.deepEqual(report.autoPublished, { restaurants: 2, items: 32 });
  assert.deepEqual(report.awaitingReview, {
    restaurants: 3, items: 38, medianItems: 4, maxItems: 32
  });
  assert.deepEqual(report.manual, { restaurants: 3, unreadable: 2, failed: 1 });
  assert.equal(report.examined, 8);
  assert.equal(report.zeroTouchRatio, 0.25);
  // The distinction the median and maximum exist to expose: a typical review here
  // is four items, but one restaurant costs thirty-two. A long tail like that is
  // what quietly makes a queue unworkable, and an average would have hidden it.
  assert.ok(report.awaitingReview.maxItems > report.awaitingReview.medianItems * 4);
});

test("a menu that cannot be fetched still leaves the restaurant onboarded", async () => {
  // A dead menu URL is a review task, not a reason to lose the record.
  const store = freshStore("unreachable");
  const { candidates } = readCandidates([candidate()]);

  const summary = await importCandidates(store, candidates, {
    delayMs: 0, logger: QUIET,
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); }
  });

  assert.equal(summary.created.length, 1);
  assert.equal(summary.failed.length, 1);
  assert.match(summary.failed[0].reason, /ENOTFOUND/);
  assert.ok(await store.getRestaurant(candidates[0].id), "the restaurant survives its bad URL");
  assert.equal((await store.getReviewQueue()).length, 1);
  await store.close();
});

test("importing without a model client never reaches the model tier", async () => {
  // A bulk import runs over every entry in the file. Acquiring a client
  // implicitly would spend real money the first time somebody tried a big list.
  const store = freshStore("nomodel");
  const { candidates } = readCandidates([candidate()]);

  const summary = await importCandidates(store, candidates, {
    delayMs: 0, logger: QUIET, fetchImpl: serve(UNLABELLED)
  });

  assert.equal(summary.unreadable.length, 1);
  assert.equal(summary.drafted.length, 0);
  assert.equal((await store.listProposals({})).length, 0);
  await store.close();
});
