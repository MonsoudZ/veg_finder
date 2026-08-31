// Loads hand-drafted dietary statuses into the review queue.
//
// Tiers 1 and 2 read a restaurant's own whole-menu claim; tier 3 reads a menu's
// own dietary legend. A menu with neither is out of reach of all of them, and on
// the Capitol Hill pilot that is a third of the restaurants. Until a model is
// drafting them, a person can, and this loads that work through exactly the same
// gate a model's draft goes through: every entry carries a quote, the live page
// is re-fetched, and any entry whose quote is not on the page is discarded
// rather than trusted. Nothing loaded here publishes; a reviewer decides.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fetchSource } from "./checker.js";
import { LLM_TIER, readableMenu, verifyProposals } from "./llm-extraction.js";
import { serviceRoot } from "./paths.js";
import { openStore } from "./store.js";

const draftsPath = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(serviceRoot, "data/drafts/capitol-hill-unlabelled.json");

const drafts = JSON.parse(readFileSync(draftsPath, "utf8"));
const store = await openStore();
await store.ensureSeeded();

const targets = new Map((await store.listCheckTargets()).map((row) => [row.name, row]));

let kept = 0;
let dropped = 0;
for (const restaurant of drafts.restaurants) {
  const target = targets.get(restaurant.name);
  if (!target) {
    console.error(`SKIPPED  ${restaurant.name}: not in the catalog`);
    continue;
  }
  try {
    const menu = readableMenu(await fetchSource(target, {}));
    const verified = verifyProposals(restaurant.items, menu);
    // Saved even when empty, so a menu that has been rewritten since the drafts
    // were written clears its stale proposals rather than leaving them pending.
    await store.saveProposals(target.id, { tier: LLM_TIER, items: verified.kept });
    kept += verified.kept.length;
    dropped += verified.dropped.length;
    console.log(
      `${restaurant.name}: ${verified.kept.length} verified against the live page` +
      (verified.dropped.length ? `, ${verified.dropped.length} discarded` : "")
    );
    for (const entry of verified.dropped) {
      console.log(`    DISCARDED "${entry.item?.name ?? "(unnamed)"}": ${entry.reason}`);
    }
  } catch (error) {
    console.error(`FAILED   ${restaurant.name}: ${error.message ?? error}`);
  }
}

console.log(`\n${kept} proposals awaiting review, ${dropped} discarded as unverifiable.`);
await store.close();
