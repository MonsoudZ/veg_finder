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
      menu_url TEXT,
      check_url TEXT,
      claim_url TEXT,
      extraction_mode TEXT NOT NULL DEFAULT 'change_detection',
      verified_at TEXT NOT NULL,
      coverage_status TEXT NOT NULL DEFAULT 'Needs review',
      coverage_scope TEXT NOT NULL DEFAULT 'Qualifying items found on the official menu',
      audited_at TEXT,
      last_checked_at TEXT,
      source_hash TEXT,
      review_required INTEGER NOT NULL DEFAULT 0,
      check_error TEXT,
      updated_at TEXT,
      menu_profile TEXT NOT NULL DEFAULT 'unknown',
      verification_method TEXT NOT NULL DEFAULT 'official_url'
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      -- Nullable: see migrations/011. A menu that publishes no price is a fact
      -- about the menu, not a missing field.
      price TEXT,
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
      -- The hash this run replaced. See migrations/010: it is the only reliable
      -- record of which state a change actually moved away from, because
      -- snapshots dedupe by hash and so cannot be ordered by when they were live.
      previous_source_hash TEXT,
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

    CREATE TABLE IF NOT EXISTS menu_item_proposals (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      proposed_at TEXT NOT NULL,
      tier TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      item TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected')),
      decided_at TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS menu_item_versions (
      id TEXT PRIMARY KEY,
      menu_item_id TEXT NOT NULL,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      item_snapshot TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      change_kind TEXT NOT NULL CHECK (change_kind IN ('published', 'updated', 'retired'))
    );

    -- One reading of one changed source, and the differences it found from what
    -- is published. Mirrors migrations/009. Distinct from menu_item_proposals
    -- above, which drafts a menu that has none published yet; this describes
    -- what moved since the last time a person agreed to one.
    CREATE TABLE IF NOT EXISTS menu_change_proposals (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      source_snapshot_id TEXT REFERENCES menu_source_snapshots(id) ON DELETE SET NULL,
      previous_snapshot_id TEXT REFERENCES menu_source_snapshots(id) ON DELETE SET NULL,
      tier TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected')),
      ambiguities TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS menu_change_operations (
      id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL REFERENCES menu_change_proposals(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      operation TEXT NOT NULL CHECK (operation IN ('add', 'update', 'retire')),
      menu_item_id TEXT,
      proposed_name TEXT,
      proposed_description TEXT,
      proposed_price TEXT,
      proposed_dietary_status TEXT,
      proposed_modification_note TEXT,
      evidence TEXT NOT NULL DEFAULT '',
      current_item TEXT,
      changed_fields TEXT NOT NULL DEFAULT '[]',
      confidence TEXT NOT NULL DEFAULT 'medium'
        CHECK (confidence IN ('high', 'medium', 'low')),
      decision TEXT NOT NULL DEFAULT 'pending'
        CHECK (decision IN ('pending', 'applied', 'skipped'))
    );

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
  if (!columns.has("verification_method")) {
    database.exec(
      "ALTER TABLE restaurants ADD COLUMN verification_method TEXT NOT NULL DEFAULT 'official_url'"
    );
  }
  // Older development databases declared menu_url NOT NULL, which blocks
  // restaurants that have no menu online. SQLite cannot drop a constraint, so
  // the table is rebuilt once.
  const menuURLColumn = database.prepare("PRAGMA table_info(restaurants)").all()
    .find((column) => column.name === "menu_url");
  if (menuURLColumn?.notnull === 1) {
    const legacyColumns = database.prepare("PRAGMA table_info(restaurants)").all()
      .map((column) => column.name);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("ALTER TABLE restaurants RENAME TO restaurants_legacy");
    migrate(database);
    const carried = database.prepare("PRAGMA table_info(restaurants)").all()
      .map((column) => column.name)
      .filter((column) => legacyColumns.includes(column))
      .join(", ");
    database.exec(`INSERT INTO restaurants (${carried}) SELECT ${carried} FROM restaurants_legacy`);
    database.exec("DROP TABLE restaurants_legacy");
    database.exec("PRAGMA foreign_keys = ON");
    return;
  }
  if (!columns.has("claim_url")) {
    database.exec("ALTER TABLE restaurants ADD COLUMN claim_url TEXT");
  }
  if (!columns.has("menu_profile")) {
    database.exec("ALTER TABLE restaurants ADD COLUMN menu_profile TEXT NOT NULL DEFAULT 'unknown'");
  }
  if (!columns.has("updated_at")) {
    database.exec("ALTER TABLE restaurants ADD COLUMN updated_at TEXT");
    database.exec("UPDATE restaurants SET updated_at = COALESCE(audited_at, verified_at)");
  }
  const checkRunColumns = new Set(
    database.prepare("PRAGMA table_info(menu_check_runs)").all().map((column) => column.name)
  );
  if (!checkRunColumns.has("previous_source_hash")) {
    // Left NULL for runs recorded before this column existed. A proposal against
    // one of those has no recorded transition and says so, rather than guessing.
    database.exec("ALTER TABLE menu_check_runs ADD COLUMN previous_source_hash TEXT");
  }
  // Older development databases declared price NOT NULL. SQLite cannot drop a
  // constraint, so the table is rebuilt once — the same treatment restaurants
  // got when menu_url stopped being required.
  const priceColumn = database.prepare("PRAGMA table_info(menu_items)").all()
    .find((column) => column.name === "price");
  if (priceColumn?.notnull === 1) {
    const legacyColumns = database.prepare("PRAGMA table_info(menu_items)").all()
      .map((column) => column.name);
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("ALTER TABLE menu_items RENAME TO menu_items_legacy");
    migrate(database);
    const carried = database.prepare("PRAGMA table_info(menu_items)").all()
      .map((column) => column.name)
      .filter((column) => legacyColumns.includes(column))
      .join(", ");
    database.exec(`INSERT INTO menu_items (${carried}) SELECT ${carried} FROM menu_items_legacy`);
    database.exec("DROP TABLE menu_items_legacy");
    database.exec("PRAGMA foreign_keys = ON");
    return;
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

  // Last: every column these reference is guaranteed to exist by now.
  database.exec(`
    CREATE INDEX IF NOT EXISTS menu_items_restaurant ON menu_items(restaurant_id, sort_order);
    CREATE INDEX IF NOT EXISTS restaurants_updated_at ON restaurants(updated_at, id);
    CREATE INDEX IF NOT EXISTS restaurants_name_id ON restaurants(name, id);
    CREATE INDEX IF NOT EXISTS restaurants_location ON restaurants(latitude, longitude);
    CREATE INDEX IF NOT EXISTS menu_item_proposals_restaurant
      ON menu_item_proposals(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS menu_item_proposals_pending
      ON menu_item_proposals(status, proposed_at);
    CREATE INDEX IF NOT EXISTS menu_change_proposals_pending
      ON menu_change_proposals(status, created_at);
    CREATE INDEX IF NOT EXISTS menu_change_proposals_restaurant
      ON menu_change_proposals(restaurant_id, status);
    CREATE INDEX IF NOT EXISTS menu_change_operations_proposal
      ON menu_change_operations(proposal_id, position);
  `);
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
        claim_url, extraction_mode, verified_at, coverage_status, coverage_scope,
        audited_at, review_required, updated_at, menu_profile, verification_method
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        neighborhood = excluded.neighborhood,
        address = excluded.address,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        menu_url = excluded.menu_url,
        check_url = excluded.check_url,
        claim_url = excluded.claim_url,
        extraction_mode = excluded.extraction_mode,
        -- The seed is the operator's declared catalog, so it is authoritative
        -- for these the same way it already is for the address and the menu URL.
        menu_profile = excluded.menu_profile,
        verification_method = excluded.verification_method,
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
        restaurant.claimURL ?? null,
        restaurant.extractionMode ?? "change_detection",
        canonicalTimestamp(restaurant.verifiedAt),
        restaurant.coverageStatus,
        restaurant.coverageScope,
        canonicalTimestamp(restaurant.auditedAt),
        canonicalTimestamp(restaurant.auditedAt),
        restaurant.menuProfile ?? "unknown",
        restaurant.verificationMethod ?? "official_url"
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

export function proposalRow(row) {
  return {
    id: row.id,
    restaurantID: row.restaurant_id,
    restaurantName: row.restaurant_name,
    proposedAt: row.proposed_at,
    tier: row.tier,
    status: row.status,
    decidedAt: row.decided_at,
    note: row.note,
    item: JSON.parse(row.item)
  };
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
    menuProfile: row.menu_profile ?? "unknown",
    verificationMethod: row.verification_method ?? "official_url",
    menuItems: items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price ?? null,
      // Derived rather than stored, so the two can never disagree. Absent means
      // this menu does not publish one, which is a fact worth stating to a diner
      // instead of showing an empty gap.
      priceStatus: item.price == null ? "unavailable" : "listed",
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
        price: item.price ?? null,
        priceStatus: item.price == null ? "unavailable" : "listed",
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

    const geographic = latitude != null && longitude != null;
    // Distance ranking reads the whole bounding box, so it cannot be paged. A
    // delta always pages, even when scoped to a radius — otherwise a client
    // syncing more changes than one page silently loses the rest.
    const rankByDistance = geographic && !since;

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = since ? "COALESCE(updated_at, verified_at), id" : "name COLLATE NOCASE, id";
    const sql = `
      SELECT id, name, neighborhood, address, latitude, longitude, menu_url,
             verified_at, coverage_status, coverage_scope, audited_at,
             last_checked_at, COALESCE(updated_at, verified_at) AS updated_at,
             menu_profile, verification_method
      FROM restaurants ${where} ORDER BY ${order}
      ${rankByDistance ? "" : "LIMIT ?"}
    `;
    if (!rankByDistance) parameters.push(limit + 1);
    const fetched = this.database.prepare(sql).all(...parameters);

    let examined = fetched;
    let nextCursor = null;
    if (rankByDistance) {
      examined = fetched
        .map((row) => ({ row, distanceKm: distanceKm(latitude, longitude, row.latitude, row.longitude) }))
        .filter((entry) => entry.distanceKm <= radiusKm)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(0, limit)
        .map((entry) => entry.row);
    } else if (fetched.length > limit) {
      examined = fetched.slice(0, limit);
      const last = examined[examined.length - 1];
      nextCursor = encodeCursor(
        since ? { updatedAt: last.updated_at, id: last.id } : { name: last.name, id: last.id }
      );
    }

    // The watermark covers everything examined, including records the radius
    // filter drops — they have been seen and need not be sent again.
    const watermark = examined.reduce(
      (latest, row) => (latest === null || row.updated_at > latest ? row.updated_at : latest), null
    );
    const rows = rankByDistance
      ? examined
      : examined.filter((row) => !geographic
          || distanceKm(latitude, longitude, row.latitude, row.longitude) <= radiusKm);

    const selectItems = this.database.prepare(`
      SELECT id, name, description, price, dietary_status, modification_note
      FROM menu_items WHERE restaurant_id = ? AND active = 1
      ORDER BY sort_order, name COLLATE NOCASE
    `);
    const restaurants = rows.map((row) => publicRestaurant(row, selectItems.all(row.id)));

    return {
      generatedAt: new Date().toISOString(),
      syncedAt: watermark ?? since ?? null,
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
          claim_url, extraction_mode, verified_at, coverage_status, coverage_scope,
          audited_at, review_required, updated_at, menu_profile, verification_method
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Needs review', ?, NULL, 1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          neighborhood = excluded.neighborhood,
          address = excluded.address,
          latitude = excluded.latitude,
          longitude = excluded.longitude,
          menu_url = excluded.menu_url,
          check_url = excluded.check_url,
          claim_url = excluded.claim_url,
          extraction_mode = excluded.extraction_mode,
          coverage_scope = excluded.coverage_scope,
          updated_at = excluded.updated_at,
          menu_profile = excluded.menu_profile,
          verification_method = excluded.verification_method
      `).run(
        record.id, record.name, record.neighborhood, record.address,
        record.latitude, record.longitude, record.menuURL, record.checkURL,
        record.claimURL, record.extractionMode, now, record.coverageScope, now,
        record.menuProfile,
        record.verificationMethod
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

  // A fresh draft supersedes whatever was still pending for that restaurant;
  // decisions already made are history and are left alone.
  async saveProposals(restaurantID, { tier, items, proposedAt = new Date().toISOString() }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "DELETE FROM menu_item_proposals WHERE restaurant_id = ? AND status = 'pending'"
      ).run(restaurantID);
      const insert = this.database.prepare(`
        INSERT INTO menu_item_proposals (id, restaurant_id, proposed_at, tier, position, item, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `);
      items.forEach((item, position) => {
        insert.run(randomUUID(), restaurantID, proposedAt, tier, position, JSON.stringify(item));
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { saved: items.length };
  }

  async listProposals({ restaurantID, status } = {}) {
    const where = ["1 = 1"];
    const parameters = [];
    if (restaurantID) { where.push("p.restaurant_id = ?"); parameters.push(restaurantID); }
    if (status) { where.push("p.status = ?"); parameters.push(status); }
    return this.database.prepare(`
      SELECT p.id, p.restaurant_id, p.proposed_at, p.tier, p.item, p.status, p.decided_at,
             p.note, r.name AS restaurant_name
      FROM menu_item_proposals p JOIN restaurants r ON r.id = p.restaurant_id
      WHERE ${where.join(" AND ")}
      ORDER BY r.name COLLATE NOCASE, p.proposed_at, p.position, p.id
    `).all(...parameters).map(proposalRow);
  }

  async decideProposal(id, { status, note = null }) {
    const result = this.database.prepare(`
      UPDATE menu_item_proposals SET status = ?, note = ?, decided_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(status, note, new Date().toISOString(), id);
    return result.changes > 0;
  }

  // --- Change proposals -----------------------------------------------------
  // A detected change becomes a description of what changed, and only a person
  // turns that description into published data. Everything below reads and
  // writes proposals; only acceptChangeProposal touches menu_items.

  async getPublishedItems(restaurantID) {
    return this.database.prepare(`
      SELECT id, name, description, price, dietary_status, modification_note, source_evidence
      FROM menu_items WHERE restaurant_id = ? AND active = 1
      ORDER BY sort_order, name COLLATE NOCASE
    `).all(restaurantID).map(canonicalDatabaseItem);
  }

  async ensureSnapshot({ restaurantID, hash, normalizedSource, capturedAt }) {
    this.database.prepare(`
      INSERT OR IGNORE INTO menu_source_snapshots
        (id, restaurant_id, source_hash, normalized_source, captured_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), restaurantID, hash, normalizedSource, capturedAt);
    return this.database.prepare(
      "SELECT id FROM menu_source_snapshots WHERE restaurant_id = ? AND source_hash = ?"
    ).get(restaurantID, hash)?.id ?? null;
  }

  // The state the source was in before the reading a proposal was computed from.
  //
  // This cannot be inferred from the snapshots table. Snapshots dedupe by hash
  // and keep their first capture time, so for A → B → A → C the most recently
  // captured snapshot before C is B, while the state C actually replaced was A.
  // The transition is read from where it was recorded at detection time instead.
  async priorSnapshotID(restaurantID, currentHash) {
    const live = this.database.prepare(
      "SELECT source_hash FROM restaurants WHERE id = ?"
    ).get(restaurantID)?.source_hash ?? null;

    // Two cases. Normally a proposal reads the same source the last check
    // fingerprinted, so what came before it is that check's recorded previous
    // hash. If the page moved again between the check and this reading, the
    // fingerprint the checker last stored *is* the state this reading replaces.
    const priorHash = live && live !== currentHash
      ? live
      : this.database.prepare(`
          SELECT previous_source_hash FROM menu_check_runs
          WHERE restaurant_id = ? AND status = 'changed' AND previous_source_hash IS NOT NULL
          ORDER BY checked_at DESC, rowid DESC LIMIT 1
        `).get(restaurantID)?.previous_source_hash ?? null;

    // No recorded transition, or the source came back to where it started.
    // Showing a before that equals the after would read as a change that is not
    // one; saying nothing is recorded is the honest answer.
    if (!priorHash || priorHash === currentHash) return null;
    return this.database.prepare(
      "SELECT id FROM menu_source_snapshots WHERE restaurant_id = ? AND source_hash = ?"
    ).get(restaurantID, priorHash)?.id ?? null;
  }

  // A fresh reading supersedes whatever was still pending for that restaurant.
  // Two pending proposals against the same menu would let a reviewer accept a
  // stale diff over a current one.
  async createChangeProposal({
    restaurantID, sourceSnapshotID, previousSnapshotID, tier, ambiguities = [],
    operations = [], createdAt = new Date().toISOString(), note = null
  }) {
    const id = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "DELETE FROM menu_change_proposals WHERE restaurant_id = ? AND status = 'pending'"
      ).run(restaurantID);
      this.database.prepare(`
        INSERT INTO menu_change_proposals (
          id, restaurant_id, source_snapshot_id, previous_snapshot_id, tier, status,
          ambiguities, created_at, note
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        id, restaurantID, sourceSnapshotID, previousSnapshotID, tier,
        JSON.stringify(ambiguities), createdAt, note
      );
      const insert = this.database.prepare(`
        INSERT INTO menu_change_operations (
          id, proposal_id, position, operation, menu_item_id, proposed_name,
          proposed_description, proposed_price, proposed_dietary_status,
          proposed_modification_note, evidence, current_item, changed_fields, confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      operations.forEach((operation, index) => {
        insert.run(
          randomUUID(), id, operation.position ?? index, operation.operation,
          operation.menuItemID ?? null,
          operation.proposed?.name ?? null,
          operation.proposed?.description ?? null,
          operation.proposed?.price ?? null,
          operation.proposed?.dietaryStatus ?? null,
          operation.proposed?.modificationNote ?? null,
          operation.evidence ?? "",
          operation.current ? JSON.stringify(operation.current) : null,
          JSON.stringify(operation.changedFields ?? []),
          operation.confidence ?? "medium"
        );
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return id;
  }

  async listChangeProposals({ restaurantID, status } = {}) {
    const where = ["1 = 1"];
    const parameters = [];
    if (restaurantID) { where.push("p.restaurant_id = ?"); parameters.push(restaurantID); }
    if (status) { where.push("p.status = ?"); parameters.push(status); }
    return this.database.prepare(`
      SELECT p.*, r.name AS restaurant_name, r.menu_url,
             (SELECT COUNT(*) FROM menu_change_operations o WHERE o.proposal_id = p.id)
               AS operation_count
      FROM menu_change_proposals p JOIN restaurants r ON r.id = p.restaurant_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.created_at DESC, r.name COLLATE NOCASE
    `).all(...parameters).map(changeProposalRow);
  }

  async getChangeProposal(id) {
    const row = this.database.prepare(`
      SELECT p.*, r.name AS restaurant_name, r.menu_url,
             (SELECT COUNT(*) FROM menu_change_operations o WHERE o.proposal_id = p.id)
               AS operation_count
      FROM menu_change_proposals p JOIN restaurants r ON r.id = p.restaurant_id
      WHERE p.id = ?
    `).get(id);
    if (!row) return null;

    const operations = this.database.prepare(
      "SELECT * FROM menu_change_operations WHERE proposal_id = ? ORDER BY position, id"
    ).all(id).map(changeOperationRow);
    const snapshot = this.database.prepare(
      "SELECT id, source_hash, normalized_source, captured_at FROM menu_source_snapshots WHERE id = ?"
    );
    return {
      ...changeProposalRow(row),
      operations,
      newSource: snapshotRow(row.source_snapshot_id ? snapshot.get(row.source_snapshot_id) : null),
      oldSource: snapshotRow(row.previous_snapshot_id ? snapshot.get(row.previous_snapshot_id) : null),
      published: await this.getPublishedItems(row.restaurant_id)
    };
  }

  async rejectChangeProposal(id, { reviewedBy = null, note = null } = {}) {
    const result = this.database.prepare(`
      UPDATE menu_change_proposals
      SET status = 'rejected', reviewed_at = ?, reviewed_by = ?, note = COALESCE(?, note)
      WHERE id = ? AND status = 'pending'
    `).run(new Date().toISOString(), reviewedBy, note, id);
    if (result.changes > 0) return { status: "rejected" };
    return { status: this.changeProposalExists(id) ? "conflict" : "missing" };
  }

  changeProposalExists(id) {
    return Boolean(this.database.prepare("SELECT 1 FROM menu_change_proposals WHERE id = ?").get(id));
  }

  // Publishing a reviewed diff, in one transaction. Either every accepted
  // operation lands with its version history and the restaurant's audit
  // advances, or nothing does — a half-applied menu is a menu that lies.
  async acceptChangeProposal(id, {
    reviewedBy = null, operationIDs = null, note = null, coverageStatus = "Complete"
  } = {}) {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const proposal = this.database.prepare(
        "SELECT * FROM menu_change_proposals WHERE id = ?"
      ).get(id);
      if (!proposal) {
        this.database.exec("ROLLBACK");
        return { status: "missing" };
      }
      // Checked inside the transaction, not before it: two reviewers clicking
      // accept at the same moment must not both publish.
      if (proposal.status !== "pending") {
        this.database.exec("ROLLBACK");
        return { status: "conflict" };
      }

      const operations = this.database.prepare(
        "SELECT * FROM menu_change_operations WHERE proposal_id = ? ORDER BY position, id"
      ).all(id);
      const chosen = operationIDs === null
        ? new Set(operations.map((operation) => operation.id))
        : new Set(operationIDs);
      const unknown = [...chosen].filter(
        (operationID) => !operations.some((operation) => operation.id === operationID)
      );
      // An id that belongs to another proposal means the caller is working from
      // a stale page. Applying the subset it did recognise would publish
      // something nobody chose.
      if (unknown.length > 0) {
        this.database.exec("ROLLBACK");
        return { status: "unknown_operations", unknown };
      }

      const applied = applyChangeOperations(
        this.database, proposal.restaurant_id,
        operations.filter((operation) => chosen.has(operation.id)), now
      );

      for (const operation of operations) {
        this.database.prepare("UPDATE menu_change_operations SET decision = ? WHERE id = ?")
          .run(chosen.has(operation.id) ? "applied" : "skipped", operation.id);
      }

      // Reviewing a diff against the official source *is* an audit, so this
      // advances audited_at and clears the review the checker raised — the same
      // rule reconcileRestaurant follows. A reviewer who is not satisfied can
      // accept the safe operations and keep the restaurant in the queue by
      // passing coverageStatus 'Needs review'.
      this.database.prepare(`
        UPDATE restaurants SET
          coverage_status = ?, audited_at = ?, updated_at = ?,
          review_required = CASE WHEN ? = 'Needs review' THEN 1 ELSE 0 END,
          check_error = NULL
        WHERE id = ?
      `).run(coverageStatus, now, now, coverageStatus, proposal.restaurant_id);

      this.database.prepare(`
        UPDATE menu_change_proposals
        SET status = 'accepted', reviewed_at = ?, reviewed_by = ?, note = COALESCE(?, note)
        WHERE id = ?
      `).run(now, reviewedBy, note, id);

      this.database.exec("COMMIT");
      return {
        status: "accepted", restaurantID: proposal.restaurant_id,
        applied: applied.length, skipped: operations.length - applied.length
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async getCheckTarget(id) {
    return this.database.prepare(`
      SELECT id, name, COALESCE(check_url, menu_url) AS check_url, claim_url, source_hash,
             extraction_mode, menu_profile, verification_method, audited_at
      FROM restaurants WHERE id = ?
    `).get(id) ?? null;
  }

  async listCheckTargets() {
    return this.database.prepare(`
      SELECT id, name, COALESCE(check_url, menu_url) AS check_url, claim_url, source_hash,
             extraction_mode, menu_profile, verification_method, audited_at
      FROM restaurants ORDER BY name COLLATE NOCASE
    `).all();
  }

  async recordCheckSuccess({ restaurantID, checkedAt, hash, normalizedSource, changed }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      // Read inside the transaction that replaces it, so what is recorded as the
      // previous hash is exactly the value this run overwrote.
      const previousHash = this.database.prepare(
        "SELECT source_hash FROM restaurants WHERE id = ?"
      ).get(restaurantID)?.source_hash ?? null;
      this.database.prepare(`
        INSERT INTO menu_check_runs
          (id, restaurant_id, checked_at, status, source_hash, previous_source_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), restaurantID, checkedAt, changed ? "changed" : "ok", hash, previousHash
      );
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

// Applies the operations a reviewer accepted, and records each one in the item's
// version history. Unlike publishMenu this is *incremental*: a dish nobody
// proposed a change to is left exactly as it is, because the diff only claims to
// describe what moved. Must be called inside a transaction.
function applyChangeOperations(database, restaurantID, operations, recordedAt) {
  const existing = database.prepare("SELECT * FROM menu_items WHERE id = ? AND restaurant_id = ?");
  const insertVersion = database.prepare(`
    INSERT INTO menu_item_versions (
      id, menu_item_id, restaurant_id, item_snapshot, recorded_at, change_kind
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const nextSortOrder = database.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM menu_items WHERE restaurant_id = ?"
  );
  const upsert = database.prepare(`
    INSERT INTO menu_items (
      id, restaurant_id, name, description, price, dietary_status,
      modification_note, source_evidence, sort_order, last_verified_at, active, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, description = excluded.description, price = excluded.price,
      dietary_status = excluded.dietary_status,
      modification_note = excluded.modification_note,
      source_evidence = excluded.source_evidence,
      last_verified_at = excluded.last_verified_at, updated_at = excluded.updated_at,
      active = 1
  `);
  const applied = [];

  for (const operation of operations) {
    if (operation.operation === "retire") {
      const current = existing.get(operation.menu_item_id, restaurantID);
      // Already gone. Accepting a retirement twice is not an error worth failing
      // the whole transaction over; it just has nothing left to do.
      if (!current || current.active === 0) continue;
      database.prepare("UPDATE menu_items SET active = 0, updated_at = ? WHERE id = ?")
        .run(recordedAt, current.id);
      insertVersion.run(
        randomUUID(), current.id, restaurantID,
        JSON.stringify(canonicalDatabaseItem(current)), recordedAt, "retired"
      );
      applied.push(operation);
      continue;
    }

    const item = {
      id: operation.menu_item_id,
      name: operation.proposed_name,
      description: operation.proposed_description ?? "",
      price: operation.proposed_price,
      dietaryStatus: operation.proposed_dietary_status,
      modificationNote: operation.proposed_modification_note ?? null,
      sourceEvidence: operation.evidence ?? ""
    };
    const previous = existing.get(item.id, restaurantID);
    // A re-added dish keeps the position it held before; a genuinely new one
    // goes to the end rather than displacing the menu a reviewer already knows.
    const sortOrder = previous ? previous.sort_order : nextSortOrder.get(restaurantID).next;
    upsert.run(
      item.id, restaurantID, item.name, item.description, item.price, item.dietaryStatus,
      item.modificationNote, item.sourceEvidence, sortOrder, recordedAt, recordedAt
    );

    const snapshot = JSON.stringify(canonicalItem(item));
    const wasLive = Boolean(previous) && previous.active === 1;
    // Re-publishing a previously retired item is a change even when its content
    // is byte-identical, so the flag matters as much as the snapshot does.
    if (!wasLive || JSON.stringify(canonicalDatabaseItem(previous)) !== snapshot) {
      insertVersion.run(
        randomUUID(), item.id, restaurantID, snapshot, recordedAt,
        wasLive ? "updated" : "published"
      );
    }
    applied.push(operation);
  }

  return applied;
}

function changeProposalRow(row) {
  return {
    id: row.id,
    restaurantID: row.restaurant_id,
    restaurantName: row.restaurant_name,
    menuURL: row.menu_url,
    tier: row.tier,
    status: row.status,
    ambiguities: parseJSONColumn(row.ambiguities, []),
    operationCount: Number(row.operation_count ?? 0),
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    note: row.note
  };
}

function changeOperationRow(row) {
  return {
    id: row.id,
    operation: row.operation,
    position: row.position,
    menuItemID: row.menu_item_id,
    // A retirement proposes no values; it proposes that existing ones stop being
    // published. Returning an object of nulls would read as "rename it to null".
    proposed: row.operation === "retire" ? null : {
      id: row.menu_item_id,
      name: row.proposed_name,
      description: row.proposed_description ?? "",
      price: row.proposed_price,
      dietaryStatus: row.proposed_dietary_status,
      modificationNote: row.proposed_modification_note ?? null
    },
    current: parseJSONColumn(row.current_item, null),
    changedFields: parseJSONColumn(row.changed_fields, []),
    evidence: row.evidence,
    confidence: row.confidence,
    decision: row.decision
  };
}

// A whole menu page, and for a document source a placeholder standing in for one.
// Capped because a reviewer comparing two readings needs to see the text, not
// receive 350KB of it down a review page that has to stay usable.
const SOURCE_PREVIEW_LIMIT = 20_000;

function snapshotRow(row) {
  if (!row) return null;
  const source = row.normalized_source ?? "";
  return {
    id: row.id,
    hash: row.source_hash,
    capturedAt: row.captured_at,
    length: source.length,
    truncated: source.length > SOURCE_PREVIEW_LIMIT,
    source: source.slice(0, SOURCE_PREVIEW_LIMIT)
  };
}

// SQLite stores these as TEXT; PostgreSQL hands back jsonb already parsed.
function parseJSONColumn(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function ensureSeeded(database, seedPath = defaultSeedPath) {
  const row = database.prepare("SELECT COUNT(*) AS count FROM restaurants").get();
  if (row.count === 0) {
    importSeed(database, seedPath);
  }
}
