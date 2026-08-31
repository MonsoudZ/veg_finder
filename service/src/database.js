import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { defaultDatabasePath, defaultSeedPath } from "./paths.js";
import { boundingBox, decodeCursor, distanceKm, encodeCursor } from "./geo.js";

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
      check_error TEXT,
      updated_at TEXT
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
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT
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

    CREATE INDEX IF NOT EXISTS restaurants_updated_at ON restaurants(updated_at, id);
    CREATE INDEX IF NOT EXISTS restaurants_name_id ON restaurants(name, id);
    CREATE INDEX IF NOT EXISTS restaurants_location ON restaurants(latitude, longitude);
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
  if (!columns.has("updated_at")) {
    database.exec("ALTER TABLE restaurants ADD COLUMN updated_at TEXT");
    database.exec("UPDATE restaurants SET updated_at = COALESCE(audited_at, verified_at)");
  }
  const itemColumns = new Set(database.prepare("PRAGMA table_info(menu_items)").all().map((column) => column.name));
  if (!itemColumns.has("last_verified_at")) {
    database.exec("ALTER TABLE menu_items ADD COLUMN last_verified_at TEXT");
  }
  if (!itemColumns.has("active")) {
    database.exec("ALTER TABLE menu_items ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  }
  if (!itemColumns.has("updated_at")) {
    database.exec("ALTER TABLE menu_items ADD COLUMN updated_at TEXT");
    database.exec("UPDATE menu_items SET updated_at = last_verified_at");
  }
}

// Replaces a restaurant's published menu and records what changed. Retires every
// existing item first, then re-activates the incoming ones, so an empty list
// correctly unpublishes everything rather than leaving stale claims live.
// Must be called inside a transaction.
export function publishMenu(database, restaurantID, items, recordedAt) {
  const previouslyActive = new Set(database.prepare(
    "SELECT id FROM menu_items WHERE restaurant_id = ? AND active = 1"
  ).all(restaurantID).map((row) => row.id));
  const existingItem = database.prepare("SELECT * FROM menu_items WHERE id = ?");
  const insertVersion = database.prepare(`
    INSERT INTO menu_item_versions (
      id, menu_item_id, restaurant_id, item_snapshot, recorded_at, change_kind
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  database.prepare("UPDATE menu_items SET active = 0 WHERE restaurant_id = ?").run(restaurantID);
  const upsertItem = database.prepare(`
    INSERT INTO menu_items (
      id, restaurant_id, name, description, price, dietary_status,
      modification_note, source_evidence, sort_order, last_verified_at, active,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
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
      updated_at = excluded.updated_at,
      active = 1
  `);

  items.forEach((item, index) => {
    const previous = existingItem.get(item.id);
    const snapshot = JSON.stringify(canonicalItem(item));
    const previousSnapshot = previous ? JSON.stringify(canonicalDatabaseItem(previous)) : null;
    upsertItem.run(
      item.id, restaurantID, item.name, item.description, item.price,
      item.dietaryStatus, item.modificationNote ?? null, item.sourceEvidence ?? "",
      index, recordedAt, recordedAt
    );
    previouslyActive.delete(item.id);
    if (!previous || previousSnapshot !== snapshot) {
      insertVersion.run(
        randomUUID(), item.id, restaurantID, snapshot, recordedAt,
        previous ? "updated" : "published"
      );
    }
  });

  for (const retiredID of previouslyActive) {
    insertVersion.run(
      randomUUID(), retiredID, restaurantID,
      JSON.stringify(canonicalDatabaseItem(existingItem.get(retiredID))), recordedAt, "retired"
    );
  }
}

function canonicalDatabaseItem(item) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    price: item.price,
    dietaryStatus: item.dietary_status,
    modificationNote: item.modification_note,
    sourceEvidence: item.source_evidence
  };
}

// SQLite compares timestamps as text, so every stored value must use one format.
// "2026-08-30T00:00:00Z" and "2026-08-30T00:00:00.000Z" are the same instant but
// sort in the wrong order against each other, which silently broke delta sync.
function canonicalTimestamp(value) {
  if (value == null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return parsed.toISOString();
}

export function importSeed(database, seedPath = defaultSeedPath) {
  const catalog = JSON.parse(readFileSync(seedPath, "utf8"));
  database.exec("BEGIN IMMEDIATE");
  try {
    const upsertRestaurant = database.prepare(`
      INSERT INTO restaurants (
        id, name, neighborhood, address, latitude, longitude, menu_url, check_url,
        extraction_mode, verified_at, coverage_status, coverage_scope, audited_at,
        review_required, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
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
        coverage_scope = excluded.coverage_scope,
        audited_at = excluded.audited_at,
        updated_at = excluded.updated_at,
        -- Mirrors the PostgreSQL upsert: only a fresh audit clears a review the
        -- checker raised. Timestamps are stored as ISO-8601 UTC text, so ordering
        -- them lexicographically orders them chronologically.
        coverage_status = CASE
          WHEN excluded.coverage_status = 'Needs review' THEN 'Needs review'
          WHEN restaurants.audited_at IS NULL
            OR excluded.audited_at > restaurants.audited_at THEN excluded.coverage_status
          ELSE restaurants.coverage_status
        END,
        review_required = CASE
          WHEN excluded.coverage_status = 'Needs review' THEN 1
          WHEN restaurants.audited_at IS NULL
            OR excluded.audited_at > restaurants.audited_at THEN 0
          ELSE restaurants.review_required
        END,
        check_error = CASE
          WHEN restaurants.audited_at IS NULL
            OR excluded.audited_at > restaurants.audited_at THEN NULL
          ELSE restaurants.check_error
        END
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
        canonicalTimestamp(restaurant.verifiedAt),
        restaurant.coverageStatus,
        restaurant.coverageScope,
        canonicalTimestamp(restaurant.auditedAt),
        canonicalTimestamp(restaurant.auditedAt)
      );
      publishMenu(
        database, restaurant.id, restaurant.menuItems, canonicalTimestamp(restaurant.auditedAt)
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function publicRestaurant(row, items) {
  return {
    id: row.id,
    name: row.name,
    neighborhood: row.neighborhood,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    verifiedAt: row.verified_at,
    menuURL: row.menu_url,
    coverageStatus: row.coverage_status,
    coverageScope: row.coverage_scope,
    auditedAt: row.audited_at ?? row.verified_at,
    lastCheckedAt: row.last_checked_at,
    updatedAt: row.updated_at ?? row.verified_at,
    menuItems: items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      dietaryStatus: item.dietary_status,
      modificationNote: item.modification_note
    }))
  };
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

  // Both forward the seed path so this store honours the same call signature as
  // PostgresStore; dropping it silently imported the default seed instead.
  async ensureSeeded(seedPath) { ensureSeeded(this.database, seedPath); }
  async importSeed(seedPath) { importSeed(this.database, seedPath); }
  async getCatalog() { return catalogFromDatabase(this.database); }

  async getRestaurant(id) {
    const page = await this.getCatalogPage({ ids: [id], limit: 1 });
    return page.restaurants[0] ?? null;
  }

  // One read path behind three query modes: nearby (ranked by distance), delta
  // (everything changed since a watermark), and a plain paged listing.
  async getCatalogPage({ latitude, longitude, radiusKm, since, cursor, limit = 100, ids } = {}) {
    const conditions = [];
    const parameters = [];

    if (ids) {
      conditions.push(`id IN (${ids.map(() => "?").join(", ")})`);
      parameters.push(...ids);
    }
    if (since) {
      conditions.push("COALESCE(updated_at, verified_at) > ?");
      parameters.push(since);
    }
    if (latitude != null && longitude != null) {
      const box = boundingBox(latitude, longitude, radiusKm);
      conditions.push("latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?");
      parameters.push(box.minLatitude, box.maxLatitude, box.minLongitude, box.maxLongitude);
    }

    const resume = decodeCursor(cursor);
    if (resume?.updatedAt) {
      conditions.push("(COALESCE(updated_at, verified_at), id) > (?, ?)");
      parameters.push(resume.updatedAt, resume.id);
    } else if (resume?.name) {
      conditions.push("(name, id) > (?, ?)");
      parameters.push(resume.name, resume.id);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = since ? "COALESCE(updated_at, verified_at), id" : "name COLLATE NOCASE, id";
    // Nearby ranking happens after the box filter, so read the whole box.
    const sql = `
      SELECT id, name, neighborhood, address, latitude, longitude, menu_url,
             verified_at, coverage_status, coverage_scope, audited_at,
             last_checked_at, COALESCE(updated_at, verified_at) AS updated_at
      FROM restaurants ${where} ORDER BY ${order}
      ${latitude == null ? "LIMIT ?" : ""}
    `;
    if (latitude == null) parameters.push(limit + 1);
    let rows = this.database.prepare(sql).all(...parameters);

    let nextCursor = null;
    if (latitude != null && longitude != null) {
      rows = rows
        .map((row) => ({ row, distanceKm: distanceKm(latitude, longitude, row.latitude, row.longitude) }))
        .filter((entry) => entry.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit)
        .map((entry) => entry.row);
    } else if (rows.length > limit) {
      rows = rows.slice(0, limit);
      const last = rows[rows.length - 1];
      nextCursor = encodeCursor(
        since ? { updatedAt: last.updated_at, id: last.id } : { name: last.name, id: last.id }
      );
    }

    const selectItems = this.database.prepare(`
      SELECT id, name, description, price, dietary_status, modification_note
      FROM menu_items WHERE restaurant_id = ? AND active = 1
      ORDER BY sort_order, name COLLATE NOCASE
    `);
    const restaurants = rows.map((row) => publicRestaurant(row, selectItems.all(row.id)));

    return {
      generatedAt: new Date().toISOString(),
      syncedAt: rows.length ? rows[rows.length - 1].updated_at : (since ?? null),
      restaurants,
      nextCursor
    };
  }

  // Admin write path. A new restaurant is unaudited by definition, so it lands in
  // the review queue with no published items rather than appearing in the app.
  async upsertRestaurant(record) {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existed = Boolean(
        this.database.prepare("SELECT 1 FROM restaurants WHERE id = ?").get(record.id)
      );
      this.database.prepare(`
        INSERT INTO restaurants (
          id, name, neighborhood, address, latitude, longitude, menu_url, check_url,
          extraction_mode, verified_at, coverage_status, coverage_scope, audited_at,
          review_required, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Needs review', ?, NULL, 1, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          neighborhood = excluded.neighborhood,
          address = excluded.address,
          latitude = excluded.latitude,
          longitude = excluded.longitude,
          menu_url = excluded.menu_url,
          check_url = excluded.check_url,
          extraction_mode = excluded.extraction_mode,
          coverage_scope = excluded.coverage_scope,
          updated_at = excluded.updated_at
      `).run(
        record.id, record.name, record.neighborhood, record.address,
        record.latitude, record.longitude, record.menuURL, record.checkURL,
        record.extractionMode, now, record.coverageScope, now
      );
      this.database.exec("COMMIT");
      return { created: !existed };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  // Publishing a reconciled menu *is* the audit, so this is the one operation that
  // advances audited_at and clears the review the checker raised.
  async reconcileRestaurant(id, { coverageStatus, coverageScope, menuItems }) {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 FROM restaurants WHERE id = ?").get(id)) {
        this.database.exec("ROLLBACK");
        return null;
      }
      publishMenu(this.database, id, menuItems, now);
      this.database.prepare(`
        UPDATE restaurants SET
          coverage_status = ?,
          coverage_scope = COALESCE(?, coverage_scope),
          audited_at = ?,
          updated_at = ?,
          review_required = CASE WHEN ? = 'Needs review' THEN 1 ELSE 0 END,
          check_error = NULL
        WHERE id = ?
      `).run(coverageStatus, coverageScope ?? null, now, now, coverageStatus, id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getRestaurant(id);
  }
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
