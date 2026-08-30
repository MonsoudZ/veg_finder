import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { defaultDatabasePath, defaultSeedPath } from "./paths.js";

export { defaultDatabasePath, defaultSeedPath } from "./paths.js";

export function openDatabase(path = defaultDatabasePath) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  migrate(database);
  return database;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      neighborhood TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      menu_url TEXT NOT NULL,
      check_url TEXT,
      extraction_mode TEXT NOT NULL DEFAULT 'change_detection',
      verified_at TEXT NOT NULL,
      coverage_status TEXT NOT NULL DEFAULT 'Needs review',
      coverage_scope TEXT NOT NULL DEFAULT 'Qualifying items found on the official menu',
      audited_at TEXT,
      last_checked_at TEXT,
      source_hash TEXT,
      review_required INTEGER NOT NULL DEFAULT 0,
      check_error TEXT
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      price TEXT NOT NULL,
      dietary_status TEXT NOT NULL CHECK (
        dietary_status IN ('Vegan', 'Vegetarian', 'Can be made vegan', 'Can be made vegetarian')
      ),
      modification_note TEXT,
      source_evidence TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      last_verified_at TEXT,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS menu_check_runs (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      checked_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok', 'changed', 'failed')),
      source_hash TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS menu_source_snapshots (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      source_hash TEXT NOT NULL,
      normalized_source TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      UNIQUE(restaurant_id, source_hash)
    );

    CREATE TABLE IF NOT EXISTS menu_item_versions (
      id TEXT PRIMARY KEY,
      menu_item_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      item_snapshot TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      change_kind TEXT NOT NULL CHECK (change_kind IN ('published', 'updated', 'retired'))
    );

    CREATE INDEX IF NOT EXISTS menu_items_restaurant
      ON menu_items(restaurant_id, sort_order);
  `);

  // Keep existing developer databases usable as the catalog schema evolves.
  const columns = new Set(database.prepare("PRAGMA table_info(restaurants)").all().map((column) => column.name));
  if (!columns.has("coverage_status")) {
    database.exec("ALTER TABLE restaurants ADD COLUMN coverage_status TEXT NOT NULL DEFAULT 'Needs review'");
  }
  if (!columns.has("coverage_scope")) {
    database.exec("ALTER TABLE restaurants ADD COLUMN coverage_scope TEXT NOT NULL DEFAULT 'Qualifying items found on the official menu'");
  }
  if (!columns.has("audited_at")) {
    database.exec("ALTER TABLE restaurants ADD COLUMN audited_at TEXT");
  }
  const itemColumns = new Set(database.prepare("PRAGMA table_info(menu_items)").all().map((column) => column.name));
  if (!itemColumns.has("last_verified_at")) {
    database.exec("ALTER TABLE menu_items ADD COLUMN last_verified_at TEXT");
  }
  if (!itemColumns.has("active")) {
    database.exec("ALTER TABLE menu_items ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  }
}

export function importSeed(database, seedPath = defaultSeedPath) {
  const catalog = JSON.parse(readFileSync(seedPath, "utf8"));
  database.exec("BEGIN IMMEDIATE");
  try {
    const upsertRestaurant = database.prepare(`
      INSERT INTO restaurants (
        id, name, neighborhood, address, latitude, longitude, menu_url, check_url,
        extraction_mode, verified_at, coverage_status, coverage_scope, audited_at,
        review_required
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        neighborhood = excluded.neighborhood,
        address = excluded.address,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        menu_url = excluded.menu_url,
        check_url = excluded.check_url,
        extraction_mode = excluded.extraction_mode,
        verified_at = excluded.verified_at,
        coverage_status = excluded.coverage_status,
        coverage_scope = excluded.coverage_scope,
        audited_at = excluded.audited_at
    `);
    const retireItems = database.prepare("UPDATE menu_items SET active = 0 WHERE restaurant_id = ?");
    const existingItem = database.prepare("SELECT * FROM menu_items WHERE id = ?");
    const upsertItem = database.prepare(`
      INSERT INTO menu_items (
        id, restaurant_id, name, description, price, dietary_status,
        modification_note, source_evidence, sort_order, last_verified_at, active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        restaurant_id = excluded.restaurant_id,
        name = excluded.name,
        description = excluded.description,
        price = excluded.price,
        dietary_status = excluded.dietary_status,
        modification_note = excluded.modification_note,
        source_evidence = excluded.source_evidence,
        sort_order = excluded.sort_order,
        last_verified_at = excluded.last_verified_at,
        active = 1
    `);
    const insertVersion = database.prepare(`
      INSERT INTO menu_item_versions (
        id, menu_item_id, restaurant_id, item_snapshot, recorded_at, change_kind
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const restaurant of catalog.restaurants) {
      upsertRestaurant.run(
        restaurant.id,
        restaurant.name,
        restaurant.neighborhood,
        restaurant.address,
        restaurant.latitude,
        restaurant.longitude,
        restaurant.menuURL,
        restaurant.checkURL ?? null,
        restaurant.extractionMode ?? "change_detection",
        restaurant.verifiedAt,
        restaurant.coverageStatus,
        restaurant.coverageScope,
        restaurant.auditedAt
      );
      const previouslyActive = new Set(database.prepare(
        "SELECT id FROM menu_items WHERE restaurant_id = ? AND active = 1"
      ).all(restaurant.id).map((row) => row.id));
      retireItems.run(restaurant.id);
      restaurant.menuItems.forEach((item, index) => {
        const previous = existingItem.get(item.id);
        const snapshot = JSON.stringify(canonicalItem(item));
        const previousSnapshot = previous ? JSON.stringify({
          id: previous.id,
          name: previous.name,
          description: previous.description,
          price: previous.price,
          dietaryStatus: previous.dietary_status,
          modificationNote: previous.modification_note,
          sourceEvidence: previous.source_evidence
        }) : null;
        upsertItem.run(
          item.id,
          restaurant.id,
          item.name,
          item.description,
          item.price,
          item.dietaryStatus,
          item.modificationNote ?? null,
          item.sourceEvidence ?? "",
          index,
          restaurant.auditedAt
        );
        previouslyActive.delete(item.id);
        if (!previous || previousSnapshot !== snapshot) {
          insertVersion.run(
            randomUUID(), item.id, restaurant.id, snapshot, restaurant.auditedAt,
            previous ? "updated" : "published"
          );
        }
      });
      for (const retiredID of previouslyActive) {
        const retired = existingItem.get(retiredID);
        insertVersion.run(
          randomUUID(), retiredID, restaurant.id, JSON.stringify(retired),
          restaurant.auditedAt, "retired"
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function catalogFromDatabase(database) {
  const restaurants = database.prepare(`
    SELECT id, name, neighborhood, address, latitude, longitude,
           menu_url, verified_at, coverage_status, coverage_scope, audited_at,
           last_checked_at
    FROM restaurants
    ORDER BY name COLLATE NOCASE
  `).all();
  const selectItems = database.prepare(`
    SELECT id, name, description, price, dietary_status, modification_note
    FROM menu_items
    WHERE restaurant_id = ? AND active = 1
    ORDER BY sort_order, name COLLATE NOCASE
  `);

  return {
    generatedAt: new Date().toISOString(),
    restaurants: restaurants.map((restaurant) => ({
      id: restaurant.id,
      name: restaurant.name,
      neighborhood: restaurant.neighborhood,
      address: restaurant.address,
      latitude: restaurant.latitude,
      longitude: restaurant.longitude,
      verifiedAt: restaurant.verified_at,
      menuURL: restaurant.menu_url,
      coverageStatus: restaurant.coverage_status,
      coverageScope: restaurant.coverage_scope,
      auditedAt: restaurant.audited_at ?? restaurant.verified_at,
      lastCheckedAt: restaurant.last_checked_at,
      menuItems: selectItems.all(restaurant.id).map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        price: item.price,
        dietaryStatus: item.dietary_status,
        modificationNote: item.modification_note
      }))
    }))
  };
}

export class SQLiteStore {
  constructor(database) {
    this.database = database;
  }

  async ensureSeeded() { ensureSeeded(this.database); }
  async importSeed() { importSeed(this.database); }
  async getCatalog() { return catalogFromDatabase(this.database); }
  async ping() { this.database.prepare("SELECT 1").get(); }

  async listCheckTargets() {
    return this.database.prepare(`
      SELECT id, name, COALESCE(check_url, menu_url) AS check_url, source_hash,
             extraction_mode
      FROM restaurants ORDER BY name COLLATE NOCASE
    `).all();
  }

  async recordCheckSuccess({ restaurantID, checkedAt, hash, normalizedSource, changed }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO menu_check_runs (id, restaurant_id, checked_at, status, source_hash)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), restaurantID, checkedAt, changed ? "changed" : "ok", hash);
      this.database.prepare(`
        INSERT OR IGNORE INTO menu_source_snapshots
          (id, restaurant_id, source_hash, normalized_source, captured_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), restaurantID, hash, normalizedSource, checkedAt);
      this.database.prepare(`
        UPDATE restaurants SET last_checked_at = ?, source_hash = ?,
          review_required = CASE WHEN ? THEN 1 ELSE review_required END,
          coverage_status = CASE WHEN ? THEN 'Needs review' ELSE coverage_status END,
          check_error = NULL WHERE id = ?
      `).run(checkedAt, hash, changed ? 1 : 0, changed ? 1 : 0, restaurantID);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async recordCheckFailure({ restaurantID, checkedAt, error }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO menu_check_runs (id, restaurant_id, checked_at, status, error)
        VALUES (?, ?, ?, 'failed', ?)
      `).run(randomUUID(), restaurantID, checkedAt, error);
      this.database.prepare(`
        UPDATE restaurants SET last_checked_at = ?, check_error = ?,
          coverage_status = 'Needs review' WHERE id = ?
      `).run(checkedAt, error, restaurantID);
      this.database.exec("COMMIT");
    } catch (failure) {
      this.database.exec("ROLLBACK");
      throw failure;
    }
  }

  async getReviewQueue() {
    return this.database.prepare(`
      SELECT id, name, menu_url AS menuURL, last_checked_at AS lastCheckedAt,
             check_error AS checkError FROM restaurants
      WHERE review_required = 1 OR check_error IS NOT NULL
      ORDER BY name COLLATE NOCASE
    `).all();
  }

  async runMenuCheckExclusive(operation) {
    if (this.checkRunning) return null;
    this.checkRunning = true;
    try {
      return await operation();
    } finally {
      this.checkRunning = false;
    }
  }

  async close() { this.database.close(); }
}

export function openSQLiteStore(path = defaultDatabasePath) {
  return new SQLiteStore(openDatabase(path));
}

function canonicalItem(item) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    price: item.price,
    dietaryStatus: item.dietaryStatus,
    modificationNote: item.modificationNote ?? null,
    sourceEvidence: item.sourceEvidence ?? ""
  };
}

export function ensureSeeded(database, seedPath = defaultSeedPath) {
  const row = database.prepare("SELECT COUNT(*) AS count FROM restaurants").get();
  if (row.count === 0) {
    importSeed(database, seedPath);
  }
}
