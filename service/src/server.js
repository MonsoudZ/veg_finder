import { createServer } from "node:http";
import { checkMenus } from "./checker.js";
import { announceCheckResults, createNotifier } from "./notifier.js";
import { openStore } from "./store.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const store = await openStore();
await store.ensureSeeded();

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

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);

  if (request.method === "GET" && url.pathname === "/health") {
    await store.ping();
    return json(response, 200, { status: "ok" });
  }

  if (request.method === "GET" && url.pathname === "/v1/catalog") {
    const catalog = await store.getCatalog();
    const neighborhood = url.searchParams.get("neighborhood");
    if (neighborhood) {
      catalog.restaurants = catalog.restaurants.filter(
        (restaurant) => restaurant.neighborhood.toLowerCase() === neighborhood.toLowerCase()
      );
    }
    return json(response, 200, catalog);
  }

  if (request.method === "GET" && url.pathname === "/internal/review-queue") {
    if (!isInternalRequestAuthorized(request)) {
      return json(response, 404, { error: "Not found" }, false);
    }
    const rows = await store.getReviewQueue();
    return json(response, 200, { restaurants: rows }, false);
  }

  return json(response, 404, { error: "Not found" });
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
  return request.headers.authorization === `Bearer ${token}`;
}
