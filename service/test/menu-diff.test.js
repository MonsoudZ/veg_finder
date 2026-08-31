import assert from "node:assert/strict";
import test from "node:test";
import { diffMenu } from "../src/menu-diff.js";

const item = (overrides = {}) => ({
  id: "cccccccc-0000-4000-8000-000000000001",
  name: "Roasted Cauliflower",
  description: "",
  price: "$11",
  dietaryStatus: "Vegan",
  modificationNote: null,
  sourceEvidence: "Roasted Cauliflower (VG) $11",
  ...overrides
});

const second = (overrides = {}) => item({
  id: "cccccccc-0000-4000-8000-000000000002", name: "Veggie Hash",
  price: "$13", dietaryStatus: "Vegetarian", ...overrides
});

test("a menu that did not change proposes nothing", () => {
  const published = [item(), second()];
  const { operations, ambiguities } = diffMenu({
    published, extracted: [item(), second()], tier: "labelled_menu"
  });

  assert.deepEqual(operations, [], "an unchanged dish is not a change");
  assert.deepEqual(ambiguities, []);
});

test("re-quoting the same claim from a different line is not a menu change", () => {
  // Evidence moves whenever a page is re-rendered. Treating that as a change
  // would refill the queue every cycle with dishes nobody touched.
  const { operations } = diffMenu({
    published: [item()],
    extracted: [item({ sourceEvidence: "Roasted Cauliflower (VG) ..... $11" })],
    tier: "labelled_menu"
  });

  assert.deepEqual(operations, []);
});

test("a price change is one update naming the field that moved", () => {
  const { operations } = diffMenu({
    published: [second()], extracted: [second({ price: "$15" })], tier: "labelled_menu"
  });

  assert.equal(operations.length, 1);
  assert.equal(operations[0].operation, "update");
  assert.deepEqual(operations[0].changedFields, ["price"]);
  assert.equal(operations[0].current.price, "$13");
  assert.equal(operations[0].proposed.price, "$15");
  assert.equal(
    operations[0].confidence, "high",
    "a price correction moves no dietary claim, so it is cheap to accept"
  );
});

test("a dish the new source does not account for is proposed for retirement", () => {
  const { operations } = diffMenu({
    published: [item(), second()], extracted: [item()], tier: "labelled_menu"
  });

  assert.equal(operations.length, 1);
  assert.equal(operations[0].operation, "retire");
  assert.equal(operations[0].current.name, "Veggie Hash");
  assert.equal(operations[0].proposed, null, "a retirement proposes no new values");
});

test("a new dish is proposed as an addition carrying its evidence", () => {
  const { operations } = diffMenu({
    published: [item()],
    extracted: [item(), second({ name: "Vegan Breakfast Burrito", price: "$14.00",
      sourceEvidence: "Vegan Breakfast Burrito (VG) $14.00" })],
    tier: "labelled_menu"
  });

  assert.equal(operations.length, 1);
  assert.equal(operations[0].operation, "add");
  assert.equal(operations[0].proposed.name, "Vegan Breakfast Burrito");
  assert.equal(operations[0].evidence, "Vegan Breakfast Burrito (VG) $14.00");
});

test("a changed dietary status is never quietly accepted", () => {
  const { operations, ambiguities } = diffMenu({
    published: [second()],
    extracted: [second({ dietaryStatus: "Vegan" })],
    tier: "labelled_menu"
  });

  assert.deepEqual(operations[0].changedFields, ["dietaryStatus"]);
  assert.equal(
    operations[0].confidence, "low",
    "this is the claim a diner relies on; it does not get the benefit of the doubt"
  );
  assert.equal(ambiguities.length, 1);
  assert.match(ambiguities[0], /Vegetarian.*Vegan/);
});

test("a diff that would empty the menu says so instead of quietly proposing it", () => {
  // The failure this whole system exists to survive: a restaurant that withdrew
  // its vegan menu and one that reworded its legend produce the identical diff.
  const { operations, ambiguities } = diffMenu({
    published: [item(), second()], extracted: [], tier: "labelled_menu"
  });

  assert.equal(operations.length, 2);
  assert.ok(operations.every((operation) => operation.operation === "retire"));
  assert.ok(
    operations.every((operation) => operation.confidence === "low"),
    "wholesale retirement is the one over-proposal that is dangerous if blind-accepted"
  );
  assert.equal(ambiguities.length, 1);
  assert.match(ambiguities[0], /Every published item \(2\) would be retired/);
});

test("a source that could not be read proposes nothing at all", () => {
  // Not the same as a source listing no dishes. Conflating them would retire a
  // whole menu because a PDF replaced an HTML page.
  const { operations, ambiguities } = diffMenu({
    published: [item(), second()], extracted: [], tier: "manual", readable: false
  });

  assert.deepEqual(operations, [], "an unreadable page is not evidence that dishes went away");
  assert.equal(ambiguities.length, 1);
  assert.match(ambiguities[0], /could not be read/);
});

test("a retirement beside a similar addition is flagged as a possible rename", () => {
  // `second()` is untouched so this is a rename within a menu, not the wholesale
  // retirement the previous test covers.
  const renamed = item({ id: "cccccccc-0000-4000-8000-00000000000a",
    name: "Roasted Cauliflower Steak" });
  const { operations, ambiguities } = diffMenu({
    published: [item(), second()],
    extracted: [renamed, second()],
    tier: "labelled_menu"
  });

  assert.deepEqual(
    operations.map((operation) => operation.operation), ["add", "retire"],
    "version one proposes both rather than guessing they are one dish"
  );
  assert.equal(ambiguities.length, 1);
  assert.match(ambiguities[0], /may be one renamed dish/);
});

test("a model's reading is marked as needing checking", () => {
  const { ambiguities } = diffMenu({
    published: [], extracted: [item()], tier: "llm_assisted"
  });

  assert.equal(ambiguities.length, 1);
  assert.match(ambiguities[0], /came from a model/);
});

test("an empty description and a missing one are the same absence", () => {
  const { operations } = diffMenu({
    published: [item({ description: null })],
    extracted: [item({ description: "" })],
    tier: "labelled_menu"
  });

  assert.deepEqual(operations, [], "phantom edits would make every proposal unreadable");
});
