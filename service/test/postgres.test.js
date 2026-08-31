import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkMenus } from "../src/checker.js";
import { defaultSeedPath } from "../src/paths.js";
import { validateMenuItems, validateRestaurant } from "../src/catalog-input.js";
import { openPostgresStore } from "../src/postgres-store.js";
import { proposeChangesForResults, proposeMenuChanges } from "../src/menu-changes.js";
import { autoPublishTiers, proposeMenu } from "../src/proposals.js";

const connectionString = process.env.TEST_DATABASE_URL;

function seedAuditedAt(auditedAt, { coverageStatus = "Complete" } = {}) {
  const seed = JSON.parse(readFileSync(defaultSeedPath, "utf8"));
  seed.restaurants = seed.restaurants.map((restaurant) => ({
    ...restaurant, auditedAt, coverageStatus
  }));
  const path = join(mkdtempSync(join(tmpdir(), "vegfinder-seed-")), "catalog.seed.json");
  writeFileSync(path, JSON.stringify(seed));
  return path;
}

async function freshStore() {
  const store = await openPostgresStore(connectionString);
  await store.pool.query(`
    TRUNCATE menu_item_versions, menu_source_snapshots, menu_check_runs,
             menu_items, restaurants CASCADE
  `);
  return store;
}

async function demoteEveryRestaurant(store) {
  const logger = { log() {}, error() {} };
  await checkMenus(store, { fetchImpl: async () => new Response("<main>one</main>"), logger });
  await checkMenus(store, { fetchImpl: async () => new Response("<main>two</main>"), logger });
}

test("PostgreSQL migrates, seeds, versions, and records checks", {
  skip: !connectionString
}, async () => {
  const store = await openPostgresStore(connectionString);
  try {
    await store.pool.query(`
      TRUNCATE menu_item_versions, menu_source_snapshots, menu_check_runs,
               menu_items, restaurants CASCADE
    `);
    await store.importSeed();

    const catalog = await store.getCatalog();
    assert.equal(catalog.restaurants.length, 10);
    assert.equal(catalog.restaurants.flatMap((restaurant) => restaurant.menuItems).length, 128);
    const { rows: [versions] } = await store.pool.query(
      "SELECT COUNT(*)::integer AS count FROM menu_item_versions"
    );
    assert.equal(versions.count, 128);

    const logger = { log() {}, error() {} };
    await checkMenus(store, {
      fetchImpl: async () => new Response("<main>Menu version one</main>"),
      logger
    });
    await checkMenus(store, {
      fetchImpl: async () => new Response("<main>Menu version two</main>"),
      logger
    });

    const { rows: [history] } = await store.pool.query(`
      SELECT
        (SELECT COUNT(*)::integer FROM menu_check_runs) AS runs,
        (SELECT COUNT(*)::integer FROM menu_source_snapshots) AS snapshots
    `);
    assert.equal(history.runs, 20);
    assert.equal(history.snapshots, 20);
    assert.equal((await store.getReviewQueue()).length, 10);
  } finally {
    await store.close();
  }
});

test("PostgreSQL unpublishes every item when a seed empties a restaurant menu", {
  skip: !connectionString
}, async () => {
  const store = await openPostgresStore(connectionString);
  try {
    await store.pool.query(`
      TRUNCATE menu_item_versions, menu_source_snapshots, menu_check_runs,
               menu_items, restaurants CASCADE
    `);
    await store.importSeed();

    const [target] = (await store.getCatalog()).restaurants;
    const publishedCount = target.menuItems.length;
    assert.ok(publishedCount > 0);

    const seed = JSON.parse(readFileSync(defaultSeedPath, "utf8"));
    seed.restaurants = seed.restaurants.map(
      (restaurant) => restaurant.id === target.id ? { ...restaurant, menuItems: [] } : restaurant
    );
    const seedPath = join(mkdtempSync(join(tmpdir(), "vegfinder-seed-")), "catalog.seed.json");
    writeFileSync(seedPath, JSON.stringify(seed));
    await store.importSeed(seedPath);

    const emptied = (await store.getCatalog()).restaurants.find((row) => row.id === target.id);
    assert.equal(emptied.menuItems.length, 0, "dropped items must stop being served");

    const { rows: [counts] } = await store.pool.query(`
      SELECT
        (SELECT COUNT(*)::integer FROM menu_items
          WHERE restaurant_id=$1 AND active=TRUE) AS active,
        (SELECT COUNT(*)::integer FROM menu_item_versions
          WHERE restaurant_id=$1 AND change_kind='retired') AS retired
    `, [target.id]);
    assert.equal(counts.active, 0);
    assert.equal(counts.retired, publishedCount, "history and published state must agree");
  } finally {
    await store.close();
  }
});

test("PostgreSQL re-seeding without a fresh audit keeps a demoted restaurant demoted", {
  skip: !connectionString
}, async () => {
  const store = await freshStore();
  try {
    await store.importSeed();
    await demoteEveryRestaurant(store);
    assert.equal((await store.getReviewQueue()).length, 10);

    await store.importSeed(seedAuditedAt("2026-08-30T00:00:00Z"));

    const catalog = await store.getCatalog();
    assert.ok(
      catalog.restaurants.every((restaurant) => restaurant.coverageStatus === "Needs review"),
      "a seed with no fresh audit must not clear the checker's demotion"
    );
    assert.equal((await store.getReviewQueue()).length, 10);
  } finally {
    await store.close();
  }
});

test("PostgreSQL reconciliation republishes and drains the review queue", {
  skip: !connectionString
}, async () => {
  const store = await freshStore();
  try {
    await store.importSeed();
    await demoteEveryRestaurant(store);
    assert.equal((await store.getReviewQueue()).length, 10);

    await store.importSeed(seedAuditedAt("2026-09-15T00:00:00Z"));

    const catalog = await store.getCatalog();
    assert.ok(catalog.restaurants.every((restaurant) => restaurant.coverageStatus === "Complete"));
    assert.equal((await store.getReviewQueue()).length, 0, "reconciliation must drain the queue");

    const { rows: [row] } = await store.pool.query(
      "SELECT COUNT(*)::integer AS count FROM restaurants WHERE check_error IS NOT NULL"
    );
    assert.equal(row.count, 0);
  } finally {
    await store.close();
  }
});

test("PostgreSQL lets a seed demote a restaurant at any time", {
  skip: !connectionString
}, async () => {
  const store = await freshStore();
  try {
    await store.importSeed();
    assert.equal((await store.getReviewQueue()).length, 0);

    await store.importSeed(seedAuditedAt("2026-09-15T00:00:00Z", { coverageStatus: "Needs review" }));

    const catalog = await store.getCatalog();
    assert.ok(catalog.restaurants.every((restaurant) => restaurant.coverageStatus === "Needs review"));
    assert.equal((await store.getReviewQueue()).length, 10, "a demotion must reach the queue");
  } finally {
    await store.close();
  }
});

// The query modes and the admin write path must behave identically on the store
// production actually runs, not just on the development one.
test("PostgreSQL serves nearby, paged, and delta queries", {
  skip: !connectionString
}, async () => {
  const store = await freshStore();
  try {
    await store.importSeed();

    const nearby = await store.getCatalogPage({
      latitude: 39.7340, longitude: -104.9800, radiusKm: 2, limit: 50
    });
    assert.ok(nearby.restaurants.length > 0);
    assert.ok(nearby.restaurants.length < 11);

    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const page = await store.getCatalogPage({ limit: 3, cursor });
      seen.push(...page.restaurants.map((restaurant) => restaurant.id));
      cursor = page.nextCursor;
      assert.ok(++pages < 20, "pagination must terminate");
    } while (cursor);
    assert.equal(seen.length, 10);
    assert.equal(new Set(seen).size, 10);
    assert.ok(pages > 1);

    const initial = await store.getCatalogPage({ limit: 100 });
    const quiet = await store.getCatalogPage({ since: initial.syncedAt, limit: 100 });
    assert.equal(quiet.restaurants.length, 0, "an unchanged catalog produces an empty delta");
  } finally {
    await store.close();
  }
});

test("PostgreSQL creates unpublished restaurants and publishes them on reconcile", {
  skip: !connectionString
}, async () => {
  const store = await freshStore();
  try {
    await store.importSeed();
    const watermark = (await store.getCatalogPage({ limit: 100 })).syncedAt;

    const input = validateRestaurant({
      id: "bbbbbbbb-0000-4000-8000-000000000001",
      name: "Test Kitchen",
      neighborhood: "Capitol Hill",
      address: "100 E Colfax Ave",
      latitude: 39.7402,
      longitude: -104.9847,
      menuURL: "https://example.com/menu"
    });
    assert.equal(input.valid, true);
    assert.equal((await store.upsertRestaurant(input.value)).created, true);

    const created = await store.getRestaurant(input.value.id);
    assert.equal(created.coverageStatus, "Needs review");
    assert.equal(created.menuItems.length, 0);
    assert.equal((await store.getReviewQueue()).length, 1);

    const items = validateMenuItems([
      {
        id: "cccccccc-0000-4000-8000-000000000001",
        name: "Chana Bowl", description: "Chickpeas", price: "$12",
        dietaryStatus: "Vegan", sourceEvidence: "Menu marks this VG"
      },
      {
        id: "cccccccc-0000-4000-8000-000000000002",
        name: "Street Tacos", description: "Three", price: "$13",
        dietaryStatus: "Can be made vegan", modificationNote: "Ask for no crema",
        sourceEvidence: "Menu lists crema as removable"
      }
    ]);
    assert.equal(items.valid, true);

    const published = await store.reconcileRestaurant(input.value.id, {
      coverageStatus: "Complete", coverageScope: "All qualifying dishes", menuItems: items.value
    });
    assert.equal(published.coverageStatus, "Complete");
    assert.equal(published.menuItems.length, 2);
    assert.equal((await store.getReviewQueue()).length, 0);

    const delta = await store.getCatalogPage({ since: watermark, limit: 100 });
    assert.equal(delta.restaurants.length, 1, "only the reconciled restaurant should sync");
    assert.equal(delta.restaurants[0].name, "Test Kitchen");

    const { rows: [versions] } = await store.pool.query(
      "SELECT COUNT(*)::integer AS count FROM menu_item_versions WHERE restaurant_id=$1",
      [input.value.id]
    );
    assert.equal(versions.count, 2);

    assert.equal(
      await store.reconcileRestaurant("dddddddd-0000-4000-8000-000000000009", {
        coverageStatus: "Complete", menuItems: []
      }),
      null
    );
  } finally {
    await store.close();
  }
});

const MENU_V1 = `<html><body>
  <p>VG = Vegan, V = Vegetarian</p>
  <li>Roasted Cauliflower (VG)</li><li>$11</li>
  <li>Veggie Hash (V)</li><li>$13</li>
  <li>Old Seasonal Bowl (VG)</li><li>$12</li>
</body></html>`;
const MENU_V2 = `<html><body>
  <p>VG = Vegan, V = Vegetarian</p>
  <li>Roasted Cauliflower (VG)</li><li>$11</li>
  <li>Veggie Hash (V)</li><li>$15</li>
  <li>Vegan Breakfast Burrito (VG)</li><li>$14.00</li>
</body></html>`;

// The change-proposal path carries the transactional guarantee this service
// leans on hardest, so it is exercised against the engine production runs on and
// not only against SQLite.
test("PostgreSQL proposes a structured diff and publishes it in one transaction", {
  skip: !connectionString
}, async () => {
  const store = await freshStore();
  const logger = { log() {}, error() {} };
  const serve = (html) => async () => new Response(html);
  const id = "bbbbbbbb-0000-4000-8000-000000000042";
  try {
    await store.upsertRestaurant(validateRestaurant({
      id, name: "Jelly", neighborhood: "Capitol Hill", address: "600 E 13th Ave",
      latitude: 39.7371, longitude: -104.9784, menuURL: "https://example.com/menu"
    }).value);
    await checkMenus(store, { fetchImpl: serve(MENU_V1), logger });
    await proposeMenu(store, await store.getCheckTarget(id), {
      fetchImpl: serve(MENU_V1), tiers: autoPublishTiers("labelled_menu")
    });
    assert.equal((await store.getRestaurant(id)).menuItems.length, 3);

    const results = await checkMenus(store, { fetchImpl: serve(MENU_V2), logger });
    assert.equal(results[0].status, "changed");
    const [outcome] = await proposeChangesForResults(store, results, {
      fetchImpl: serve(MENU_V2), logger
    });

    const proposal = await store.getChangeProposal(outcome.proposalID);
    assert.deepEqual(
      proposal.operations.map((operation) => operation.operation).sort(),
      ["add", "retire", "update"]
    );
    assert.match(proposal.oldSource.source, /Old Seasonal Bowl/);
    assert.match(proposal.newSource.source, /Vegan Breakfast Burrito/);
    assert.equal(
      (await store.getRestaurant(id)).menuItems.length, 3, "a proposal publishes nothing"
    );

    const accepted = await store.acceptChangeProposal(outcome.proposalID, {
      reviewedBy: "operator@example.com"
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.applied, 3);

    const after = await store.getRestaurant(id);
    assert.deepEqual(
      after.menuItems.map((entry) => entry.name),
      ["Roasted Cauliflower", "Veggie Hash", "Vegan Breakfast Burrito"]
    );
    assert.equal(after.menuItems.find((entry) => entry.name === "Veggie Hash").price, "$15");
    assert.equal(after.coverageStatus, "Complete");

    const { rows: kinds } = await store.pool.query(`
      SELECT change_kind, COUNT(*)::integer AS count FROM menu_item_versions
      WHERE restaurant_id=$1 GROUP BY change_kind ORDER BY change_kind
    `, [id]);
    assert.deepEqual(kinds, [
      { change_kind: "published", count: 4 },
      { change_kind: "retired", count: 1 },
      { change_kind: "updated", count: 1 }
    ], "three published at baseline, then one added, one repriced, one retired");

    assert.equal(
      (await store.acceptChangeProposal(outcome.proposalID, { reviewedBy: "again" })).status,
      "conflict"
    );
  } finally {
    await store.close();
  }
});

// priorSnapshotID is a separate implementation per store, and it is the one
// piece of this pipeline that cannot be inferred correctly from the snapshots
// table alone, so it is checked against the engine production runs on.
test("PostgreSQL shows the transition that happened, not the last snapshot captured", {
  skip: !connectionString
}, async () => {
  const store = await freshStore();
  const logger = { log() {}, error() {} };
  const serve = (html) => async () => new Response(html);
  const at = (iso) => ({ now: () => new Date(iso) });
  const id = "bbbbbbbb-0000-4000-8000-000000000043";
  const V3 = MENU_V1.replace("Old Seasonal Bowl", "Winter Squash Tartine");
  try {
    await store.upsertRestaurant(validateRestaurant({
      id, name: "Jelly", neighborhood: "Capitol Hill", address: "600 E 13th Ave",
      latitude: 39.7371, longitude: -104.9784, menuURL: "https://example.com/menu"
    }).value);

    // A → B → A → C. B is the most recently *captured* snapshot before C, while
    // the state C replaced was A.
    for (const [html, when] of [
      [MENU_V1, "2026-08-01T00:00:00Z"], [MENU_V2, "2026-08-01T01:00:00Z"],
      [MENU_V1, "2026-08-01T02:00:00Z"], [V3, "2026-08-01T03:00:00Z"]
    ]) {
      await checkMenus(store, { fetchImpl: serve(html), logger, ...at(when) });
    }

    const outcome = await proposeMenuChanges(store, await store.getCheckTarget(id), {
      fetchImpl: serve(V3)
    });
    const proposal = await store.getChangeProposal(outcome.proposalID);
    assert.match(proposal.oldSource.source, /Old Seasonal Bowl/);
    assert.doesNotMatch(proposal.oldSource.source, /Vegan Breakfast Burrito/);
    assert.match(proposal.newSource.source, /Winter Squash Tartine/);
  } finally {
    await store.close();
  }
});
