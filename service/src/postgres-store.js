import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
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
            review_required
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,FALSE)
          ON CONFLICT(id) DO UPDATE SET
            name=EXCLUDED.name, neighborhood=EXCLUDED.neighborhood, address=EXCLUDED.address,
            latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude,
            menu_url=EXCLUDED.menu_url, check_url=EXCLUDED.check_url,
            extraction_mode=EXCLUDED.extraction_mode, verified_at=EXCLUDED.verified_at,
            coverage_scope=EXCLUDED.coverage_scope, audited_at=EXCLUDED.audited_at,
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

        const { rows: existingRows } = await client.query(
          "SELECT * FROM menu_items WHERE restaurant_id=$1 AND active=TRUE", [restaurant.id]
        );
        const existing = new Map(existingRows.map((item) => [item.id, item]));
        const incomingIDs = restaurant.menuItems.map((item) => item.id);

        for (const [index, item] of restaurant.menuItems.entries()) {
          const previous = existing.get(item.id);
          await client.query(`
            INSERT INTO menu_items (
              id, restaurant_id, name, description, price, dietary_status,
              modification_note, source_evidence, sort_order, last_verified_at, active
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
            ON CONFLICT(id) DO UPDATE SET
              restaurant_id=EXCLUDED.restaurant_id, name=EXCLUDED.name,
              description=EXCLUDED.description, price=EXCLUDED.price,
              dietary_status=EXCLUDED.dietary_status,
              modification_note=EXCLUDED.modification_note,
              source_evidence=EXCLUDED.source_evidence, sort_order=EXCLUDED.sort_order,
              last_verified_at=EXCLUDED.last_verified_at, active=TRUE
          `, [
            item.id, restaurant.id, item.name, item.description, item.price,
            item.dietaryStatus, item.modificationNote ?? null, item.sourceEvidence ?? "",
            index, restaurant.auditedAt
          ]);

          const snapshot = canonicalItem(item);
          if (!previous || JSON.stringify(canonicalDatabaseItem(previous)) !== JSON.stringify(snapshot)) {
            await client.query(`
              INSERT INTO menu_item_versions
                (id, menu_item_id, restaurant_id, item_snapshot, recorded_at, change_kind)
              VALUES ($1,$2,$3,$4::jsonb,$5,$6)
            `, [
              randomUUID(), item.id, restaurant.id, JSON.stringify(snapshot),
              restaurant.auditedAt, previous ? "updated" : "published"
            ]);
          }
          existing.delete(item.id);
        }

        // Runs even when incomingIDs is empty: a seed that drops every item for a
        // restaurant must unpublish the old ones rather than keep serving them.
        await client.query(`
          UPDATE menu_items SET active=FALSE
          WHERE restaurant_id=$1 AND active=TRUE AND NOT (id = ANY($2::uuid[]))
        `, [restaurant.id, incomingIDs]);
        for (const retired of existing.values()) {
          await client.query(`
            INSERT INTO menu_item_versions
              (id, menu_item_id, restaurant_id, item_snapshot, recorded_at, change_kind)
            VALUES ($1,$2,$3,$4::jsonb,$5,'retired')
          `, [
            randomUUID(), retired.id, restaurant.id,
            JSON.stringify(canonicalDatabaseItem(retired)), restaurant.auditedAt
          ]);
        }
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

  async listCheckTargets() {
    const { rows } = await this.pool.query(`
      SELECT id, name, COALESCE(check_url, menu_url) AS check_url, source_hash,
             extraction_mode FROM restaurants ORDER BY name
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
