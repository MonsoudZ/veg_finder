import { createHash } from "node:crypto";
import { loadBrowserSource } from "./browser-source.js";

export async function checkMenus(
  store,
  { fetchImpl = fetch, browserFetchImpl = loadBrowserSource, logger = console } = {}
) {
  const restaurants = await store.listCheckTargets();

  const results = [];
  for (const restaurant of restaurants) {
    const checkedAt = new Date().toISOString();
    try {
      const sourceText = restaurant.extraction_mode === "browser_required"
        ? await browserFetchImpl(restaurant.check_url)
        : await loadHTTPSource(fetchImpl, restaurant.check_url);
      const source = normalize(sourceText);
      const hash = createHash("sha256").update(source).digest("hex");
      const changed = Boolean(restaurant.source_hash && restaurant.source_hash !== hash);
      await store.recordCheckSuccess({
        restaurantID: restaurant.id,
        checkedAt,
        hash,
        normalizedSource: source,
        changed
      });
      logger.log(`${changed ? "CHANGED" : "OK"} ${restaurant.name}`);
      results.push({ id: restaurant.id, name: restaurant.name, status: changed ? "changed" : "ok" });
    } catch (error) {
      const message = String(error.message ?? error);
      await store.recordCheckFailure({ restaurantID: restaurant.id, checkedAt, error: message });
      logger.error(`FAILED ${restaurant.name}: ${message}`);
      results.push({ id: restaurant.id, name: restaurant.name, status: "failed", error: message });
    }
  }
  return results;
}

// Shared with the extraction pipeline so both reach an official source the same
// way, including the headless-browser path for JavaScript ordering pages.
export async function fetchSource(
  restaurant, { fetchImpl = fetch, browserFetchImpl = loadBrowserSource } = {}
) {
  const url = restaurant.check_url ?? restaurant.checkURL ?? restaurant.menu_url ?? restaurant.menuURL;
  if (!url) throw new Error("Restaurant has no source URL");
  return restaurant.extraction_mode === "browser_required"
    ? browserFetchImpl(url)
    : loadHTTPSource(fetchImpl, url);
}

async function loadHTTPSource(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { "user-agent": "VegFinderMenuChecker/0.1 (+menu verification)" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function normalize(source) {
  return source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}
