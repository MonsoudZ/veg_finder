import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateRestaurant } from "../src/catalog-input.js";
import { checkMenus } from "../src/checker.js";
import { openSQLiteStore } from "../src/database.js";
import { proposeChangesForResults, proposeMenuChanges } from "../src/menu-changes.js";
import { autoPublishTiers, proposeMenu, stableItemID } from "../src/proposals.js";

const ID = "bbbbbbbb-0000-4000-8000-000000000001";
const QUIET = { log() {}, error() {} };

// The pilot's shape: a menu that publishes its own dietary legend, so extraction
// is restating the restaurant's claim rather than inferring one.
const MENU_V1 = `<html><body>
  <p>VG = Vegan, V = Vegetarian</p>
  <li>Roasted Cauliflower (VG)</li><li>$11</li>
  <li>Veggie Hash (V)</li><li>$13</li>
  <li>Old Seasonal Bowl (VG)</li><li>$12</li>
</body></html>`;

// One dish added, one repriced, one gone, one untouched.
const MENU_V2 = `<html><body>
  <p>VG = Vegan, V = Vegetarian</p>
  <li>Roasted Cauliflower (VG)</li><li>$11</li>
  <li>Veggie Hash (V)</li><li>$15</li>
  <li>Vegan Breakfast Burrito (VG)</li><li>$14.00</li>
</body></html>`;

const serve = (html) => async () => new Response(html);

// Check cycles are stamped with an explicit clock rather than wall-clock time.
// Consecutive cycles in a test otherwise land in the same millisecond, which
// leaves anything ordered by check time decided by a tiebreak.
const at = (iso) => ({ now: () => new Date(iso) });

async function storeWithPublishedMenu(label, html = MENU_V1, when = "2026-08-01T00:00:00Z") {
  const store = openSQLiteStore(join(mkdtempSync(join(tmpdir(), `vf-${label}-`)), "c.sqlite"));
  await store.upsertRestaurant(validateRestaurant({
    id: ID, name: "Jelly", neighborhood: "Capitol Hill", address: "600 E 13th Ave",
    latitude: 39.7371, longitude: -104.9784, menuURL: "https://example.com/menu"
  }).value);

  // Fingerprint the menu first, so the restaurant has a hash to compare against,
  // then publish it. Together these are the "last time a person agreed" state
  // every later diff is measured from.
  await checkMenus(store, { fetchImpl: serve(html), logger: QUIET, ...at(when) });
  await proposeMenu(store, await store.getCheckTarget(ID), {
    fetchImpl: serve(html), tiers: autoPublishTiers("labelled_menu")
  });
  return store;
}

function versionsFor(store, name) {
  return store.database.prepare(`
    SELECT change_kind, item_snapshot FROM menu_item_versions
    WHERE menu_item_id = ? ORDER BY recorded_at, rowid
  `).all(stableItemID(ID, name)).map((row) => ({
    kind: row.change_kind, item: JSON.parse(row.item_snapshot)
  }));
}

test("a changed fixture menu becomes a reviewable proposal, and only a person publishes it", async () => {
  const store = await storeWithPublishedMenu("e2e");
  const published = await store.getRestaurant(ID);
  assert.deepEqual(
    published.menuItems.map((entry) => entry.name),
    ["Roasted Cauliflower", "Veggie Hash", "Old Seasonal Bowl"],
    "baseline: three dishes published from the restaurant's own labelling"
  );

  // 1. The checker detects that the source moved.
  const results = await checkMenus(store, { fetchImpl: serve(MENU_V2), logger: QUIET });
  assert.equal(results[0].status, "changed");
  assert.equal(
    (await store.getReviewQueue()).length, 1, "a changed source demotes the restaurant"
  );
  assert.deepEqual(
    (await store.getRestaurant(ID)).menuItems.map((entry) => entry.name),
    ["Roasted Cauliflower", "Veggie Hash", "Old Seasonal Bowl"],
    "detection alone must not change one published dish"
  );

  // 2. The proposal system interprets what changed.
  const [outcome] = await proposeChangesForResults(store, results, {
    fetchImpl: serve(MENU_V2), logger: QUIET
  });
  assert.ok(outcome.proposalID, "a detected change produces a proposal");

  const proposal = await store.getChangeProposal(outcome.proposalID);
  assert.equal(proposal.status, "pending");
  assert.equal(proposal.restaurantName, "Jelly");
  assert.equal(proposal.tier, "labelled_menu");

  const byKind = Object.fromEntries(
    proposal.operations.map((operation) => [operation.operation, operation])
  );
  assert.deepEqual(
    proposal.operations.map((operation) => operation.operation).sort(),
    ["add", "retire", "update"],
    "one dish added, one repriced, one gone — and the untouched one proposes nothing"
  );
  assert.equal(byKind.add.proposed.name, "Vegan Breakfast Burrito");
  assert.equal(byKind.add.proposed.price, "$14.00");
  assert.match(byKind.add.evidence, /Vegan Breakfast Burrito \(VG\)/);
  assert.equal(byKind.update.current.price, "$13");
  assert.equal(byKind.update.proposed.price, "$15");
  assert.deepEqual(byKind.update.changedFields, ["price"]);
  assert.equal(byKind.retire.current.name, "Old Seasonal Bowl");

  // 3. The reviewer can see both readings, not just the conclusion drawn from them.
  assert.match(proposal.oldSource.source, /Old Seasonal Bowl/);
  assert.match(proposal.newSource.source, /Vegan Breakfast Burrito/);
  assert.notEqual(proposal.oldSource.hash, proposal.newSource.hash);

  assert.deepEqual(
    (await store.getRestaurant(ID)).menuItems.map((entry) => entry.name),
    ["Roasted Cauliflower", "Veggie Hash", "Old Seasonal Bowl"],
    "recording a proposal must not publish it"
  );

  // 4. A person publishes.
  const accepted = await store.acceptChangeProposal(outcome.proposalID, {
    reviewedBy: "operator@example.com"
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.applied, 3);

  const after = await store.getRestaurant(ID);
  assert.deepEqual(
    after.menuItems.map((entry) => entry.name),
    ["Roasted Cauliflower", "Veggie Hash", "Vegan Breakfast Burrito"],
    "the retired dish is gone and the new one is live"
  );
  assert.equal(
    after.menuItems.find((entry) => entry.name === "Veggie Hash").price, "$15"
  );
  assert.equal(after.coverageStatus, "Complete");
  assert.equal(
    (await store.getReviewQueue()).length, 0, "accepting a reviewed diff is an audit"
  );

  // 5. The history says exactly what happened, dish by dish.
  assert.deepEqual(versionsFor(store, "Roasted Cauliflower").map((entry) => entry.kind),
    ["published"], "an untouched dish gains no version");
  assert.deepEqual(versionsFor(store, "Veggie Hash").map((entry) => entry.kind),
    ["published", "updated"]);
  assert.deepEqual(versionsFor(store, "Old Seasonal Bowl").map((entry) => entry.kind),
    ["published", "retired"]);
  assert.deepEqual(versionsFor(store, "Vegan Breakfast Burrito").map((entry) => entry.kind),
    ["published"]);

  const reviewed = await store.getChangeProposal(outcome.proposalID);
  assert.equal(reviewed.status, "accepted");
  assert.equal(reviewed.reviewedBy, "operator@example.com");
  assert.ok(reviewed.operations.every((operation) => operation.decision === "applied"));
  await store.close();
});

test("a reviewer can accept part of a diff and leave the rest unpublished", async () => {
  const store = await storeWithPublishedMenu("partial");
  const results = await checkMenus(store, { fetchImpl: serve(MENU_V2), logger: QUIET });
  const [outcome] = await proposeChangesForResults(store, results, {
    fetchImpl: serve(MENU_V2), logger: QUIET
  });

  const proposal = await store.getChangeProposal(outcome.proposalID);
  const addition = proposal.operations.find((operation) => operation.operation === "add");
  const accepted = await store.acceptChangeProposal(outcome.proposalID, {
    reviewedBy: "operator", operationIDs: [addition.id]
  });

  assert.equal(accepted.applied, 1);
  assert.equal(accepted.skipped, 2);
  assert.deepEqual(
    (await store.getRestaurant(ID)).menuItems.map((entry) => entry.name),
    ["Roasted Cauliflower", "Veggie Hash", "Old Seasonal Bowl", "Vegan Breakfast Burrito"],
    "only the accepted operation published; the rest of the menu stands"
  );

  const reviewed = await store.getChangeProposal(outcome.proposalID);
  const decisions = Object.fromEntries(
    reviewed.operations.map((operation) => [operation.operation, operation.decision])
  );
  assert.deepEqual(decisions, { add: "applied", update: "skipped", retire: "skipped" },
    "a skipped operation is a decision worth recording, not an absence");
  await store.close();
});

test("a proposal cannot be accepted twice", async () => {
  const store = await storeWithPublishedMenu("twice");
  const results = await checkMenus(store, { fetchImpl: serve(MENU_V2), logger: QUIET });
  const [outcome] = await proposeChangesForResults(store, results, {
    fetchImpl: serve(MENU_V2), logger: QUIET
  });

  assert.equal(
    (await store.acceptChangeProposal(outcome.proposalID, { reviewedBy: "first" })).status,
    "accepted"
  );
  assert.equal(
    (await store.acceptChangeProposal(outcome.proposalID, { reviewedBy: "second" })).status,
    "conflict",
    "a second accept must not republish the same diff"
  );
  assert.equal(
    (await store.rejectChangeProposal(outcome.proposalID, { reviewedBy: "third" })).status,
    "conflict"
  );
  await store.close();
});

test("an operation id from another proposal publishes nothing at all", async () => {
  const store = await storeWithPublishedMenu("stale");
  const results = await checkMenus(store, { fetchImpl: serve(MENU_V2), logger: QUIET });
  const [outcome] = await proposeChangesForResults(store, results, {
    fetchImpl: serve(MENU_V2), logger: QUIET
  });

  const result = await store.acceptChangeProposal(outcome.proposalID, {
    reviewedBy: "operator", operationIDs: ["dddddddd-0000-4000-8000-000000000009"]
  });

  assert.equal(result.status, "unknown_operations");
  assert.deepEqual(
    (await store.getRestaurant(ID)).menuItems.map((entry) => entry.name),
    ["Roasted Cauliflower", "Veggie Hash", "Old Seasonal Bowl"],
    "a reviewer working from a stale page publishes nothing rather than a subset"
  );
  assert.equal((await store.getChangeProposal(outcome.proposalID)).status, "pending");
  await store.close();
});

test("rejecting a proposal changes no menu and leaves the restaurant queued", async () => {
  const store = await storeWithPublishedMenu("reject");
  const results = await checkMenus(store, { fetchImpl: serve(MENU_V2), logger: QUIET });
  const [outcome] = await proposeChangesForResults(store, results, {
    fetchImpl: serve(MENU_V2), logger: QUIET
  });

  assert.equal(
    (await store.rejectChangeProposal(outcome.proposalID, {
      reviewedBy: "operator", note: "the burrito is only vegan on request"
    })).status,
    "rejected"
  );

  assert.deepEqual(
    (await store.getRestaurant(ID)).menuItems.map((entry) => entry.name),
    ["Roasted Cauliflower", "Veggie Hash", "Old Seasonal Bowl"]
  );
  // The reading was wrong; the source still changed. Something is still unresolved.
  assert.equal((await store.getReviewQueue()).length, 1);
  const rejected = await store.getChangeProposal(outcome.proposalID);
  assert.equal(rejected.note, "the burrito is only vegan on request");
  await store.close();
});

test("a source that changed without its menu changing proposes nothing", async () => {
  const store = await storeWithPublishedMenu("cosmetic");
  const cosmetic = MENU_V1.replace("<html><body>", "<html><body><div class='banner'>Now hiring</div>");

  const results = await checkMenus(store, { fetchImpl: serve(cosmetic), logger: QUIET });
  assert.equal(results[0].status, "changed", "the fingerprint moved, which is true");

  const proposals = await proposeChangesForResults(store, results, {
    fetchImpl: serve(cosmetic), logger: QUIET
  });
  assert.deepEqual(proposals, [], "an empty proposal would train a reviewer to skim the queue");
  assert.equal((await store.listChangeProposals({ status: "pending" })).length, 0);
  await store.close();
});

test("a menu that loses its legend proposes no retirements", async () => {
  // The dangerous case. Extraction reads nothing from an unlabelled page, and a
  // literal diff would call that "every dish withdrawn" and empty the catalog.
  const store = await storeWithPublishedMenu("legendless");
  const unlabelled = `<html><body>
    <li>Roasted Cauliflower</li><li>$11</li>
    <li>Veggie Hash</li><li>$13</li>
  </body></html>`;

  const results = await checkMenus(store, { fetchImpl: serve(unlabelled), logger: QUIET });
  const [outcome] = await proposeChangesForResults(store, results, {
    fetchImpl: serve(unlabelled), logger: QUIET
  });

  assert.deepEqual(outcome.operations, [], "an unreadable menu is not an empty menu");
  assert.equal(outcome.ambiguities.length, 1);
  assert.match(outcome.ambiguities[0], /could not be read/);
  assert.deepEqual(
    (await store.getRestaurant(ID)).menuItems.length, 3,
    "nothing is proposed, so nothing can be accepted away"
  );
  await store.close();
});

test("a fresh reading supersedes a proposal nobody has decided yet", async () => {
  const store = await storeWithPublishedMenu("supersede");
  const results = await checkMenus(store, { fetchImpl: serve(MENU_V2), logger: QUIET });
  const [first] = await proposeChangesForResults(store, results, {
    fetchImpl: serve(MENU_V2), logger: QUIET
  });

  const MENU_V3 = MENU_V2.replace("$15", "$16");
  const later = await checkMenus(store, { fetchImpl: serve(MENU_V3), logger: QUIET });
  const [second] = await proposeChangesForResults(store, later, {
    fetchImpl: serve(MENU_V3), logger: QUIET
  });

  const pending = await store.listChangeProposals({ status: "pending" });
  assert.equal(pending.length, 1, "two pending diffs would let a reviewer accept the stale one");
  assert.equal(pending[0].id, second.proposalID);
  assert.equal(await store.getChangeProposal(first.proposalID), null);
  await store.close();
});

test("a source that returns to an earlier state still shows the transition that happened", async () => {
  // A → B → A → C. Snapshots dedupe by hash and keep their first capture time,
  // so the most recently *captured* snapshot before C is B — while the state C
  // actually replaced was A. Inferring the previous source from timestamps shows
  // the reviewer a transition that never occurred.
  const store = await storeWithPublishedMenu("lineage");
  const V3 = MENU_V1.replace("Old Seasonal Bowl", "Winter Squash Tartine");

  // An hour apart, so capture order is unambiguous and B is unmistakably the
  // most recently captured snapshot before C.
  for (const [html, when] of [
    [MENU_V2, "2026-08-01T01:00:00Z"],
    [MENU_V1, "2026-08-01T02:00:00Z"],
    [V3, "2026-08-01T03:00:00Z"]
  ]) {
    await checkMenus(store, { fetchImpl: serve(html), logger: QUIET, ...at(when) });
  }
  const outcome = await proposeMenuChanges(store, await store.getCheckTarget(ID), {
    fetchImpl: serve(V3)
  });

  const proposal = await store.getChangeProposal(outcome.proposalID);
  assert.match(
    proposal.oldSource.source, /Old Seasonal Bowl/,
    "the before must be the state the change moved away from"
  );
  assert.doesNotMatch(
    proposal.oldSource.source, /Vegan Breakfast Burrito/,
    "not merely the snapshot captured most recently before this one"
  );
  assert.match(proposal.newSource.source, /Winter Squash Tartine/);
  await store.close();
});

test("a source with no recorded transition reports no before rather than guessing", async () => {
  const store = await storeWithPublishedMenu("first-read");
  // Only ever seen in one state, so nothing was replaced. Asserted against the
  // store because a diff of a menu with itself produces no proposal to inspect.
  const target = await store.getCheckTarget(ID);
  assert.equal(
    await store.priorSnapshotID(ID, target.source_hash), null,
    "a before equal to the after would read as a change that is not one"
  );
  await store.close();
});

test("a reading taken after the source moved again treats the last fingerprint as the before", async () => {
  // The race between a check cycle and the proposal pass that follows it. The
  // state this reading replaces is whatever the checker last recorded, not the
  // transition before that.
  const store = await storeWithPublishedMenu("raced");
  const outcome = await proposeMenuChanges(store, await store.getCheckTarget(ID), {
    fetchImpl: serve(MENU_V2)
  });

  const proposal = await store.getChangeProposal(outcome.proposalID);
  assert.match(proposal.oldSource.source, /Old Seasonal Bowl/, "the last fingerprinted state");
  assert.match(proposal.newSource.source, /Vegan Breakfast Burrito/);
  await store.close();
});

test("a restaurant opted out of automated extraction is never diffed", async () => {
  const store = await storeWithPublishedMenu("manual");
  store.database.prepare("UPDATE restaurants SET menu_profile='manual' WHERE id=?").run(ID);

  const outcome = await proposeMenuChanges(store, await store.getCheckTarget(ID), {
    fetchImpl: serve(MENU_V2)
  });

  assert.equal(outcome.proposalID, null);
  assert.match(outcome.skipped, /opted this restaurant out/);
  await store.close();
});
