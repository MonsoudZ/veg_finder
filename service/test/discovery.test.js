import assert from "node:assert/strict";
import test from "node:test";
import { readCandidates } from "../src/candidate-import.js";
import {
  overpassQuery, parseBBox, PRIORITIES, priorityOf, rankCandidates, summarize, toCandidates
} from "../src/discovery.js";

const node = (id, tags, overrides = {}) => ({
  type: "node", id, lat: 39.74, lon: -104.98, tags, ...overrides
});

const FULL_TAGS = {
  name: "Corner Bistro",
  "addr:housenumber": "100",
  "addr:street": "E Colfax Ave",
  "addr:city": "Denver",
  website: "https://example.com"
};

test("a bounding box is validated rather than quietly transposed", () => {
  assert.deepEqual(parseBBox("39.70,-105.02,39.76,-104.95"), [39.70, -105.02, 39.76, -104.95]);
  // A reversed box searches the wrong place and returns a plausible empty result.
  assert.throws(() => parseBBox("39.76,-105.02,39.70,-104.95"), /south < north/);
  assert.throws(() => parseBBox("39.70,-104.95,39.76,-105.02"), /west < east/);
  assert.throws(() => parseBBox("39.70,-105.02"), /four numbers/);
  assert.throws(() => parseBBox("denver"), /four numbers/);
});

test("the query asks for ways as well as nodes, with a centre for each", () => {
  const query = overpassQuery({ bbox: [39.7, -105.02, 39.76, -104.95] });
  // A restaurant mapped as a building is a way, not a node, and dropping those
  // loses a large share of the city.
  assert.match(query, /way\["amenity"/);
  assert.match(query, /out center tags;/);
  assert.match(overpassQuery({ area: 'Den"ver' }), /area\["name"="Den\\"ver"\]/, "names are escaped");
});

test("an OSM place becomes a candidate with its provenance attached", () => {
  const { complete } = toCandidates({ elements: [node(1, FULL_TAGS)] });

  assert.equal(complete.length, 1);
  assert.deepEqual(
    { name: complete[0].name, address: complete[0].address, neighborhood: complete[0].neighborhood },
    { name: "Corner Bistro", address: "100 E Colfax Ave, Denver", neighborhood: "Denver" }
  );
  assert.equal(complete[0].discovery.source, "osm:node/1");
  assert.equal(complete[0].menuURL, null, "the menu is found separately, or by a person");
});

test("a restaurant mapped as a building keeps its centre coordinates", () => {
  const { complete } = toCandidates({
    elements: [node(2, FULL_TAGS, { lat: undefined, lon: undefined, type: "way", center: { lat: 39.75, lon: -104.99 } })]
  });

  assert.equal(complete[0].latitude, 39.75);
  assert.equal(complete[0].longitude, -104.99);
});

test("a place missing something is reported, never completed by guesswork", () => {
  const { complete, incomplete } = toCandidates({
    elements: [
      node(3, { ...FULL_TAGS, "addr:housenumber": undefined, "addr:street": undefined }),
      node(4, { ...FULL_TAGS, website: undefined }),
      node(5, { ...FULL_TAGS, name: undefined })
    ]
  });

  assert.equal(complete.length, 0);
  assert.deepEqual(incomplete.map((entry) => entry.missing), [["address"], ["website"], ["name"]]);
  assert.equal(
    incomplete[0].address, "Denver",
    "a city is not an address, and it is not promoted into one"
  );
});

test("OSM dietary tags rank a candidate and never become a dietary claim", () => {
  // The trust boundary of the whole discovery step. `diet:vegan=only` is a map
  // contributor's assertion; menuProfile 'fully_vegan' publishes an entire menu
  // with no human review. Wiring one to the other would let a stranger's edit
  // publish vegan claims to people who cannot eat animal products.
  const { complete } = toCandidates({
    elements: [node(6, { ...FULL_TAGS, "diet:vegan": "only" })]
  });

  assert.equal(priorityOf(complete[0]), PRIORITIES.WHOLLY_MEATLESS, "it is ranked first");
  assert.equal(complete[0].menuProfile, undefined, "and it asserts nothing");
  assert.equal(complete[0].discovery.dietVegan, "only", "the tag is kept as provenance");

  // Proven at the boundary that matters: the importer never sees a profile.
  const { candidates } = readCandidates({
    restaurants: [{ ...complete[0], menuURL: "https://example.com/menu" }]
  });
  assert.equal(
    candidates[0].menuProfile, "unknown",
    "an imported restaurant claims nothing about itself until an operator says so"
  );
});

test("candidates are ordered cheapest-to-verify first, then stably by name", () => {
  const { complete } = toCandidates({
    elements: [
      node(10, { ...FULL_TAGS, name: "Zeta Grill" }),
      node(11, { ...FULL_TAGS, name: "Alpha Diner", "diet:vegetarian": "yes" }),
      node(12, { ...FULL_TAGS, name: "Omega Kitchen", "diet:vegan": "only" }),
      node(13, { ...FULL_TAGS, name: "Beta Cafe", cuisine: "vegan" }),
      node(14, { ...FULL_TAGS, name: "Alpha Grill" })
    ]
  });

  assert.deepEqual(rankCandidates(complete).map((entry) => entry.name), [
    // One operator assertion publishes an entire menu.
    "Beta Cafe", "Omega Kitchen",
    // Likely to carry a legend worth one review.
    "Alpha Diner",
    // A person per dish, for whatever two sides they yield.
    "Alpha Grill", "Zeta Grill"
  ]);
  assert.deepEqual(summarize(complete), {
    whollyMeatless: 2, meatlessFriendly: 1, unknown: 2
  });
});

test("a discovered candidate is shaped so the importer accepts it", () => {
  // The two tools compose through a file, so the file has to be right.
  const { complete } = toCandidates({ elements: [node(20, FULL_TAGS)] });
  complete[0].menuURL = "https://example.com/menu";

  const { candidates, invalid } = readCandidates({ restaurants: complete });
  assert.deepEqual(invalid, []);
  assert.equal(candidates[0].name, "Corner Bistro");
  assert.equal(candidates[0].menuURL, "https://example.com/menu");
  assert.match(candidates[0].id, /^[0-9a-f-]{36}$/);
});

test("a website recorded without a scheme is still usable", () => {
  const { complete } = toCandidates({
    elements: [node(21, { ...FULL_TAGS, website: "www.example.com" })]
  });
  assert.equal(complete[0].discovery.website, "https://www.example.com/");

  const { incomplete } = toCandidates({
    elements: [node(22, { ...FULL_TAGS, website: "not a url" })]
  });
  assert.deepEqual(incomplete[0].missing, ["website"]);
});
