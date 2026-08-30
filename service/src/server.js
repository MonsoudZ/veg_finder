import { createServer } from "node:http";
import { checkMenus } from "./checker.js";
import { catalogFromDatabase, ensureSeeded, openDatabase } from "./database.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const database = openDatabase(process.env.VEGFINDER_DATABASE_PATH);
ensureSeeded(database);

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host ?? `${host}:${port}`}`);

  if (request.method === "GET" && url.pathname === "/health") {
    return json(response, 200, { status: "ok" });
  }

  if (request.method === "GET" && url.pathname === "/v1/catalog") {
    const catalog = catalogFromDatabase(database);
    const neighborhood = url.searchParams.get("neighborhood");
    if (neighborhood) {
      catalog.restaurants = catalog.restaurants.filter(
        (restaurant) => restaurant.neighborhood.toLowerCase() === neighborhood.toLowerCase()
      );
    }
    return json(response, 200, catalog);
  }

  if (request.method === "GET" && url.pathname === "/internal/review-queue") {
    const rows = database.prepare(`
      SELECT id, name, menu_url AS menuURL, last_checked_at AS lastCheckedAt,
             check_error AS checkError
      FROM restaurants
      WHERE review_required = 1 OR check_error IS NOT NULL
      ORDER BY name COLLATE NOCASE
    `).all();
    return json(response, 200, { restaurants: rows });
  }

  return json(response, 404, { error: "Not found" });
});

server.listen(port, host, () => {
  console.log(`VegFinder catalog listening on http://${host}:${port}`);
});

const checkIntervalHours = Number(process.env.MENU_CHECK_INTERVAL_HOURS ?? 24);
if (checkIntervalHours > 0) {
  setTimeout(runScheduledCheck, 1_000);
  setInterval(runScheduledCheck, checkIntervalHours * 60 * 60 * 1_000).unref();
}

async function runScheduledCheck() {
  console.log("Starting scheduled official-menu check.");
  const results = await checkMenus(database);
  const failed = results.filter((result) => result.status === "failed").length;
  const changed = results.filter((result) => result.status === "changed").length;
  console.log(`Menu check complete: ${changed} changed, ${failed} failed.`);
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": statusCode === 200 ? "public, max-age=300" : "no-store"
  });
  response.end(JSON.stringify(value));
}
