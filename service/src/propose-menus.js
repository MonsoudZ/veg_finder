// Batch extraction over everything currently awaiting review. Publishes only what
// the configured tiers allow; the rest is printed for a person to work through.
import { createExtractionClient } from "./llm-extraction.js";
import { autoPublishTiers, proposeMenu } from "./proposals.js";
import { openStore } from "./store.js";

const store = await openStore();
await store.ensureSeeded();
const tiers = autoPublishTiers(process.env.AUTO_PUBLISH_TIERS);
const modelClient = createExtractionClient();
console.log(modelClient
  ? "Model drafting enabled for menus with no dietary legend."
  : "No ANTHROPIC_API_KEY: menus with no dietary legend will be left for a person.");
console.log(`Tiers allowed to publish without review: ${[...tiers].join(", ") || "(none)"}`);

const queue = await store.getReviewQueue();
if (queue.length === 0) console.log("Nothing is awaiting review.");

let published = 0;
let proposed = 0;
for (const entry of queue) {
  const target = await store.getCheckTarget(entry.id);
  if (!target) continue;
  try {
    const result = await proposeMenu(store, target, { tiers, modelClient });
    if (result.published) {
      published += 1;
      console.log(`PUBLISHED ${result.name}: ${result.items.length} items (${result.tier})`);
    } else if (result.items.length > 0) {
      proposed += 1;
      console.log(`PROPOSED  ${result.name}: ${result.items.length} items (${result.tier}) — needs review`);
    } else {
      console.log(`MANUAL    ${result.name}: ${result.reasons.join("; ")}`);
    }
  } catch (error) {
    console.error(`FAILED    ${entry.name}: ${error.message ?? error}`);
  }
}

console.log(`\n${published} published, ${proposed} awaiting review, ${queue.length} examined.`);
await store.close();
