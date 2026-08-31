import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { boundingBox, decodeCursor, distanceKm, encodeCursor } from "./geo.js";
import { defaultSeedPath } from "./paths.js";

const { Pool } = pg;
const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = resolve(serviceRoot, "migrations");

export class PostgresStore {
  constructor(pool) {
    this.pool = pool;
  }

  async migrate() {
    const client = await this.pool.connect();
    const migrationLockID = 863_946_220;
    try {
      await client.query("SELECT pg_advisory_lock($1)", [migrationLockID]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const { rows } = await client.query("SELECT name FROM schema_migrations");
      const applied = new Set(rows.map((row) => row.name));
      const migrations = readdirSync(migrationsDirectory)
        .filter((name) => name.endsWith(".sql"))
        .sort();
      for (const name of migrations) {
        if (applied.has(name)) continue;
        await client.query("BEGIN");
        try {
          await client.query(readFileSync(resolve(migrationsDirectory, name), "utf8"));
          await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [migrationLockID]).catch(() => {});
      client.release();
    }
  }

  async ensureSeeded() {
    const { rows: [row] } = await this.pool.query("SELECT COUNT(*)::integer AS count FROM restaurants");
    if (row.count === 0) await this.importSeed();
  }

  async ping() { await this.pool.query("SELECT 1"); }

  async importSeed(seedPath = defaultSeedPath) {
    const catalog = JSON.parse(readFileSync(seedPath, "utf8"));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const restaurant of catalog.restaurants) {
        await client.query(`
          INSERT INTO restaurants (
            id, name, neighborhood, address, latitude, longitude, menu_url, check_url,
            extraction_mode, verified_at, coverage_status, coverage_scope, audited_at,
            review_required, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE,$13)
          ON CONFLICT(id) DO UPDATE SET
            name=EXCLUDED.name, neighborhood=EXCLUDED.neighborhood, address=EXCLUDED.address,
            latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude,
            menu_url=EXCLUDED.menu_url, check_url=EXCLUDED.check_url,
            extraction_mode=EXCLUDED.extraction_mode, verified_at=EXCLUDED.verified_at,
            coverage_scope=EXCLUDED.coverage_scope, audited_at=EXCLUDED.audited_at,
            updated_at=EXCLUDED.updated_at,
            -- An advancing audited_at is the operator's record that this menu was
            -- actually reconciled against the official source, so it is the only
            -- thing that may clear a review the checker raised. A seed can always
            -- demote; without a fresh audit it can never re-publish 'Complete'.
            coverage_status = CASE
              WHEN EXCLUDED.coverage_status = 'Needs review' THEN 'Needs review'
              WHEN restaurants.audited_at IS NULL
                OR EXCLUDED.audited_at > restaurants.audited_at THEN EXCLUDED.coverage_status
              ELSE restaurants.coverage_status
            END,
            review_required = CASE
              WHEN EXCLUDED.coverage_status = 'Needs review' THEN TRUE
              WHEN restaurants.audited_at IS NULL
                OR EXCLUDED.audited_at > restaurants.audited_at THEN FALSE
              ELSE restaurants.review_required
            END,
            check_error = CASE
              WHEN restaurants.audited_at IS NULL
                OR EXCLUDED.audited_at > restaurants.audited_at THEN NULL
              ELSE restaurants.check_error
            END
        `, [
          restaurant.id, restaurant.name, restaurant.neighborhood, restaurant.address,
          restaurant.latitude, restaurant.longitude, restaurant.menuURL,
          restaurant.checkURL ?? null, restaurant.extractionMode ?? "change_detection",
          restaurant.verifiedAt, restaurant.coverageStatus, restaurant.coverageScope,
          restaurant.auditedAt
        ]);

        await publishMenu(client, restaurant.id, restaurant.menuItems, restaurant.auditedAt);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCatalog() {
    const { rows: restaurants } = await this.pool.query(`
      SELECT id, name, neighborhood, address, latitude, longitude, menu_url,
             verified_at, coverage_status, coverage_scope, audited_at, last_checked_at
      FROM restaurants ORDER BY name
    `);
    const { rows: items } = await this.pool.query(`
      SELECT id, restaurant_id, name, description, price, dietary_status,
             modification_note FROM menu_items WHERE active=TRUE
      ORDER BY restaurant_id, sort_order, name
    `);
    const itemsByRestaurant = Map.groupBy(items, (item) => item.restaurant_id);
    return {
      generatedAt: new Date().toISOString(),
      restaurants: restaurants.map((restaurant) => ({
        id: restaurant.id,
        name: restaurant.name,
        neighborhood: restaurant.neighborhood,
        address: restaurant.address,
        latitude: restaurant.latitude,
        longitude: restaurant.longitude,
        verifiedAt: iso(restaurant.verified_at),
        menuURL: restaurant.menu_url,
        coverageStatus: restaurant.coverage_status,
        coverageScope: restaurant.coverage_scope,
        auditedAt: iso(restaurant.audited_at ?? restaurant.verified_at),
        lastCheckedAt: iso(restaurant.last_checked_at),
        menuItems: (itemsByRestaurant.get(restaurant.id) ?? []).map((item) => ({
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

  async getRestaurant(id) {
    const page = await this.getCatalogPage({ ids: [id], limit: 1 });
    return page.restaurants[0] ?? null;
  }

  async getCatalogPage({ latitude, longitude, radiusKm, since, cursor, limit = 100, ids } = {}) {
    const conditions = [];
    const parameters = [];
    const placeholder = (value) => `$${parameters.push(value)}`;

    if (ids) conditions.push(`id = ANY(${placeholder(ids)}::uuid[])`);
    if (since) conditions.push(`COALESCE(updated_at, verified_at) > ${placeholder(since)}::timestamptz`);
    if (latitude != null && longitude != null) {
      const box = boundingBox(latitude, longitude, radiusKm);
      conditions.push(
        `latitude BETWEEN ${placeholder(box.minLatitude)} AND ${placeholder(box.maxLatitude)}`,
        `longitude BETWEEN ${placeholder(box.minLongitude)} AND ${placeholder(box.maxLongitude)}`
      );
    }

    const resume = decodeCursor(cursor);
    if (resume?.updatedAt) {
      conditions.push(
        `(COALESCE(updated_at, verified_at), id) > (${placeholder(resume.updatedAt)}::timestamptz, ${placeholder(resume.id)}::uuid)`
      );
    } else if (resume?.name) {
      conditions.push(`(name, id) > (${placeholder(resume.name)}, ${placeholder(resume.id)}::uuid)`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = since ? "COALESCE(updated_at, verified_at), id" : "name, id";
    const limitClause = latitude == null ? `LIMIT ${placeholder(limit + 1)}` : "";
    const { rows } = await this.pool.query(`
      SELECT id, name, neighborhood, address, latitude, longitude, menu_url,
             verified_at, coverage_status, coverage_scope, audited_at,
             last_checked_at, COALESCE(updated_at, verified_at) AS updated_at,
             menu_profile, verification_method
      FROM restaurants ${where} ORDER BY ${order} ${limitClause}
    `, parameters);

    let selected = rows;
    let nextCursor = null;
    if (latitude != null && longitude != null) {
      selected = rows
        .map((row) => ({ row, km: distanceKm(latitude, longitude, row.latitude, row.longitude) }))
        .filter((entry) => entry.km <= radiusKm)
        .sort((a, b) => a.km - b.km)
        .slice(0, limit)
        .map((entry) => entry.row);
    } else if (rows.length > limit) {
      selected = rows.slice(0, limit);
      const last = selected[selected.length - 1];
      nextCursor = encodeCursor(
        since ? { updatedAt: iso(last.updated_at), id: last.id } : { name: last.name, id: last.id }
      );
    }

    const { rows: items } = selected.length === 0 ? { rows: [] } : await this.pool.query(`
      SELECT id, restaurant_id, name, description, price, dietary_status,
             modification_note FROM menu_items
      WHERE active=TRUE AND restaurant_id = ANY($1::uuid[])
      ORDER BY restaurant_id, sort_order, name
    `, [selected.map((row) => row.id)]);
    const itemsByRestaurant = Map.groupBy(items, (item) => item.restaurant_id);

    return {
      generatedAt: new Date().toISOString(),
      syncedAt: selected.length
        ? iso(selected[selected.length - 1].updated_at)
        : (since ?? null),
      restaurants: selected.map((row) => publicRestaurant(row, itemsByRestaurant.get(row.id) ?? [])),
      nextCursor
    };
  }

  async upsertRestaurant(record) {
    const now = new Date().toISOString();
    const { rowCount } = await this.pool.query(
      "SELECT 1 FROM restaurants WHERE id=$1", [record.id]
    );
    await this.pool.query(`
      INSERT INTO restaurants (
        id, name, neighborhood, address, latitude, longitude, menu_url, check_url,
        extraction_mode, verified_at, coverage_status, coverage_scope, audited_at,
        review_required, updated_at, menu_profile, verification_method
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Needs review',$11,NULL,TRUE,$10,$12,$13)
      ON CONFLICT(id) DO UPDATE SET
        name=EXCLUDED.name, neighborhood=EXCLUDED.neighborhood, address=EXCLUDED.address,
        latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude,
        menu_url=EXCLUDED.menu_url, check_url=EXCLUDED.check_url,
        extraction_mode=EXCLUDED.extraction_mode, coverage_scope=EXCLUDED.coverage_scope,
        updated_at=EXCLUDED.updated_at, menu_profile=EXCLUDED.menu_profile,
        verification_method=EXCLUDED.verification_method
    `, [
      record.id, record.name, record.neighborhood, record.address, record.latitude,
      record.longitude, record.menuURL, record.checkURL, record.extractionMode,
      now, record.coverageScope, record.menuProfile, record.verificationMethod
    ]);
    return { created: rowCount === 0 };
  }

  async reconcileRestaurant(id, { coverageStatus, coverageScope, menuItems }) {
    const now = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query("SELECT 1 FROM restaurants WHERE id=$1", [id]);
      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return null;
      }
      await publishMenu(client, id, menuItems, now);
      await client.query(`
        UPDATE restaurants SET
          coverage_status=$1,
          coverage_scope=COALESCE($2, coverage_scope),
          audited_at=$3, updated_at=$3,
          review_required=($1 = 'Needs review'),
          check_error=NULL
        WHERE id=$4
      `, [coverageStatus, coverageScope ?? null, now, id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.getRestaurant(id);
  }

  async saveProposals(restaurantID, { tier, items, proposedAt = new Date().toISOString() }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM menu_item_proposals WHERE restaurant_id=$1 AND status='pending'", [restaurantID]
      );
      for (const [position, item] of items.entries()) {
        await client.query(`
          INSERT INTO menu_item_proposals (id, restaurant_id, proposed_at, tier, position, item, status)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending')
        `, [randomUUID(), restaurantID, proposedAt, tier, position, JSON.stringify(item)]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { saved: items.length };
  }

  async listProposals({ restaurantID, status } = {}) {
    const conditions = ["TRUE"];
    const parameters = [];
    if (restaurantID) conditions.push(`p.restaurant_id = $${parameters.push(restaurantID)}`);
    if (status) conditions.push(`p.status = $${parameters.push(status)}`);
    const { rows } = await this.pool.query(`
      SELECT p.id, p.restaurant_id, p.proposed_at, p.tier, p.item, p.status, p.decided_at,
             p.note, r.name AS restaurant_name
      FROM menu_item_proposals p JOIN restaurants r ON r.id = p.restaurant_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY r.name, p.proposed_at, p.position, p.id
    `, parameters);
    return rows.map((row) => ({
      id: row.id,
      restaurantID: row.restaurant_id,
      restaurantName: row.restaurant_name,
      proposedAt: iso(row.proposed_at),
      tier: row.tier,
      status: row.status,
      decidedAt: iso(row.decided_at),
      note: row.note,
      // jsonb comes back parsed already.
      item: typeof row.item === "string" ? JSON.parse(row.item) : row.item
    }));
  }

  async decideProposal(id, { status, note = null }) {
    const { rowCount } = await this.pool.query(`
      UPDATE menu_item_proposals SET status=$1, note=$2, decided_at=NOW()
      WHERE id=$3 AND status='pending'
    `, [status, note, id]);
    return rowCount > 0;
  }

  async getCheckTarget(id) {
    const { rows } = await this.pool.query(`
      SELECT id, name, COALESCE(check_url, menu_url) AS check_url, source_hash,
             extraction_mode, menu_profile, verification_method, audited_at
      FROM restaurants WHERE id=$1
    `, [id]);
    return rows[0] ?? null;
  }

  async listCheckTargets() {
    const { rows } = await this.pool.query(`
      SELECT id, name, COALESCE(check_url, menu_url) AS check_url, source_hash,
             extraction_mode, menu_profile, verification_method, audited_at
      FROM restaurants ORDER BY name
    `);
    return rows;
  }

  async recordCheckSuccess({ restaurantID, checkedAt, hash, normalizedSource, changed }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO menu_check_runs (id, restaurant_id, checked_at, status, source_hash)
        VALUES ($1,$2,$3,$4,$5)
      `, [randomUUID(), restaurantID, checkedAt, changed ? "changed" : "ok", hash]);
      await client.query(`
        INSERT INTO menu_source_snapshots
          (id, restaurant_id, source_hash, normalized_source, captured_at)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT(restaurant_id, source_hash) DO NOTHING
      `, [randomUUID(), restaurantID, hash, normalizedSource, checkedAt]);
      await client.query(`
        UPDATE restaurants SET last_checked_at=$1, source_hash=$2,
          review_required=CASE WHEN $3 THEN TRUE ELSE review_required END,
          coverage_status=CASE WHEN $3 THEN 'Needs review' ELSE coverage_status END,
          check_error=NULL WHERE id=$4
      `, [checkedAt, hash, changed, restaurantID]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordCheckFailure({ restaurantID, checkedAt, error }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO menu_check_runs (id, restaurant_id, checked_at, status, error)
        VALUES ($1,$2,$3,'failed',$4)
      `, [randomUUID(), restaurantID, checkedAt, error]);
      await client.query(`
        UPDATE restaurants SET last_checked_at=$1, check_error=$2,
          coverage_status='Needs review' WHERE id=$3
      `, [checkedAt, error, restaurantID]);
      await client.query("COMMIT");
    } catch (failure) {
      await client.query("ROLLBACK");
      throw failure;
    } finally {
      client.release();
    }
  }

  async getReviewQueue() {
    const { rows } = await this.pool.query(`
      SELECT id, name, menu_url AS "menuURL", last_checked_at AS "lastCheckedAt",
             check_error AS "checkError" FROM restaurants
      WHERE review_required=TRUE OR check_error IS NOT NULL ORDER BY name
    `);
    return rows;
  }

  async runMenuCheckExclusive(operation) {
    const client = await this.pool.connect();
    const lockID = 863_946_221;
    try {
      const { rows: [row] } = await client.query(
        "SELECT pg_try_advisory_lock($1) AS acquired", [lockID]
      );
      if (!row.acquired) return null;
      try {
        return await operation();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [lockID]);
      }
    } finally {
      client.release();
    }
  }

  async close() { await this.pool.end(); }
}

export async function openPostgresStore(connectionString) {
  const pool = new Pool({ connectionString });
  // Idle clients die on failover, restart, and server-side idle timeouts. The pool
  // emits those here, and an unhandled 'error' event would terminate the service.
  pool.on("error", (error) => {
    console.error("PostgreSQL pool error:", error);
  });
  const store = new PostgresStore(pool);
  try {
    await store.migrate();
    return store;
  } catch (error) {
    await pool.end();
    throw error;
  }
}

// Mirrors publishMenu in database.js: retire everything, re-activate the incoming
// items, record what changed. Runs inside the caller's transaction.
async function publishMenu(client, restaurantID, items, recordedAt) {
  const { rows: existingRows } = await client.query(
    "SELECT * FROM menu_items WHERE restaurant_id=$1 AND active=TRUE", [restaurantID]
  );
  const existing = new Map(existingRows.map((item) => [item.id, item]));
  const incomingIDs = items.map((item) => item.id);

  for (const [index, item] of items.entries()) {
    const previous = existing.get(item.id);
    await client.query(`
      INSERT INTO menu_items (
        id, restaurant_id, name, description, price, dietary_status,
        modification_note, source_evidence, sort_order, last_verified_at, active,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$10)
      ON CONFLICT(id) DO UPDATE SET
        restaurant_id=EXCLUDED.restaurant_id, name=EXCLUDED.name,
        description=EXCLUDED.description, price=EXCLUDED.price,
        dietary_status=EXCLUDED.dietary_status,
        modification_note=EXCLUDED.modification_note,
        source_evidence=EXCLUDED.source_evidence, sort_order=EXCLUDED.sort_order,
        last_verified_at=EXCLUDED.last_verified_at, active=TRUE,
        updated_at=EXCLUDED.updated_at
    `, [
      item.id, restaurantID, item.name, item.description, item.price,
      item.dietaryStatus, item.modificationNote ?? null, item.sourceEvidence ?? "",
      index, recordedAt
    ]);

    const snapshot = canonicalItem(item);
    if (!previous || JSON.stringify(canonicalDatabaseItem(previous)) !== JSON.stringify(snapshot)) {
      await client.query(`
        INSERT INTO menu_item_versions
          (id, menu_item_id, restaurant_id, item_snapshot, recorded_at, change_kind)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6)
      `, [
        randomUUID(), item.id, restaurantID, JSON.stringify(snapshot),
        recordedAt, previous ? "updated" : "published"
      ]);
    }
    existing.delete(item.id);
  }

  // Runs even when incomingIDs is empty: a menu that drops every item must
  // unpublish the old ones rather than keep serving them.
  await client.query(`
    UPDATE menu_items SET active=FALSE, updated_at=$3
    WHERE restaurant_id=$1 AND active=TRUE AND NOT (id = ANY($2::uuid[]))
  `, [restaurantID, incomingIDs, recordedAt]);

  for (const retired of existing.values()) {
    await client.query(`
      INSERT INTO menu_item_versions
        (id, menu_item_id, restaurant_id, item_snapshot, recorded_at, change_kind)
      VALUES ($1,$2,$3,$4::jsonb,$5,'retired')
    `, [
      randomUUID(), retired.id, restaurantID,
      JSON.stringify(canonicalDatabaseItem(retired)), recordedAt
    ]);
  }
}

function publicRestaurant(row, items) {
  return {
    id: row.id,
    name: row.name,
    neighborhood: row.neighborhood,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    verifiedAt: iso(row.verified_at),
    menuURL: row.menu_url,
    coverageStatus: row.coverage_status,
    coverageScope: row.coverage_scope,
    auditedAt: iso(row.audited_at ?? row.verified_at),
    lastCheckedAt: iso(row.last_checked_at),
    updatedAt: iso(row.updated_at ?? row.verified_at),
    menuProfile: row.menu_profile ?? "unknown",
    verificationMethod: row.verification_method ?? "official_url",
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

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}
