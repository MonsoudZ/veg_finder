// Bulk-onboards a list of candidate restaurants. See candidate-import.js for
// what this will and will not do on your behalf.
//
//   npm run import-restaurants -- data/candidates/denver.json
//   npm run import-restaurants -- candidates.json --dry-run
//   npm run import-restaurants -- candidates.json --model --delay=2000
//
// Every candidate needs a name, neighborhood, address, latitude, longitude, and
// menuURL. Coordinates are not looked up here: geocoding is a separate concern
// with its own failure modes, and a silently mislocated restaurant is worse than
// one that was refused.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  formatSummary, importCandidates, readCandidates, reportOf
} from "./candidate-import.js";
import { createExtractionClient } from "./llm-extraction.js";
import { autoPublishTiers } from "./proposals.js";
import { openStore } from "./store.js";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const flag = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const candidatePath = args.find((arg) => !arg.startsWith("--"));
const delayFlag = args.find((arg) => arg.startsWith("--delay="));

if (!candidatePath) {
  console.error(
    "Usage: npm run import-restaurants -- <candidates.json> [--dry-run] [--model] " +
    "[--no-extract] [--delay=ms] [--report=<file.json>]"
  );
  process.exit(2);
}

const { candidates, invalid, fatal } = readCandidates(
  JSON.parse(readFileSync(resolve(candidatePath), "utf8"))
);
if (fatal) {
  console.error(fatal);
  process.exit(2);
}

const dryRun = flags.has("--dry-run");
// Opt-in, and stated plainly, because this is the one flag that spends money.
// A model reading an unlabelled menu still never publishes; it only drafts for
// a reviewer, so the cost buys review material rather than coverage.
const modelClient = flags.has("--model") ? createExtractionClient() : null;
if (flags.has("--model") && !modelClient) {
  console.error("--model needs ANTHROPIC_API_KEY to be set.");
  process.exit(2);
}

const store = await openStore();
await store.ensureSeeded();

const tiers = autoPublishTiers(process.env.AUTO_PUBLISH_TIERS);
console.log(
  `${candidates.length} candidate(s) read from ${candidatePath}` +
  (invalid.length ? `, ${invalid.length} rejected before import` : "")
);
console.log(`Tiers allowed to publish without review: ${[...tiers].join(", ") || "(none)"}`);
if (modelClient) console.log("Model drafting enabled for menus with no dietary legend.");
if (dryRun) console.log("Dry run: nothing will be written.\n");

const summary = await importCandidates(store, candidates, {
  extract: !flags.has("--no-extract") && !dryRun,
  tiers,
  modelClient,
  model: process.env.EXTRACTION_MODEL,
  delayMs: delayFlag ? Number(delayFlag.split("=")[1]) : 1_000,
  dryRun
});

console.log(formatSummary(summary, { invalid }));

// A batch is only interpretable next to the ones before it: the question is
// whether the zero-touch ratio holds as discovery moves out of the neighbourhood
// it was tuned on. Written as data so two runs can be compared rather than
// remembered.
const reportPath = flag("report");
if (reportPath) {
  const path = resolve(reportPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    source: resolve(candidatePath),
    importedAt: new Date().toISOString(),
    modelDrafting: Boolean(modelClient),
    autoPublishTiers: [...tiers],
    invalid: invalid.length,
    ...reportOf(summary)
  }, null, 2)}\n`);
  console.log(`\n  Report written to ${reportPath}`);
}

await store.close();

// A file whose entries could not be read is worth a non-zero exit, so a scripted
// import does not look like it succeeded.
if (invalid.length > 0 || summary.failed.length > 0) process.exitCode = 1;
