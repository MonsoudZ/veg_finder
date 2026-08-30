import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const defaultDatabasePath = resolve(serviceRoot, "data/vegfinder.sqlite");
export const defaultSeedPath = resolve(serviceRoot, "data/catalog.seed.json");

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
      sort_order INTEGER NOT NULL DEFAULT 0
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
    const deleteItems = database.prepare("DELETE FROM menu_items WHERE restaurant_id = ?");
    const insertItem = database.prepare(`
      INSERT INTO menu_items (
        id, restaurant_id, name, description, price, dietary_status,
        modification_note, source_evidence, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      deleteItems.run(restaurant.id);
      restaurant.menuItems.forEach((item, index) => {
        insertItem.run(
          item.id,
          restaurant.id,
          item.name,
          item.description,
          item.price,
          item.dietaryStatus,
          item.modificationNote ?? null,
          item.sourceEvidence ?? "",
          index
        );
      });
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
           menu_url, verified_at, coverage_status, coverage_scope, audited_at
    FROM restaurants
    ORDER BY name COLLATE NOCASE
  `).all();
  const selectItems = database.prepare(`
    SELECT id, name, description, price, dietary_status, modification_note
    FROM menu_items
    WHERE restaurant_id = ?
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

export function ensureSeeded(database, seedPath = defaultSeedPath) {
  const row = database.prepare("SELECT COUNT(*) AS count FROM restaurants").get();
  if (row.count === 0) {
    importSeed(database, seedPath);
  }
}
