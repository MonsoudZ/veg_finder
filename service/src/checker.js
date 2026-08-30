import { createHash } from "node:crypto";
import { loadBrowserSource } from "./browser-source.js";

export async function checkMenus(
  database,
  { fetchImpl = fetch, browserFetchImpl = loadBrowserSource, logger = console } = {}
) {
  const restaurants = database.prepare(`
    SELECT id, name, COALESCE(check_url, menu_url) AS check_url, source_hash,
           extraction_mode
    FROM restaurants
    ORDER BY name COLLATE NOCASE
  `).all();
  const markChecked = database.prepare(`
    UPDATE restaurants
    SET last_checked_at = ?, source_hash = ?,
        review_required = CASE
          WHEN source_hash IS NOT NULL AND source_hash <> ? THEN 1
          ELSE review_required
        END,
        coverage_status = CASE
          WHEN source_hash IS NOT NULL AND source_hash <> ? THEN 'Needs review'
          ELSE coverage_status
        END,
        check_error = NULL
    WHERE id = ?
  `);
  const markFailed = database.prepare(`
    UPDATE restaurants
    SET last_checked_at = ?, check_error = ?, coverage_status = 'Needs review'
    WHERE id = ?
  `);

  const results = [];
  for (const restaurant of restaurants) {
    const checkedAt = new Date().toISOString();
    try {
      const sourceText = restaurant.extraction_mode === "browser_required"
        ? await browserFetchImpl(restaurant.check_url)
        : await loadHTTPSource(fetchImpl, restaurant.check_url);
      const source = normalize(sourceText);
      const hash = createHash("sha256").update(source).digest("hex");
      markChecked.run(checkedAt, hash, hash, hash, restaurant.id);
      const changed = Boolean(restaurant.source_hash && restaurant.source_hash !== hash);
      logger.log(`${changed ? "CHANGED" : "OK"} ${restaurant.name}`);
      results.push({ id: restaurant.id, status: changed ? "changed" : "ok" });
    } catch (error) {
      const message = String(error.message ?? error);
      markFailed.run(checkedAt, message, restaurant.id);
      logger.error(`FAILED ${restaurant.name}: ${message}`);
      results.push({ id: restaurant.id, status: "failed", error: message });
    }
  }
  return results;
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
