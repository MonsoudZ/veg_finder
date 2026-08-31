import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateRestaurant } from "../src/catalog-input.js";
import { openSQLiteStore } from "../src/database.js";
import { LLM_TIER, proposeWithModel, verifyProposals } from "../src/llm-extraction.js";
import { autoPublishTiers, proposeMenu } from "../src/proposals.js";

const MENU = `<html><body>
  <h2>Small Plates</h2>
  <li>Charred Broccolini — chili crisp, puffed rice, lime. $11</li>
  <li>Burrata — heirloom tomato, basil, aged balsamic. $16</li>
  <li>Crispy Pig Ear — gochujang, scallion. $13</li>
  <h2>Mains</h2>
  <li>Mushroom Bolognese — hand-cut pasta, cashew cream, no dairy. $24</li>
  <li>Veggie Burger — house patty, brioche bun, aioli. $18</li>
</body></html>`;

// Stands in for the API: returns whatever proposal payload a test wants to
// exercise, in the shape structured outputs guarantees.
function fakeClient(payload, { capture } = {}) {
  return {
    messages: {
      stream(request) {
        capture?.(request);
        return {
          async finalMessage() {
            return {
              stop_reason: "end_turn",
              model: "claude-opus-5",
              usage: { input_tokens: 1200, output_tokens: 300 },
              content: [{ type: "text", text: JSON.stringify(payload) }]
            };
          }
        };
      }
    }
  };
}

const item = (overrides = {}) => ({
  name: "Charred Broccolini",
  description: "chili crisp, puffed rice, lime",
  price: "$11",
  dietaryStatus: "Vegan",
  modificationNote: "",
  evidence: "Charred Broccolini — chili crisp, puffed rice, lime. $11",
  reasoning: "Every listed ingredient is plant-based.",
  ...overrides
});

test("a verbatim quote from the menu is accepted", async () => {
  const result = await proposeWithModel(MENU, {
    restaurantName: "Test", client: fakeClient({ items: [item()], unreadable: false, notes: "" })
  });

  assert.equal(result.tier, LLM_TIER);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, "Charred Broccolini");
  assert.equal(result.items[0].sourceEvidence, item().evidence);
  assert.equal(result.dropped.length, 0);
});

test("invented evidence is discarded, not surfaced for review", async () => {
  const result = await proposeWithModel(MENU, {
    restaurantName: "Test",
    client: fakeClient({
      items: [item({
        name: "Cauliflower Steak",
        evidence: "Cauliflower Steak — romesco, capers, parsley. $21"  // not on this menu
      })],
      unreadable: false,
      notes: ""
    })
  });

  assert.equal(result.items.length, 0, "a dish the menu never listed must not reach a reviewer");
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /does not appear in the source/);
});

test("a paraphrased quote is discarded even when the dish is real", async () => {
  const result = await proposeWithModel(MENU, {
    restaurantName: "Test",
    client: fakeClient({
      items: [item({ evidence: "Charred broccolini served with chili crisp and lime" })],
      unreadable: false,
      notes: ""
    })
  });

  assert.equal(result.items.length, 0, "evidence must be copied, not reconstructed");
  assert.match(result.dropped[0].reason, /does not appear in the source/);
});

test("evidence stitched from two parts of the menu is discarded", () => {
  const { kept, dropped } = verifyProposals(
    [item({ evidence: "Charred Broccolini — chili crisp Crispy Pig Ear — gochujang" })],
    MENU
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
});

test("verification tolerates rendering differences but not wording changes", () => {
  // Curly quotes, en-dashes and collapsed whitespace differ between the raw HTML
  // and what a reader sees; the words themselves must still match.
  const source = "Mushroom  Bolognese —  hand-cut pasta, cashew cream, no dairy. $24";
  assert.equal(
    verifyProposals([item({ evidence: "Mushroom Bolognese - hand-cut pasta, cashew cream, no dairy. $24" })], source)
      .kept.length,
    1,
    "punctuation and spacing normalisation should not reject a real quote"
  );
  assert.equal(
    verifyProposals([item({ evidence: "Mushroom Bolognese - hand-cut pasta, cashew cream, no butter. $24" })], source)
      .kept.length,
    0,
    "changing an ingredient word must fail verification"
  );
});

test("a too-short quote cannot serve as evidence", () => {
  const { kept, dropped } = verifyProposals([item({ evidence: "vegan" })], MENU);
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /too short/);
});

test("a modification-dependent dish without a stated modification is discarded", () => {
  const { kept, dropped } = verifyProposals(
    [item({
      name: "Veggie Burger",
      dietaryStatus: "Can be made vegan",
      modificationNote: "",
      evidence: "Veggie Burger — house patty, brioche bun, aioli. $18"
    })],
    MENU
  );
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /no stated modification/);
});

test("a modification-dependent dish keeps its instruction when one is given", () => {
  const { kept } = verifyProposals(
    [item({
      name: "Veggie Burger",
      dietaryStatus: "Can be made vegan",
      modificationNote: "Ask for no aioli and a vegan bun",
      evidence: "Veggie Burger — house patty, brioche bun, aioli. $18"
    })],
    MENU
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].modificationNote, "Ask for no aioli and a vegan bun");
});

test("an unrecognised dietary status is discarded", () => {
  const { kept, dropped } = verifyProposals([item({ dietaryStatus: "Probably vegan" })], MENU);
  assert.equal(kept.length, 0);
  assert.match(dropped[0].reason, /unrecognised dietary status/);
});

test("the request pins the model, caches the system prompt, and constrains the schema", async () => {
  let request;
  await proposeWithModel(MENU, {
    restaurantName: "Test",
    client: fakeClient({ items: [], unreadable: false, notes: "" }, { capture: (r) => { request = r; } })
  });

  assert.equal(request.model, "claude-opus-5");
  assert.equal(request.system[0].cache_control.type, "ephemeral");
  assert.equal(request.output_config.format.type, "json_schema");
  assert.equal(request.output_config.effort, "high");
  assert.match(request.messages[0].content, /Charred Broccolini/, "the menu text must reach the model");
});

test("a refusal surfaces as an error rather than an empty menu", async () => {
  const refusing = {
    messages: {
      stream: () => ({
        async finalMessage() {
          return { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] };
        }
      })
    }
  };
  await assert.rejects(
    proposeWithModel(MENU, { restaurantName: "Test", client: refusing }),
    /declined to process/
  );
});

test("an empty page is reported unreadable without calling the model", async () => {
  let called = false;
  const result = await proposeWithModel("<html><body></body></html>", {
    restaurantName: "Test",
    client: { messages: { stream() { called = true; } } }
  });
  assert.equal(result.unreadable, true);
  assert.equal(result.items.length, 0);
  assert.equal(called, false);
});

test("the model tier can never be configured to publish without review", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const tiers = autoPublishTiers(`fully_vegan,labelled_menu,${LLM_TIER}`);
    assert.equal(tiers.has(LLM_TIER), false, "the model tier must be stripped from any allowlist");
    assert.equal(tiers.has("fully_vegan"), true);
    assert.match(warnings.join(" "), /not publishable without review/);
  } finally {
    console.warn = originalWarn;
  }
});

test("an unlabelled menu produces drafts that are held for review, never published", async () => {
  const store = openSQLiteStore(join(mkdtempSync(join(tmpdir(), "vf-llm-")), "c.sqlite"));
  const input = validateRestaurant({
    id: "bbbbbbbb-0000-4000-8000-000000000001",
    name: "Unlabelled Bistro", neighborhood: "Capitol Hill", address: "1 Main St",
    latitude: 39.74, longitude: -104.98, menuURL: "https://example.com/menu"
  });
  await store.upsertRestaurant(input.value);

  const result = await proposeMenu(store, await store.getCheckTarget(input.value.id), {
    fetchImpl: async () => new Response(MENU),
    // Permissive on purpose: even a wide-open allowlist must not publish this tier.
    tiers: autoPublishTiers("fully_vegan,labelled_menu,manual"),
    modelClient: fakeClient({ items: [item()], unreadable: false, notes: "" })
  });

  assert.equal(result.tier, LLM_TIER);
  assert.equal(result.items.length, 1);
  assert.equal(result.published, false);
  assert.equal(result.requiresReview, true);
  assert.equal((await store.getRestaurant(input.value.id)).menuItems.length, 0);
  assert.equal((await store.getReviewQueue()).length, 1);
  await store.close();
});

test("without a model client an unlabelled menu still falls through to a human", async () => {
  const store = openSQLiteStore(join(mkdtempSync(join(tmpdir(), "vf-nollm-")), "c.sqlite"));
  const input = validateRestaurant({
    id: "bbbbbbbb-0000-4000-8000-000000000002",
    name: "No Model", neighborhood: "Capitol Hill", address: "2 Main St",
    latitude: 39.74, longitude: -104.98, menuURL: "https://example.com/menu"
  });
  await store.upsertRestaurant(input.value);

  const result = await proposeMenu(store, await store.getCheckTarget(input.value.id), {
    fetchImpl: async () => new Response(MENU),
    modelClient: null
  });

  assert.equal(result.tier, "manual");
  assert.equal(result.items.length, 0);
  await store.close();
});
