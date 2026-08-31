// Discovers candidate restaurants and writes a file for `npm run
// import-restaurants` to read. Writes nothing to the database: discovery
// produces a list a person looks at, and importing it is a separate, deliberate
// act.
//
//   npm run discover -- --bbox=39.70,-105.02,39.76,-104.95 --out=data/candidates/denver.json
//   npm run discover -- --area="Denver" --out=data/candidates/denver.json
//   npm run discover -- --bbox=... --out=... --no-menus --limit=200
//
// Data comes from OpenStreetMap via Overpass. See the licence note printed at
// the end of every run.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  fetchOverpass, overpassQuery, parseBBox, priorityOf, PRIORITIES, rankCandidates, summarize,
  toCandidates
} from "./discovery.js";
import { resolveMenuURL } from "./menu-url.js";

const args = process.argv.slice(2);
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const has = (name) => args.includes(`--${name}`);

const out = flag("out");
const bboxText = flag("bbox");
const area = flag("area");
if (!out || (!bboxText && !area)) {
  console.error(
    "Usage: npm run discover -- (--bbox=S,W,N,E | --area=\"Denver\") --out=<file.json>\n" +
    "       [--no-menus] [--limit=N] [--delay=ms] [--include-incomplete]"
  );
  process.exit(2);
}

const limit = Number(flag("limit") ?? 0) || null;
const delayMs = Number(flag("delay") ?? 1_000);

let bbox = null;
try {
  if (bboxText) bbox = parseBBox(bboxText);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

console.log(`Querying Overpass for ${area ? `area "${area}"` : `bbox ${bboxText}`}...`);
const payload = await fetchOverpass(overpassQuery({ bbox, area }));
const { complete, incomplete } = toCandidates(payload, { defaultNeighborhood: area ?? null });

console.log(
  `${payload.elements?.length ?? 0} places returned; ` +
  `${complete.length} usable, ${incomplete.length} missing something.`
);
if (incomplete.length > 0) {
  const reasons = {};
  for (const entry of incomplete) {
    for (const field of entry.missing) reasons[field] = (reasons[field] ?? 0) + 1;
  }
  console.log(`  missing: ${Object.entries(reasons).map(([f, n]) => `${f} ${n}`).join(", ")}`);
}

// Cheapest to verify first, so the operator's queue is filled in the order that
// wins the most coverage per decision.
let ranked = rankCandidates(has("include-incomplete") ? [...complete, ...incomplete] : complete);
if (limit) ranked = ranked.slice(0, limit);

if (!has("no-menus")) {
  console.log(`\nLooking for menu pages on ${ranked.length} site(s)...`);
  let found = 0;
  for (const [index, candidate] of ranked.entries()) {
    const website = candidate.discovery?.website;
    if (!website) continue;
    const menu = await resolveMenuURL(website);
    if (menu.url) {
      candidate.menuURL = menu.url;
      candidate.discovery.menuConfidence = menu.score;
      if (menu.likelyDocument) candidate.discovery.likelyDocument = true;
      // A JavaScript ordering platform serves an empty page to a plain fetch.
      // This is a fact about how to retrieve the source, not a claim about what
      // is on it, so setting it costs nothing if the guess is wrong.
      if (menu.javascriptPlatform) candidate.extractionMode = "browser_required";
      found += 1;
    } else {
      candidate.discovery.menuLookup = menu.reason;
    }
    if ((index + 1) % 25 === 0) console.log(`  ${index + 1}/${ranked.length}...`);
    if (delayMs > 0) await new Promise((done) => setTimeout(done, delayMs));
  }
  console.log(`  found ${found} menu page(s); ${ranked.length - found} need one by hand.`);
}

const path = resolve(out);
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, `${JSON.stringify({ restaurants: ranked }, null, 2)}\n`);

const counts = summarize(ranked);
const importable = ranked.filter((candidate) => candidate.menuURL).length;
console.log([
  "",
  `Wrote ${ranked.length} candidate(s) to ${out}`,
  "",
  `  likely wholly vegan/vegetarian  ${String(counts.whollyMeatless).padStart(4)}  <- start here`,
  `  tagged meat-free friendly       ${String(counts.meatlessFriendly).padStart(4)}`,
  `  unknown                         ${String(counts.unknown).padStart(4)}`,
  "",
  `  ${importable} of ${ranked.length} have a menu URL and can be imported now.`,
  "",
  "  Those rankings come from OpenStreetMap's diet tags, which are assertions by",
  "  map contributors and NOT by the restaurants. They decide review order only.",
  "  No menuProfile is set: what a restaurant claims about its own menu is still",
  "  yours to record, and it is the one thing that publishes without review.",
  "",
  "  Next:  npm run import-restaurants -- " + out + " --dry-run",
  "",
  "  Data (c) OpenStreetMap contributors, ODbL. Attribution is required, and",
  "  redistributing a database built from it carries share-alike obligations."
].join("\n"));

// A run that found nobody is more likely a wrong bounding box than an empty city.
if (ranked.length === 0) process.exitCode = 1;
