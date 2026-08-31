import { createHash } from "node:crypto";
import { loadBrowserSource } from "./browser-source.js";

// How long a human-verified record stands before it must be looked at again.
// A photographed or phoned-in menu has no fingerprint to watch, so without a
// clock it would stay published unexamined forever.
const OFFLINE_REVIEW_DAYS = Number(process.env.OFFLINE_REVIEW_DAYS ?? 90);

export async function checkMenus(
  store,
  { fetchImpl = fetch, browserFetchImpl = loadBrowserSource, logger = console,
    offlineReviewDays = OFFLINE_REVIEW_DAYS, now = () => new Date() } = {}
) {
  const restaurants = await store.listCheckTargets();

  const results = [];
  for (const restaurant of restaurants) {
    // One clock for the whole run, injectable, so a test can order two cycles
    // unambiguously. Wall-clock time gave consecutive cycles identical
    // timestamps, which made anything ordered by them a coin flip.
    const checkedAt = now().toISOString();

    // No URL means no fingerprint. Age the record instead of skipping it.
    if (!restaurant.check_url) {
      const age = daysSince(restaurant.audited_at, now());
      if (age !== null && age < offlineReviewDays) {
        logger.log(`OFFLINE ${restaurant.name}: verified ${Math.floor(age)}d ago, still current`);
        results.push({ id: restaurant.id, name: restaurant.name, status: "ok" });
        continue;
      }
      const reason = age === null
        ? `Verified ${describeMethod(restaurant.verification_method)} but never audited; needs review`
        : `Verified ${describeMethod(restaurant.verification_method)} ${Math.floor(age)} days ago; ` +
          `re-verification due after ${offlineReviewDays} days`;
      await store.recordCheckFailure({ restaurantID: restaurant.id, checkedAt, error: reason });
      logger.log(`REVIEW DUE ${restaurant.name}: ${reason}`);
      results.push({ id: restaurant.id, name: restaurant.name, status: "review_due", error: reason });
      continue;
    }

    try {
      const fetched = await loadSource(restaurant, { fetchImpl, browserFetchImpl });
      const { hash, snapshot } = fingerprint(fetched);
      const changed = Boolean(restaurant.source_hash && restaurant.source_hash !== hash);
      await store.recordCheckSuccess({
        restaurantID: restaurant.id,
        checkedAt,
        hash,
        normalizedSource: snapshot,
        changed
      });
      // A PDF or image menu fingerprints like any other source, so an edit to it
      // is caught. What no fingerprint can do is notice that a dish was already
      // wrong, and nothing can read this source to find out — its items were
      // transcribed by a person. So it carries the offline clock too, and is the
      // one source type that gets both checks rather than one or the other.
      const stale = !changed && restaurant.verification_method === "menu_document"
        ? overdue(restaurant, offlineReviewDays, now())
        : null;
      if (stale) {
        await store.recordCheckFailure({ restaurantID: restaurant.id, checkedAt, error: stale });
        logger.log(`REVIEW DUE ${restaurant.name}: ${stale}`);
        results.push({ id: restaurant.id, name: restaurant.name, status: "review_due", error: stale });
        continue;
      }

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
  // Extraction wants the document itself; only the fingerprinting path cares
  // whether it was markup.
  return (await loadSource(restaurant, { fetchImpl, browserFetchImpl })).text;
}

// The document as fetched, plus what is needed to fingerprint it. Change
// detection and change *interpretation* run at different times against the same
// page, so they must reach it and reduce it identically — otherwise the snapshot
// a proposal cites would not be the snapshot the checker recorded.
export async function loadSource(
  restaurant, { fetchImpl = fetch, browserFetchImpl = loadBrowserSource } = {}
) {
  const url = restaurant.check_url ?? restaurant.checkURL ?? restaurant.menu_url ?? restaurant.menuURL;
  if (!url) throw new Error("Restaurant has no source URL");
  if (restaurant.extraction_mode === "browser_required") {
    return { text: await browserFetchImpl(url), markup: true, contentType: "text/html" };
  }
  return loadHTTPSource(fetchImpl, url);
}

// The fingerprint over a fetched source, and the snapshot worth storing beside it.
export function fingerprint({ text, markup, contentType }) {
  // normalize() strips HTML tags. Run against a PDF it deletes almost
  // everything — a 350KB menu collapsed to a few hundred characters of binary
  // residue, which is far too weak to notice a menu change. Non-markup sources
  // are fingerprinted whole instead.
  const source = markup ? normalize(text) : text;
  return {
    source,
    hash: createHash("sha256").update(source).digest("hex"),
    // A binary source has no readable snapshot worth keeping; record what it was
    // so a reviewer knows why, rather than storing megabytes of residue.
    snapshot: markup
      ? source
      : `[${contentType || "binary"}, ${source.length} bytes, fingerprinted whole]`
  };
}

async function loadHTTPSource(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { "user-agent": "VegFinderMenuChecker/0.1 (+menu verification)" },
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const contentType = response.headers?.get?.("content-type") ?? "";
  return {
    text: await response.text(),
    contentType,
    // A PDF or image menu is a legitimate source; it just is not markup.
    markup: contentType === "" || /html|xml|text\/plain/i.test(contentType)
  };
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

function daysSince(timestamp, now) {
  if (!timestamp) return null;
  const then = new Date(timestamp);
  if (Number.isNaN(then.getTime())) return null;
  return (now.getTime() - then.getTime()) / 86_400_000;
}

// Whether a human-transcribed record has stood long enough to be looked at
// again. Returns the reason to re-queue it, or null while it still stands.
function overdue(restaurant, offlineReviewDays, now) {
  const age = daysSince(restaurant.audited_at, now);
  if (age === null) {
    return `Verified ${describeMethod(restaurant.verification_method)} but never audited; needs review`;
  }
  if (age < offlineReviewDays) return null;
  return `Verified ${describeMethod(restaurant.verification_method)} ${Math.floor(age)} days ago; ` +
    `re-verification due after ${offlineReviewDays} days`;
}

function describeMethod(method) {
  switch (method) {
    case "menu_document": return "by transcribing a document menu";
    case "menu_photo": return "from a photographed menu";
    case "phone": return "by phone";
    case "in_person": return "in person";
    default: return "without an online source";
  }
}
