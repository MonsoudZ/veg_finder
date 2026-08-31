import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkMenus } from "../src/checker.js";
import { defaultSeedPath } from "../src/paths.js";
import { openPostgresStore } from "../src/postgres-store.js";

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
