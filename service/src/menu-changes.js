// Turns a detected source change into a reviewable proposal.
//
// The division of labour this file sits in the middle of matters more than any
// of its code: the checker *detects* that an official page changed, this module
// *interprets* what changed, and a person *publishes* the result. A changed
// webpage never becomes a changed dietary claim on its own. Nothing here writes
// to menu_items; the most it does is record a description of what it would
// propose, for somebody to accept or throw away.

import { validateMenuItems } from "./catalog-input.js";
import { fingerprint, loadSource } from "./checker.js";
import { extractMenu, TIERS } from "./extraction.js";
import { LLM_TIER, proposeWithModel } from "./llm-extraction.js";
import { diffMenu } from "./menu-diff.js";
import { looksBinary, loadClaimPage } from "./menu-source.js";
import { stableItemID } from "./proposals.js";

export async function proposeMenuChanges(store, restaurant, {
  fetchImpl, browserFetchImpl,
  // Never defaulted from the environment. A change-proposal pass runs over every
  // restaurant whose source moved, so a client acquired implicitly would turn a
  // routine check cycle into a bill nobody asked for. Callers opt in.
  modelClient = null, modelName,
  now = () => new Date()
} = {}) {
  const outcome = { restaurantID: restaurant.id, name: restaurant.name, proposalID: null };

  if (restaurant.menu_profile === "manual") {
    return { ...outcome, skipped: "Operator opted this restaurant out of automated extraction" };
  }

  const fetched = await loadSource(restaurant, { fetchImpl, browserFetchImpl });
  const { hash, snapshot } = fingerprint(fetched);
  const capturedAt = now().toISOString();

  // The proposal cites the source it actually read, not the one the checker read
  // an hour ago. If the page moved again in between, this records that version
  // and diffs against it rather than quietly attributing one reading to another.
  const sourceSnapshotID = await store.ensureSnapshot({
    restaurantID: restaurant.id, hash, normalizedSource: snapshot, capturedAt
  });
  // Resolved from the transition the checker recorded, not from snapshot capture
  // times — a source that returns to an earlier state reuses that snapshot row,
  // so timestamps do not order snapshots by when they were live.
  const previousSnapshotID = await store.priorSnapshotID(restaurant.id, hash);

  const reading = await readMenu(restaurant, fetched.text, { fetchImpl, modelClient, modelName });
  const reasons = [...reading.reasons];

  // Identity is derived from the dish name, which is what lets an unchanged dish
  // match its published row instead of looking like a retirement plus an add.
  const candidates = reading.items.map((item) => ({
    ...item, id: stableItemID(restaurant.id, item.name)
  }));

  // Validated per item rather than in a batch: one dish with an unusable price
  // should cost that dish, not the whole proposal. What is dropped is reported,
  // because a silently shorter menu reads as a retirement.
  const usable = [];
  for (const candidate of candidates) {
    const checked = validateMenuItems([candidate]);
    if (checked.valid) usable.push(checked.value[0]);
    else reasons.push(`Dropped "${candidate.name}": ${checked.errors.join("; ")}`);
  }

  const published = await store.getPublishedItems(restaurant.id);
  const { operations, ambiguities } = diffMenu({
    published, extracted: usable, tier: reading.tier, readable: reading.readable
  });

  // A source can change without its menu changing — a rotated banner image, a
  // new footer. Recording a proposal with nothing in it would train whoever
  // reads the queue to skim it.
  if (operations.length === 0 && ambiguities.length === 0) {
    return { ...outcome, tier: reading.tier, operations: [], ambiguities: [], reasons,
      unchanged: true };
  }

  const proposalID = await store.createChangeProposal({
    restaurantID: restaurant.id,
    sourceSnapshotID,
    previousSnapshotID,
    tier: reading.tier,
    ambiguities,
    operations,
    createdAt: capturedAt,
    note: reasons.length ? reasons.join("\n") : null
  });

  return { ...outcome, proposalID, tier: reading.tier, operations, ambiguities, reasons };
}

// Interprets every change a check cycle detected. The checker leaves behind the
// fact that a page moved; this turns that into a description of what moved, for
// each restaurant it applies to.
//
// It re-fetches rather than reusing what the checker read a moment ago. That
// costs one request per *changed* source — a small set by construction — and
// buys the guarantee that a proposal always cites the source it was actually
// computed from, even if the page moved again in between.
export async function proposeChangesForResults(store, results, {
  logger = console, ...options
} = {}) {
  const proposals = [];
  for (const result of results.filter((entry) => entry.status === "changed")) {
    const target = await store.getCheckTarget(result.id);
    if (!target) continue;
    try {
      const outcome = await proposeMenuChanges(store, target, options);
      if (outcome.skipped) {
        logger.log(`SKIPPED   ${outcome.name}: ${outcome.skipped}`);
      } else if (outcome.unchanged) {
        logger.log(`NO DIFF   ${outcome.name}: source changed but its menu did not`);
      } else {
        proposals.push(outcome);
        logger.log(
          `PROPOSED  ${outcome.name}: ${outcome.operations.length} operation(s)` +
          (outcome.ambiguities.length ? `, ${outcome.ambiguities.length} to check` : "")
        );
      }
    } catch (error) {
      // One unreadable source must not stop the rest from being interpreted.
      // The restaurant is already queued for review either way.
      logger.error(`FAILED    ${result.name}: ${error.message ?? error}`);
    }
  }
  return proposals;
}

// Reads the fetched document with the same tiering the drafting pipeline uses,
// and reports whether it managed to read it at all. That distinction carries the
// weight here: a menu that lists no qualifying dishes and a menu we could not
// parse produce the same empty list, and only one of them means the restaurant
// stopped serving them.
async function readMenu(restaurant, html, { fetchImpl, modelClient, modelName }) {
  if (looksBinary(html)) {
    return {
      tier: TIERS.MANUAL, items: [], readable: false,
      reasons: [
        "The official source is a PDF or other binary document. Its change was " +
        "detected, but its dishes cannot be read as text."
      ]
    };
  }

  const claim = await loadClaimPage(restaurant, fetchImpl);
  const extraction = extractMenu(html, {
    menuProfile: restaurant.menu_profile, claimHTML: claim.html
  });
  const reasons = [...extraction.reasons];
  if (claim.error) reasons.push(claim.error);

  if (extraction.tier !== TIERS.MANUAL) {
    return { tier: extraction.tier, items: extraction.items, readable: true, reasons };
  }

  if (!modelClient) {
    // Reaching the manual tier means the menu publishes no legend and makes no
    // whole-menu claim, so nothing here can tell a withdrawn dish from an
    // unreadable one. Saying "no items" would propose retiring the entire menu.
    return {
      tier: TIERS.MANUAL, items: [], readable: false,
      reasons: [...reasons, "This menu publishes no dietary legend, so its dishes cannot be compared automatically"]
    };
  }

  const drafted = await proposeWithModel(html, {
    restaurantName: restaurant.name, client: modelClient, model: modelName
  });
  return {
    tier: LLM_TIER,
    items: drafted.items,
    readable: !drafted.unreadable,
    reasons: [
      ...reasons,
      drafted.unreadable
        ? "Model judged this page not to be a readable menu"
        : `Model read ${drafted.items.length} item(s) from the new source` +
          (drafted.dropped.length
            ? `; ${drafted.dropped.length} discarded for unverifiable evidence`
            : ""),
      ...(drafted.notes ? [`Model notes: ${drafted.notes}`] : [])
    ]
  };
}
