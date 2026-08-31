// Bulk-onboards restaurants a discovery pass produced.
//
// Adding restaurants one HTTP request at a time is fine for ten and hopeless for
// a thousand, and hand-editing the seed is worse: the seed bootstraps an empty
// database, so editing it to add restaurants makes it a second source of truth
// that drifts from the first.
//
// What this does *not* do is invent anything. A candidate carries the name,
// address, coordinates, and menu URL a person or a discovery source established;
// this creates the record unaudited and lets the existing extraction tiers decide
// whether anything about it can be published without a human. A restaurant it
// creates has no menu items and cannot appear in the app until its menu is
// reconciled — the same gate every other restaurant goes through.

import { stableRestaurantID, validateRestaurant } from "./catalog-input.js";
import { proposeMenu } from "./proposals.js";

// Reads a candidate file into records, keeping malformed entries rather than
// throwing them away: an import of 200 restaurants should not be lost because
// entry 87 is missing a longitude, and whoever fixes it needs to be told which.
export function readCandidates(raw) {
  const list = Array.isArray(raw) ? raw : raw?.restaurants;
  if (!Array.isArray(list)) {
    return {
      candidates: [],
      invalid: [],
      fatal: 'Expected a JSON array of restaurants, or an object with a "restaurants" array'
    };
  }

  const candidates = [];
  const invalid = [];
  for (const [index, entry] of list.entries()) {
    // Identity comes from the real thing the record describes, so importing the
    // same list twice recognises what it already created instead of duplicating
    // it. An explicit id always wins, for the case where an operator is
    // deliberately re-pointing an existing record.
    const id = entry?.id ?? stableRestaurantID(entry?.name, entry?.address);
    const checked = validateRestaurant({ ...entry, id });
    if (checked.valid) candidates.push(checked.value);
    else invalid.push({ index, name: entry?.name ?? "(unnamed)", errors: checked.errors });
  }
  return { candidates, invalid, fatal: null };
}

export async function importCandidates(store, candidates, {
  // Extraction is what makes an import worth running: it is where a restaurant
  // that states its whole menu is vegan becomes published coverage at no human
  // cost. Turn it off to create the records and read their menus later.
  extract = true,
  tiers,
  // Never defaulted from the environment. A bulk import runs over every
  // restaurant in the file, so a client acquired implicitly would spend real
  // money the moment somebody tried a dry run against a big list.
  modelClient = null, modelName,
  fetchImpl, browserFetchImpl,
  // Fetching a few hundred menus back to back from one host is rude and gets you
  // blocked. Sequential with a pause is slower than it needs to be and is the
  // right default for somebody else's server.
  delayMs = 1_000,
  dryRun = false,
  logger = console
} = {}) {
  const summary = {
    created: [], existing: [], failed: [],
    published: [], drafted: [], unreadable: []
  };

  for (const candidate of candidates) {
    const already = await findExisting(store, candidate);
    if (already) {
      // Left completely alone. Re-running an import must never touch a menu
      // somebody already audited, so this does not upsert and does not
      // re-extract; correcting a record is a deliberate act through the admin API.
      summary.existing.push({ id: already.id, name: candidate.name, matchedBy: already.matchedBy });
      logger.log(
        `EXISTS    ${candidate.name}` +
        (already.matchedBy === "id" ? "" : ` (already in the catalog as "${already.name}")`)
      );
      continue;
    }

    if (dryRun) {
      summary.created.push({ id: candidate.id, name: candidate.name });
      logger.log(`WOULD ADD ${candidate.name}`);
      continue;
    }

    try {
      // Lands with coverage 'Needs review', no published items, and a place in
      // the review queue. It cannot reach the app from here.
      await store.upsertRestaurant(candidate);
      summary.created.push({ id: candidate.id, name: candidate.name });
      logger.log(`ADDED     ${candidate.name}`);
    } catch (error) {
      summary.failed.push({ name: candidate.name, reason: String(error.message ?? error) });
      logger.error(`FAILED    ${candidate.name}: ${error.message ?? error}`);
      continue;
    }

    if (!extract) continue;

    try {
      const target = await store.getCheckTarget(candidate.id);
      const result = await proposeMenu(store, target, {
        tiers, modelClient, modelName, fetchImpl, browserFetchImpl
      });
      if (result.published) {
        summary.published.push({ name: result.name, tier: result.tier, items: result.items.length });
        logger.log(`  PUBLISHED ${result.items.length} item(s) (${result.tier}) — no review needed`);
      } else if (result.items.length > 0) {
        summary.drafted.push({ name: result.name, tier: result.tier, items: result.items.length });
        logger.log(`  DRAFTED   ${result.items.length} item(s) (${result.tier}) — awaiting review`);
      } else {
        summary.unreadable.push({ name: result.name, tier: result.tier, reasons: result.reasons });
        logger.log(`  MANUAL    ${result.reasons[0] ?? "nothing could be read automatically"}`);
      }
    } catch (error) {
      // The restaurant is created and queued either way. A menu that could not
      // be fetched is a review task, not a reason to lose the record.
      summary.failed.push({ name: candidate.name, reason: String(error.message ?? error) });
      logger.error(`  FAILED    ${candidate.name}: ${error.message ?? error}`);
    }

    if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
  }

  return summary;
}

// How near two records must be to be the same restaurant. Generous enough to
// absorb the disagreement between a hand-entered coordinate and a map node
// placed on a different corner of the same building, tight enough that two
// businesses of the same name this close are one business.
const SAME_PLACE_KM = 0.2;

// Whether this candidate is already in the catalog.
//
// The derived id catches a re-import of the same file, and nothing else. A
// restaurant entered by hand has a hand-assigned id, and a discovery pass over a
// city it already covers would otherwise duplicate every one of them — importing
// a second, unaudited copy of a restaurant whose menu somebody verified, which
// then competes with the original in the app.
//
// So identity also falls back to what a person would use: the same name, in the
// same place. A false match declines to import a restaurant somebody can add by
// hand; a missed match silently doubles the catalog. Those are not equivalent,
// and this errs towards the first.
async function findExisting(store, candidate) {
  const byID = await store.getCheckTarget(candidate.id);
  if (byID) return { id: byID.id, name: byID.name, matchedBy: "id" };

  const nearby = await store.getCatalogPage({
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    radiusKm: SAME_PLACE_KM,
    limit: 100
  });
  const wanted = comparableName(candidate.name);
  const match = nearby.restaurants.find(
    (restaurant) => comparableName(restaurant.name) === wanted
  );
  return match ? { id: match.id, name: match.name, matchedBy: "name and location" } : null;
}

// "The Corner Beet" and "Corner Beet", "City O' City" and "City O City". Two
// sources spelling one restaurant differently is the normal case, not the odd one.
function comparableName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^\s*the\s+/, "")
    .trim();
}

// The number the expansion strategy turns on: of the restaurants just onboarded,
// how many reached published coverage without costing anybody a decision. It is
// the only honest estimate of how far this approach scales, and it cannot be
// guessed from a catalog that was audited by hand.
export function zeroTouchRatio(summary) {
  const examined = summary.published.length + summary.drafted.length
    + summary.unreadable.length + summary.failed.length;
  return {
    published: summary.published.length,
    examined,
    ratio: examined === 0 ? null : summary.published.length / examined
  };
}

// A batch sorted into what it cost, in the unit that cost is actually paid in.
//
// Zero-touch coverage alone reads a batch too harshly. 30 auto-published, 40
// awaiting review and 30 unusable is a good result if those 40 are a click each,
// and a bad one if they are ten decisions each — but the restaurant count is
// identical either way. A reviewer accepts or rejects *items*, so items are what
// the middle bucket has to be measured in.
export function reportOf(summary) {
  const items = (entries) => entries.reduce((total, entry) => total + (entry.items ?? 0), 0);
  const perRestaurant = summary.drafted.map((entry) => entry.items ?? 0).sort((a, b) => a - b);
  const zeroTouch = zeroTouchRatio(summary);

  return {
    examined: zeroTouch.examined,
    created: summary.created.length,
    existing: summary.existing.length,
    autoPublished: { restaurants: summary.published.length, items: items(summary.published) },
    awaitingReview: {
      restaurants: summary.drafted.length,
      items: items(summary.drafted),
      // What one restaurant actually costs a reviewer. The median says what the
      // work feels like; the maximum says what the worst of it looks like, and a
      // long tail of 30-item menus is the thing that quietly makes a queue
      // unworkable.
      medianItems: perRestaurant.length
        ? perRestaurant[Math.floor((perRestaurant.length - 1) / 2)]
        : 0,
      maxItems: perRestaurant.length ? perRestaurant[perRestaurant.length - 1] : 0
    },
    manual: {
      restaurants: summary.unreadable.length + summary.failed.length,
      unreadable: summary.unreadable.length,
      failed: summary.failed.length
    },
    zeroTouchRatio: zeroTouch.ratio
  };
}

export function formatSummary(summary, { invalid = [] } = {}) {
  const zeroTouch = zeroTouchRatio(summary);
  const byTier = (entries) => {
    const counts = {};
    for (const entry of entries) counts[entry.tier] = (counts[entry.tier] ?? 0) + 1;
    const parts = Object.entries(counts).map(([tier, n]) => `${tier} ${n}`);
    return parts.length ? ` (${parts.join(", ")})` : "";
  };

  const lines = [
    "",
    `${summary.created.length} created, ${summary.existing.length} already in the catalog` +
      (invalid.length ? `, ${invalid.length} invalid` : ""),
    ""
  ];
  for (const entry of invalid) {
    lines.push(`  INVALID [${entry.index}] ${entry.name}: ${entry.errors.join("; ")}`);
  }
  if (invalid.length) lines.push("");

  if (zeroTouch.examined > 0) {
    const report = reportOf(summary);
    const pad = (n) => String(n).padStart(4);
    lines.push(
      `  auto-published   ${pad(report.autoPublished.restaurants)} restaurant(s), ` +
        `${report.autoPublished.items} item(s)${byTier(summary.published)}`,
      `  awaiting review  ${pad(report.awaitingReview.restaurants)} restaurant(s), ` +
        `${report.awaitingReview.items} item(s)${byTier(summary.drafted)}`,
      // The cost of the middle bucket, in the unit a reviewer pays it in. A
      // batch is only as good as how much work its reviewable half is.
      `                        ${report.awaitingReview.medianItems} item(s) for a typical one, ` +
        `${report.awaitingReview.maxItems} for the largest`,
      `  manual/unusable  ${pad(report.manual.restaurants)} restaurant(s) ` +
        `(${report.manual.unreadable} unreadable, ${report.manual.failed} unfetchable)`,
      "",
      `  Zero-touch coverage: ${(zeroTouch.ratio * 100).toFixed(0)}% ` +
        `(${zeroTouch.published} of ${zeroTouch.examined})`,
      "",
      "  Everything else is in the review queue. Run `npm start` and open /review."
    );
  }
  return lines.join("\n");
}
