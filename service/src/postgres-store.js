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
            claim_url, extraction_mode, verified_at, coverage_status, coverage_scope,
            audited_at, review_required, updated_at, menu_profile, verification_method
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,FALSE,$14,$15,$16)
          ON CONFLICT(id) DO UPDATE SET
            name=EXCLUDED.name, neighborhood=EXCLUDED.neighborhood, address=EXCLUDED.address,
            latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude,
            menu_url=EXCLUDED.menu_url, check_url=EXCLUDED.check_url,
            claim_url=EXCLUDED.claim_url,
            -- The seed is the operator's declared catalog, so it is authoritative
            -- for these the same way it already is for the address and menu URL.
            menu_profile=EXCLUDED.menu_profile,
            verification_method=EXCLUDED.verification_method,
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
          restaurant.checkURL ?? null, restaurant.claimURL ?? null,
          restaurant.extractionMode ?? "change_detection",
          restaurant.verifiedAt, restaurant.coverageStatus, restaurant.coverageScope,
          restaurant.auditedAt, restaurant.menuProfile ?? "unknown",
          restaurant.verificationMethod ?? "official_url"
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
          price: item.price ?? null,
          priceStatus: item.price == null ? "unavailable" : "listed",
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

    const geographic = latitude != null && longitude != null;
    // Mirrors database.js: distance ranking reads the whole box and cannot page,
    // so a delta always pages even when scoped to a radius.
    const rankByDistance = geographic && !since;

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = since ? "COALESCE(updated_at, verified_at), id" : "name, id";
    const limitClause = rankByDistance ? "" : `LIMIT ${placeholder(limit + 1)}`;
    const { rows } = await this.pool.query(`
      SELECT id, name, neighborhood, address, latitude, longitude, menu_url,
             verified_at, coverage_status, coverage_scope, audited_at,
             last_checked_at, COALESCE(updated_at, verified_at) AS updated_at,
             menu_profile, verification_method
      FROM restaurants ${where} ORDER BY ${order} ${limitClause}
    `, parameters);

    let examined = rows;
    let nextCursor = null;
    if (rankByDistance) {
      examined = rows
        .map((row) => ({ row, km: distanceKm(latitude, longitude, row.latitude, row.longitude) }))
        .filter((entry) => entry.km <= radiusKm)
        .sort((a, b) => a.km - b.km)
        .slice(0, limit)
        .map((entry) => entry.row);
    } else if (rows.length > limit) {
      examined = rows.slice(0, limit);
      const last = examined[examined.length - 1];
      nextCursor = encodeCursor(
        since ? { updatedAt: iso(last.updated_at), id: last.id } : { name: last.name, id: last.id }
      );
    }

    const watermark = examined.reduce(
      (latest, row) => (latest === null || iso(row.updated_at) > latest ? iso(row.updated_at) : latest), null
    );
    const selected = rankByDistance
      ? examined
      : examined.filter((row) => !geographic
          || distanceKm(latitude, longitude, row.latitude, row.longitude) <= radiusKm);

    const { rows: items } = selected.length === 0 ? { rows: [] } : await this.pool.query(`
      SELECT id, restaurant_id, name, description, price, dietary_status,
             modification_note FROM menu_items
      WHERE active=TRUE AND restaurant_id = ANY($1::uuid[])
      ORDER BY restaurant_id, sort_order, name
    `, [selected.map((row) => row.id)]);
    const itemsByRestaurant = Map.groupBy(items, (item) => item.restaurant_id);

    return {
      generatedAt: new Date().toISOString(),
      syncedAt: watermark ?? since ?? null,
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
        claim_url, extraction_mode, verified_at, coverage_status, coverage_scope,
        audited_at, review_required, updated_at, menu_profile, verification_method
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Needs review',$12,NULL,TRUE,$11,$13,$14)
      ON CONFLICT(id) DO UPDATE SET
        name=EXCLUDED.name, neighborhood=EXCLUDED.neighborhood, address=EXCLUDED.address,
        latitude=EXCLUDED.latitude, longitude=EXCLUDED.longitude,
        menu_url=EXCLUDED.menu_url, check_url=EXCLUDED.check_url,
        claim_url=EXCLUDED.claim_url,
        extraction_mode=EXCLUDED.extraction_mode, coverage_scope=EXCLUDED.coverage_scope,
        updated_at=EXCLUDED.updated_at, menu_profile=EXCLUDED.menu_profile,
        verification_method=EXCLUDED.verification_method
    `, [
      record.id, record.name, record.neighborhood, record.address, record.latitude,
      record.longitude, record.menuURL, record.checkURL, record.claimURL,
      record.extractionMode, now, record.coverageScope, record.menuProfile,
      record.verificationMethod
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

  // --- Change proposals -----------------------------------------------------
  // Mirrors SQLiteStore. A detected change becomes a description of what
  // changed; only acceptChangeProposal turns that description into published
  // data, and only when a person asks it to.

  async getPublishedItems(restaurantID) {
    const { rows } = await this.pool.query(`
      SELECT id, name, description, price, dietary_status, modification_note, source_evidence
      FROM menu_items WHERE restaurant_id=$1 AND active=TRUE
      ORDER BY sort_order, name
    `, [restaurantID]);
    return rows.map(canonicalDatabaseItem);
  }

  async ensureSnapshot({ restaurantID, hash, normalizedSource, capturedAt }) {
    await this.pool.query(`
      INSERT INTO menu_source_snapshots
        (id, restaurant_id, source_hash, normalized_source, captured_at)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT(restaurant_id, source_hash) DO NOTHING
    `, [randomUUID(), restaurantID, hash, normalizedSource, capturedAt]);
    const { rows } = await this.pool.query(
      "SELECT id FROM menu_source_snapshots WHERE restaurant_id=$1 AND source_hash=$2",
      [restaurantID, hash]
    );
    return rows[0]?.id ?? null;
  }

  // The state the source was in before the reading a proposal was computed from.
  // Read from the recorded transition rather than inferred from capture times;
  // see the note in database.js and migrations/010.
  async priorSnapshotID(restaurantID, currentHash) {
    const { rows: [restaurant] } = await this.pool.query(
      "SELECT source_hash FROM restaurants WHERE id=$1", [restaurantID]
    );
    const live = restaurant?.source_hash ?? null;

    let priorHash = live;
    // Normally a proposal reads the same source the last check fingerprinted, so
    // what came before it is that check's recorded previous hash. If the page
    // moved again since, the fingerprint last stored is what this reading
    // replaces.
    if (!live || live === currentHash) {
      const { rows } = await this.pool.query(`
        SELECT previous_source_hash FROM menu_check_runs
        WHERE restaurant_id=$1 AND status='changed' AND previous_source_hash IS NOT NULL
        ORDER BY checked_at DESC LIMIT 1
      `, [restaurantID]);
      priorHash = rows[0]?.previous_source_hash ?? null;
    }

    if (!priorHash || priorHash === currentHash) return null;
    const { rows } = await this.pool.query(
      "SELECT id FROM menu_source_snapshots WHERE restaurant_id=$1 AND source_hash=$2",
      [restaurantID, priorHash]
    );
    return rows[0]?.id ?? null;
  }

  async createChangeProposal({
    restaurantID, sourceSnapshotID, previousSnapshotID, tier, ambiguities = [],
    operations = [], createdAt = new Date().toISOString(), note = null
  }) {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // A fresh reading supersedes whatever was still pending: two pending
      // proposals against one menu would let a reviewer accept the stale one.
      await client.query(
        "DELETE FROM menu_change_proposals WHERE restaurant_id=$1 AND status='pending'",
        [restaurantID]
      );
      await client.query(`
        INSERT INTO menu_change_proposals (
          id, restaurant_id, source_snapshot_id, previous_snapshot_id, tier, status,
          ambiguities, created_at, note
        ) VALUES ($1,$2,$3,$4,$5,'pending',$6::jsonb,$7,$8)
      `, [
        id, restaurantID, sourceSnapshotID, previousSnapshotID, tier,
        JSON.stringify(ambiguities), createdAt, note
      ]);
      for (const [index, operation] of operations.entries()) {
        await client.query(`
          INSERT INTO menu_change_operations (
            id, proposal_id, position, operation, menu_item_id, proposed_name,
            proposed_description, proposed_price, proposed_dietary_status,
            proposed_modification_note, evidence, current_item, changed_fields, confidence
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)
        `, [
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
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return id;
  }

  async listChangeProposals({ restaurantID, status } = {}) {
    const conditions = ["TRUE"];
    const parameters = [];
    if (restaurantID) conditions.push(`p.restaurant_id = $${parameters.push(restaurantID)}`);
    if (status) conditions.push(`p.status = $${parameters.push(status)}`);
    const { rows } = await this.pool.query(`
      SELECT p.*, r.name AS restaurant_name, r.menu_url,
             (SELECT COUNT(*) FROM menu_change_operations o WHERE o.proposal_id = p.id)
               AS operation_count
      FROM menu_change_proposals p JOIN restaurants r ON r.id = p.restaurant_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY p.created_at DESC, r.name
    `, parameters);
    return rows.map(changeProposalRow);
  }

  async getChangeProposal(id) {
    const { rows } = await this.pool.query(`
      SELECT p.*, r.name AS restaurant_name, r.menu_url,
             (SELECT COUNT(*) FROM menu_change_operations o WHERE o.proposal_id = p.id)
               AS operation_count
      FROM menu_change_proposals p JOIN restaurants r ON r.id = p.restaurant_id
      WHERE p.id=$1
    `, [id]);
    const row = rows[0];
    if (!row) return null;

    const { rows: operations } = await this.pool.query(
      "SELECT * FROM menu_change_operations WHERE proposal_id=$1 ORDER BY position, id", [id]
    );
    const { rows: snapshots } = await this.pool.query(`
      SELECT id, source_hash, normalized_source, captured_at
      FROM menu_source_snapshots WHERE id = ANY($1::uuid[])
    `, [[row.source_snapshot_id, row.previous_snapshot_id].filter(Boolean)]);
    const byID = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));

    return {
      ...changeProposalRow(row),
      operations: operations.map(changeOperationRow),
      newSource: snapshotRow(byID.get(row.source_snapshot_id) ?? null),
      oldSource: snapshotRow(byID.get(row.previous_snapshot_id) ?? null),
      published: await this.getPublishedItems(row.restaurant_id)
    };
  }

  async rejectChangeProposal(id, { reviewedBy = null, note = null } = {}) {
    const { rowCount } = await this.pool.query(`
      UPDATE menu_change_proposals
      SET status='rejected', reviewed_at=NOW(), reviewed_by=$1, note=COALESCE($2, note)
      WHERE id=$3 AND status='pending'
    `, [reviewedBy, note, id]);
    if (rowCount > 0) return { status: "rejected" };
    const { rowCount: exists } = await this.pool.query(
      "SELECT 1 FROM menu_change_proposals WHERE id=$1", [id]
    );
    return { status: exists > 0 ? "conflict" : "missing" };
  }

  // Publishing a reviewed diff, in one transaction. Either every accepted
  // operation lands with its version history and the restaurant's audit
  // advances, or nothing does.
  async acceptChangeProposal(id, {
    reviewedBy = null, operationIDs = null, note = null, coverageStatus = "Complete"
  } = {}) {
    const now = new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // FOR UPDATE, not a plain read: two reviewers clicking accept at the same
      // moment must not both publish.
      const { rows } = await client.query(
        "SELECT * FROM menu_change_proposals WHERE id=$1 FOR UPDATE", [id]
      );
      const proposal = rows[0];
      if (!proposal) {
        await client.query("ROLLBACK");
        return { status: "missing" };
      }
      if (proposal.status !== "pending") {
        await client.query("ROLLBACK");
        return { status: "conflict" };
      }

      const { rows: operations } = await client.query(
        "SELECT * FROM menu_change_operations WHERE proposal_id=$1 ORDER BY position, id", [id]
      );
      const chosen = operationIDs === null
        ? new Set(operations.map((operation) => operation.id))
        : new Set(operationIDs);
      const unknown = [...chosen].filter(
        (operationID) => !operations.some((operation) => operation.id === operationID)
      );
      // An id from another proposal means the caller is working from a stale
      // page; applying the subset it did recognise would publish something
      // nobody chose.
      if (unknown.length > 0) {
        await client.query("ROLLBACK");
        return { status: "unknown_operations", unknown };
      }

      const applied = await applyChangeOperations(
        client, proposal.restaurant_id,
        operations.filter((operation) => chosen.has(operation.id)), now
      );

      for (const operation of operations) {
        await client.query("UPDATE menu_change_operations SET decision=$1 WHERE id=$2", [
          chosen.has(operation.id) ? "applied" : "skipped", operation.id
        ]);
      }

      // Reviewing a diff against the official source *is* an audit, so this
      // advances audited_at and clears the review the checker raised, exactly as
      // reconcileRestaurant does. A reviewer who is not satisfied can accept the
      // safe operations and pass coverageStatus 'Needs review' to stay queued.
      await client.query(`
        UPDATE restaurants SET
          coverage_status=$1, audited_at=$2, updated_at=$2,
          review_required=($1 = 'Needs review'), check_error=NULL
        WHERE id=$3
      `, [coverageStatus, now, proposal.restaurant_id]);

      await client.query(`
        UPDATE menu_change_proposals
        SET status='accepted', reviewed_at=$1, reviewed_by=$2, note=COALESCE($3, note)
        WHERE id=$4
      `, [now, reviewedBy, note, id]);

      await client.query("COMMIT");
      return {
        status: "accepted", restaurantID: proposal.restaurant_id,
        applied: applied.length, skipped: operations.length - applied.length
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCheckTarget(id) {
    const { rows } = await this.pool.query(`
      SELECT id, name, COALESCE(check_url, menu_url) AS check_url, claim_url, source_hash,
             extraction_mode, menu_profile, verification_method, audited_at
      FROM restaurants WHERE id=$1
    `, [id]);
    return rows[0] ?? null;
  }

  async listCheckTargets() {
    const { rows } = await this.pool.query(`
      SELECT id, name, COALESCE(check_url, menu_url) AS check_url, claim_url, source_hash,
             extraction_mode, menu_profile, verification_method, audited_at
      FROM restaurants ORDER BY name
    `);
    return rows;
  }

  async recordCheckSuccess({ restaurantID, checkedAt, hash, normalizedSource, changed }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Read inside the transaction that replaces it, so what is recorded as the
      // previous hash is exactly the value this run overwrote.
      const { rows: [live] } = await client.query(
        "SELECT source_hash FROM restaurants WHERE id=$1", [restaurantID]
      );
      await client.query(`
        INSERT INTO menu_check_runs
          (id, restaurant_id, checked_at, status, source_hash, previous_source_hash)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [
        randomUUID(), restaurantID, checkedAt, changed ? "changed" : "ok", hash,
        live?.source_hash ?? null
      ]);
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

// Mirrors applyChangeOperations in database.js: applies exactly the operations a
// reviewer accepted and records each in the item's version history. Incremental
// on purpose — a dish nobody proposed a change to is left alone, because the
// diff only claims to describe what moved. Runs inside the caller's transaction.
async function applyChangeOperations(client, restaurantID, operations, recordedAt) {
  const applied = [];

  for (const operation of operations) {
    const { rows: [previous] } = await client.query(
      "SELECT * FROM menu_items WHERE id=$1 AND restaurant_id=$2",
      [operation.menu_item_id, restaurantID]
    );

    if (operation.operation === "retire") {
      // Already gone. Accepting a retirement twice has nothing left to do and is
      // not worth failing the whole transaction over.
      if (!previous || previous.active === false) continue;
      await client.query(
        "UPDATE menu_items SET active=FALSE, updated_at=$1 WHERE id=$2", [recordedAt, previous.id]
      );
      await client.query(`
        INSERT INTO menu_item_versions
          (id, menu_item_id, restaurant_id, item_snapshot, recorded_at, change_kind)
        VALUES ($1,$2,$3,$4::jsonb,$5,'retired')
      `, [
        randomUUID(), previous.id, restaurantID,
        JSON.stringify(canonicalDatabaseItem(previous)), recordedAt
      ]);
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
    // A re-added dish keeps the position it held before; a genuinely new one goes
    // to the end rather than displacing the menu a reviewer already knows.
    const sortOrder = previous?.sort_order ?? await nextSortOrder(client, restaurantID);
    await client.query(`
      INSERT INTO menu_items (
        id, restaurant_id, name, description, price, dietary_status,
        modification_note, source_evidence, sort_order, last_verified_at, active, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$10)
      ON CONFLICT(id) DO UPDATE SET
        name=EXCLUDED.name, description=EXCLUDED.description, price=EXCLUDED.price,
        dietary_status=EXCLUDED.dietary_status,
        modification_note=EXCLUDED.modification_note,
        source_evidence=EXCLUDED.source_evidence,
        last_verified_at=EXCLUDED.last_verified_at, updated_at=EXCLUDED.updated_at,
        active=TRUE
    `, [
      item.id, restaurantID, item.name, item.description, item.price, item.dietaryStatus,
      item.modificationNote, item.sourceEvidence, sortOrder, recordedAt
    ]);

    const snapshot = JSON.stringify(canonicalItem(item));
    const wasLive = Boolean(previous) && previous.active !== false;
    // Re-publishing a previously retired item is a change even when its content
    // is byte-identical, so the flag matters as much as the snapshot does.
    if (!wasLive || JSON.stringify(canonicalDatabaseItem(previous)) !== snapshot) {
      await client.query(`
        INSERT INTO menu_item_versions
          (id, menu_item_id, restaurant_id, item_snapshot, recorded_at, change_kind)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6)
      `, [
        randomUUID(), item.id, restaurantID, snapshot, recordedAt,
        wasLive ? "updated" : "published"
      ]);
    }
    applied.push(operation);
  }

  return applied;
}

async function nextSortOrder(client, restaurantID) {
  const { rows: [row] } = await client.query(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM menu_items WHERE restaurant_id=$1",
    [restaurantID]
  );
  return Number(row.next);
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
    createdAt: iso(row.created_at),
    reviewedAt: iso(row.reviewed_at),
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
    capturedAt: iso(row.captured_at),
    length: source.length,
    truncated: source.length > SOURCE_PREVIEW_LIMIT,
    source: source.slice(0, SOURCE_PREVIEW_LIMIT)
  };
}

// jsonb comes back parsed; the SQLite store hands back TEXT. One reader for both
// keeps the two stores returning the same shape.
function parseJSONColumn(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
