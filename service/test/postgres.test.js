import assert from "node:assert/strict";
import test from "node:test";
import { checkMenus } from "../src/checker.js";
import { openPostgresStore } from "../src/postgres-store.js";

const connectionString = process.env.TEST_DATABASE_URL;

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
