import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { validateMenuItems, validateRestaurant, COVERAGE_STATUSES } from "./catalog-input.js";
import { createExtractionClient } from "./llm-extraction.js";
import { autoPublishTiers, proposeMenu } from "./proposals.js";
import { proposeChangesForResults, proposeMenuChanges } from "./menu-changes.js";
import { checkMenus } from "./checker.js";
import { announceCheckResults, createNotifier } from "./notifier.js";
import { openStore } from "./store.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const store = await openStore();
await store.ensureSeeded();

// Built once at startup so a request cannot decide whether the service is
// allowed to spend money.
const modelClient = createExtractionClient();
if (!modelClient) {
  console.warn(
    "ANTHROPIC_API_KEY is not set. Menus with no dietary legend will be left for a person."
  );
}

const notifier = createNotifier();
if (!notifier.enabled) {
  console.warn(
    "ALERT_WEBHOOK_URL is not set. Menu reviews will be recorded but nobody will be " +
    "notified; the review queue must then be polled by hand."
  );
}

const server = createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    console.error(error);
    json(response, 500, { error: "Internal server error" });
  }
});

const MAX_BODY_BYTES = 1_000_000;
const DECISION_PATH = /^\/internal\/proposals\/([0-9a-f-]{36})\/decision$/i;
// The review page itself holds no data and no secret — it asks for the token and
// fetches everything through the authenticated endpoints below.
const REVIEW_PAGE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "review.html"), "utf8"
);
const RECONCILE_PATH = /^\/internal\/restaurants\/([0-9a-f-]{36})\/reconcile$/i;
const PROPOSE_PATH = /^\/internal\/restaurants\/([0-9a-f-]{36})\/propose$/i;
const PROPOSE_CHANGES_PATH = /^\/internal\/restaurants\/([0-9a-f-]{36})\/propose-changes$/i;
const CHANGE_PROPOSAL_PATH = /^\/internal\/review-queue\/([0-9a-f-]{36})$/i;
const CHANGE_ACCEPT_PATH = /^\/internal\/review-queue\/([0-9a-f-]{36})\/accept$/i;
const CHANGE_REJECT_PATH = /^\/internal\/review-queue\/([0-9a-f-]{36})\/reject$/i;

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);

  if (request.method === "GET" && url.pathname === "/health") {
    await store.ping();
    return json(response, 200, { status: "ok" });
  }

  if (request.method === "GET" && url.pathname === "/review") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return response.end(REVIEW_PAGE);
  }

  if (request.method === "GET" && url.pathname === "/v1/catalog") {
    const query = readCatalogQuery(url.searchParams);
    if (query.errors.length > 0) {
      return json(response, 400, { error: "Invalid query", details: query.errors }, false);
    }
    return json(response, 200, await store.getCatalogPage(query.value));
  }

  if (url.pathname.startsWith("/internal/")) {
    // An unauthenticated caller should not be able to tell these endpoints exist.
    if (!isInternalRequestAuthorized(request)) {
      return json(response, 404, { error: "Not found" }, false);
    }

    if (request.method === "GET" && url.pathname === "/internal/review-queue") {
      // `restaurants` is what the checker demoted — the fact that something
      // changed. `proposals` is what changed, where it could be worked out.
      return json(response, 200, {
        restaurants: await store.getReviewQueue(),
        proposals: await store.listChangeProposals({ status: "pending" })
      }, false);
    }

    const proposalDetail = request.method === "GET" && url.pathname.match(CHANGE_PROPOSAL_PATH);
    if (proposalDetail) {
      const proposal = await store.getChangeProposal(proposalDetail[1].toLowerCase());
      if (!proposal) return json(response, 404, { error: "Unknown proposal" }, false);
      return json(response, 200, { proposal }, false);
    }

    const accept = request.method === "POST" && url.pathname.match(CHANGE_ACCEPT_PATH);
    if (accept) {
      const body = await readJSONBody(request);
      if (body.error) return json(response, body.status, { error: body.error }, false);

      // Accepting publishes dietary data, and an unattributed publish defeats
      // the point of keeping a review trail at all.
      const reviewedBy = typeof body.value?.reviewedBy === "string" && body.value.reviewedBy.trim()
        ? body.value.reviewedBy.trim().slice(0, 200)
        : null;
      if (!reviewedBy) {
        return json(response, 422, { error: "reviewedBy is required to accept a proposal" }, false);
      }
      const coverageStatus = body.value?.coverageStatus ?? "Complete";
      if (!COVERAGE_STATUSES.includes(coverageStatus)) {
        return json(response, 422, {
          error: `coverageStatus must be one of: ${COVERAGE_STATUSES.join(", ")}`
        }, false);
      }
      // Absent means "every operation". An empty array means "none of them",
      // which is a legitimate way to say the diff was read and nothing in it
      // should publish, while still recording the audit.
      const operationIDs = body.value?.operationIds;
      if (operationIDs != null
        && (!Array.isArray(operationIDs) || operationIDs.some((id) => typeof id !== "string"))) {
        return json(response, 422, { error: "operationIds must be an array of strings" }, false);
      }

      const result = await store.acceptChangeProposal(accept[1].toLowerCase(), {
        reviewedBy,
        operationIDs: operationIDs ?? null,
        note: typeof body.value?.note === "string" ? body.value.note.slice(0, 2_000) : null,
        coverageStatus
      });
      if (result.status === "missing") {
        return json(response, 404, { error: "Unknown proposal" }, false);
      }
      if (result.status === "conflict") {
        return json(response, 409, { error: "Proposal is not pending" }, false);
      }
      if (result.status === "unknown_operations") {
        return json(response, 422, {
          error: "operationIds must all belong to this proposal", details: result.unknown
        }, false);
      }
      return json(response, 200, {
        ok: true,
        applied: result.applied,
        skipped: result.skipped,
        restaurant: await store.getRestaurant(result.restaurantID)
      }, false);
    }

    const reject = request.method === "POST" && url.pathname.match(CHANGE_REJECT_PATH);
    if (reject) {
      const body = await readJSONBody(request);
      if (body.error) return json(response, body.status, { error: body.error }, false);
      const result = await store.rejectChangeProposal(reject[1].toLowerCase(), {
        reviewedBy: typeof body.value?.reviewedBy === "string"
          ? body.value.reviewedBy.trim().slice(0, 200) || null
          : null,
        note: typeof body.value?.note === "string" ? body.value.note.slice(0, 2_000) : null
      });
      if (result.status === "missing") {
        return json(response, 404, { error: "Unknown proposal" }, false);
      }
      if (result.status === "conflict") {
        return json(response, 409, { error: "Proposal is not pending" }, false);
      }
      // Rejecting settles the proposal, not the restaurant: its source still
      // changed, so it stays in the review queue until somebody reconciles it.
      return json(response, 200, { ok: true }, false);
    }

    if (request.method === "POST" && url.pathname === "/internal/restaurants") {
      const body = await readJSONBody(request);
      if (body.error) return json(response, body.status, { error: body.error }, false);

      const restaurant = validateRestaurant(body.value);
      if (!restaurant.valid) {
        return json(response, 422, { error: "Invalid restaurant", details: restaurant.errors }, false);
      }
      const { created } = await store.upsertRestaurant(restaurant.value);
      return json(response, created ? 201 : 200, {
        restaurant: await store.getRestaurant(restaurant.value.id),
        created
      }, false);
    }

    if (request.method === "GET" && url.pathname === "/internal/proposals") {
      return json(response, 200, {
        proposals: await store.listProposals({
          restaurantID: url.searchParams.get("restaurantId") ?? undefined,
          status: url.searchParams.get("status") ?? undefined
        })
      }, false);
    }

    const decision = request.method === "POST" && url.pathname.match(DECISION_PATH);
    if (decision) {
      const body = await readJSONBody(request);
      if (body.error) return json(response, body.status, { error: body.error }, false);
      if (!["accepted", "rejected"].includes(body.value?.status)) {
        return json(response, 422, { error: "status must be accepted or rejected" }, false);
      }
      const applied = await store.decideProposal(decision[1].toLowerCase(), {
        status: body.value.status,
        note: typeof body.value.note === "string" ? body.value.note.slice(0, 2_000) : null
      });
      // A proposal that was already decided is not silently re-decided.
      if (!applied) return json(response, 409, { error: "Proposal is not pending" }, false);
      return json(response, 200, { ok: true }, false);
    }

    const propose = request.method === "POST" && url.pathname.match(PROPOSE_PATH);
    if (propose) {
      const target = await store.getCheckTarget(propose[1].toLowerCase());
      if (!target) return json(response, 404, { error: "Unknown restaurant" }, false);
      // Extraction proposes; only a tier configured as publishable writes anything.
      return json(response, 200, await proposeMenu(store, target, {
        modelClient, tiers: autoPublishTiers(process.env.AUTO_PUBLISH_TIERS)
      }), false);
    }

    const proposeChanges = request.method === "POST" && url.pathname.match(PROPOSE_CHANGES_PATH);
    if (proposeChanges) {
      const target = await store.getCheckTarget(proposeChanges[1].toLowerCase());
      if (!target) return json(response, 404, { error: "Unknown restaurant" }, false);
      // Re-reads the official source and diffs it against what is published.
      // Writes a proposal and nothing else — publishing stays a separate act.
      return json(response, 200, await proposeMenuChanges(store, target, { modelClient }), false);
    }

    const reconcile = request.method === "POST" && url.pathname.match(RECONCILE_PATH);
    if (reconcile) {
      const body = await readJSONBody(request);
      if (body.error) return json(response, body.status, { error: body.error }, false);

      const coverageStatus = body.value?.coverageStatus;
      if (!COVERAGE_STATUSES.includes(coverageStatus)) {
        return json(response, 422, {
          error: "Invalid reconciliation",
          details: [`coverageStatus must be one of: ${COVERAGE_STATUSES.join(", ")}`]
        }, false);
      }
      const items = validateMenuItems(body.value?.menuItems);
      if (!items.valid) {
        return json(response, 422, { error: "Invalid menu", details: items.errors }, false);
      }

      const restaurant = await store.reconcileRestaurant(reconcile[1].toLowerCase(), {
        coverageStatus,
        coverageScope: body.value?.coverageScope,
        menuItems: items.value
      });
      if (!restaurant) return json(response, 404, { error: "Unknown restaurant" }, false);
      return json(response, 200, { restaurant }, false);
    }
  }

  return json(response, 404, { error: "Not found" });
}

function readCatalogQuery(parameters) {
  const errors = [];
  const value = {};

  const latitude = optionalNumber(parameters, "lat", -90, 90, errors);
  const longitude = optionalNumber(parameters, "lon", -180, 180, errors);
  if ((latitude == null) !== (longitude == null)) {
    errors.push("lat and lon must be supplied together");
  } else if (latitude != null) {
    value.latitude = latitude;
    value.longitude = longitude;
    value.radiusKm = optionalNumber(parameters, "radiusKm", 0.1, 200, errors) ?? 25;
  }

  const since = parameters.get("since");
  if (since != null) {
    if (Number.isNaN(Date.parse(since))) errors.push("since must be an ISO-8601 timestamp");
    else value.since = new Date(since).toISOString();
  }

  const limit = optionalNumber(parameters, "limit", 1, 500, errors);
  value.limit = limit ?? 100;
  if (parameters.get("cursor")) value.cursor = parameters.get("cursor");

  return { errors, value };
}

function optionalNumber(parameters, name, min, max, errors) {
  const raw = parameters.get(name);
  if (raw == null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    errors.push(`${name} must be a number between ${min} and ${max}`);
    return null;
  }
  return parsed;
}

function readJSONBody(request) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        resolve({ error: "Request body too large", status: 413 });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve({ value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") });
      } catch {
        resolve({ error: "Body must be valid JSON", status: 400 });
      }
    });
    request.on("error", () => resolve({ error: "Could not read request body", status: 400 }));
  });
}

server.listen(port, host, () => {
  console.log(`VegFinder catalog listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(async () => {
      await store.close();
      process.exit(0);
    });
  });
}

const checkIntervalHours = Number(process.env.MENU_CHECK_INTERVAL_HOURS ?? 24);
if (checkIntervalHours > 0) {
  setTimeout(runScheduledCheck, 1_000);
  setInterval(runScheduledCheck, checkIntervalHours * 60 * 60 * 1_000).unref();
}

async function runScheduledCheck() {
  console.log("Starting scheduled official-menu check.");
  try {
    const results = await store.runMenuCheckExclusive(() => checkMenus(store));
    if (results === null) {
      console.log("Menu check skipped: another service instance owns the check lease.");
      return;
    }
    const failed = results.filter((result) => result.status === "failed").length;
    const changed = results.filter((result) => result.status === "changed").length;
    console.log(`Menu check complete: ${changed} changed, ${failed} failed.`);
    // Detection and interpretation stay separate steps. The model client is
    // deliberately not passed: a scheduled cycle covering every changed source
    // must not be able to spend money on its own.
    const proposals = await proposeChangesForResults(store, results);
    if (proposals.length > 0) {
      console.log(`Recorded ${proposals.length} change proposal(s) for review.`);
    }
    await announceCheckResults(store, results, { notifier });
  } catch (error) {
    // Timers own this promise, so an escaping rejection would end the process.
    // A check cycle that cannot run is a review problem, not an API outage.
    console.error("Scheduled menu check failed:", error);
  }
}

function json(response, statusCode, value, cacheable = true) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": statusCode === 200 && cacheable ? "public, max-age=300" : "no-store"
  });
  response.end(JSON.stringify(value));
}

function isInternalRequestAuthorized(request) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return false;
  // Constant-time compare: these endpoints now accept writes, not just reads.
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const actual = Buffer.from(request.headers.authorization ?? "", "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
