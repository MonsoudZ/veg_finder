// Runs extraction against a restaurant's official source and applies the
// publishing policy. Extraction proposes; this decides whether a proposal is
// allowed to publish itself or has to wait for a person.

import { createHash } from "node:crypto";
import { validateMenuItems } from "./catalog-input.js";
import { fetchSource } from "./checker.js";
import { extractMenu, TIERS } from "./extraction.js";
import { createExtractionClient, LLM_TIER, proposeWithModel } from "./llm-extraction.js";
import { looksBinary, loadClaimPage } from "./menu-source.js";

// Which tiers may publish without a human. Defaults to the single case where the
// restaurant itself has been recorded as entirely vegan by an operator: there is
// no per-dish judgement left to make. Everything else waits for review until an
// operator widens this deliberately.
// Both are whole-restaurant facts an operator records, leaving no per-dish
// judgement to make.
export const DEFAULT_AUTO_PUBLISH_TIERS = [TIERS.FULLY_VEGAN, TIERS.FULLY_VEGETARIAN];

// Takes the setting rather than reading it, so what publishes is never decided
// by whatever happens to be in the environment of the process running the code.
// The entry points pass process.env.AUTO_PUBLISH_TIERS.
export function autoPublishTiers(value) {
  const configured = value == null
    ? new Set(DEFAULT_AUTO_PUBLISH_TIERS)
    : new Set(value.split(",").map((tier) => tier.trim()).filter(Boolean));

  // Not a policy choice. A model reading an unlabelled menu is inferring, and
  // inference never publishes here no matter how the operator configures it.
  if (configured.delete(LLM_TIER)) {
    console.warn(
      `AUTO_PUBLISH_TIERS lists "${LLM_TIER}", which is not publishable without review. Ignoring it.`
    );
  }
  return configured;
}

export async function proposeMenu(store, restaurant, {
  fetchImpl, browserFetchImpl, tiers = autoPublishTiers(), now = () => new Date(),
  // Not defaulted from the environment: a test that forgot to inject one would
  // otherwise acquire a live, billable client just by having a key set.
  // The entry points supply this explicitly.
  modelClient = null, modelName
} = {}) {
  if (restaurant.menu_profile === "manual") {
    return {
      restaurantID: restaurant.id, name: restaurant.name, tier: TIERS.MANUAL,
      reasons: ["Operator opted this restaurant out of automated extraction"],
      items: [], published: false
    };
  }

  const html = await fetchSource(restaurant, { fetchImpl, browserFetchImpl });

  // Change detection works on a PDF — a fingerprint over the bytes notices an
  // edit perfectly well — but extraction does not, because there is no text to
  // read. Saying so beats the alternative, which was to report that the menu
  // published no dietary legend: true of a PDF in the way it is true of a
  // photograph, and it sends whoever reads it looking for the wrong problem.
  if (looksBinary(html)) {
    return {
      restaurantID: restaurant.id, name: restaurant.name, tier: TIERS.MANUAL,
      reasons: [
        "The official source is a PDF or other binary document. Its changes are " +
        "still detected, but its dishes cannot be read as text, so they have to " +
        "be recorded by a person."
      ],
      items: [], published: false, requiresReview: true
    };
  }

  const claim = await loadClaimPage(restaurant, fetchImpl);
  const extraction = extractMenu(html, {
    menuProfile: restaurant.menu_profile, claimHTML: claim.html
  });
  if (claim.error) extraction.reasons.push(claim.error);

  // Tiers 1 and 2 read the restaurant's own labelling. When the menu carries
  // none, the choice is a human reading it or a model drafting for a human —
  // and the draft is only worth having because its evidence is verified.
  if (extraction.tier === TIERS.MANUAL && modelClient) {
    const drafted = await proposeWithModel(html, {
      restaurantName: restaurant.name, client: modelClient, model: modelName
    });
    await store.saveProposals(restaurant.id, { tier: LLM_TIER, items: drafted.items });
    return {
      restaurantID: restaurant.id,
      name: restaurant.name,
      tier: LLM_TIER,
      assertedBy: "model-proposal",
      legend: null,
      reasons: [
        ...extraction.reasons,
        drafted.unreadable
          ? "Model judged this page not to be a readable menu"
          : `Model drafted ${drafted.items.length} item(s) for review` +
            (drafted.dropped.length ? `; ${drafted.dropped.length} discarded for unverifiable evidence` : ""),
        ...(drafted.notes ? [`Model notes: ${drafted.notes}`] : [])
      ],
      items: drafted.items,
      discarded: drafted.dropped,
      usage: drafted.usage,
      // Structurally never published; a person confirms every one of these.
      published: false,
      requiresReview: true
    };
  }

  // Extraction returns dishes, not database rows. Deriving the id from the dish
  // name keeps it stable across runs, so re-extracting an unchanged menu updates
  // items in place instead of retiring and republishing the whole thing.
  const candidates = extraction.items.map((item) => ({
    ...item, id: stableItemID(restaurant.id, item.name)
  }));
  const validated = validateMenuItems(candidates);

  const result = {
    restaurantID: restaurant.id,
    name: restaurant.name,
    tier: extraction.tier,
    assertedBy: extraction.assertedBy,
    legend: extraction.legend,
    reasons: [...extraction.reasons],
    items: validated.value,
    invalid: validated.errors,
    published: false
  };

  // A whole-menu claim read off a page other than the menu is strong enough to
  // draft every dish from, but not to publish unseen — the claim may belong to a
  // sister restaurant rather than this one. One confirmation covers the whole
  // menu, so this costs a reviewer a single click for all of a restaurant's
  // dishes rather than one per dish.
  const linkedClaim = extraction.assertedBy === "linked-claim";
  const publishable =
    validated.valid && result.items.length > 0 && tiers.has(extraction.tier) && !linkedClaim;
  if (!publishable && result.items.length > 0) {
    // Held back rather than discarded: a reviewer decides on these later.
    await store.saveProposals(restaurant.id, { tier: extraction.tier, items: result.items });
  }
  if (!publishable) {
    if (linkedClaim) {
      result.reasons.push(
        "The whole-menu claim was found on a linked page rather than the menu, " +
        "so one reviewer confirms it before any of these dishes publish"
      );
    } else if (!tiers.has(extraction.tier)) {
      result.reasons.push(`Tier "${extraction.tier}" is not configured to publish without review`);
    }
    if (!validated.valid) result.reasons.push("Extracted items failed validation");
    return result;
  }

  await store.reconcileRestaurant(restaurant.id, {
    coverageStatus: "Complete",
    coverageScope: coverageScopeFor(extraction),
    menuItems: result.items
  });
  result.published = true;
  result.publishedAt = now().toISOString();
  return result;
}

function coverageScopeFor(extraction) {
  switch (extraction.tier) {
    case TIERS.FULLY_VEGAN:
      return "Every dish on this menu; the restaurant states its whole menu is vegan";
    case TIERS.FULLY_VEGETARIAN:
      return "Every dish on this menu; the restaurant states its whole menu is vegetarian";
    default:
      return "Dishes the official menu marks with its own dietary legend";
  }
}

// A name-derived, v5-shaped UUID. Deterministic so the same dish keeps its
// identity, and namespaced per restaurant so two restaurants can share a name.
export function stableItemID(restaurantID, name) {
  const digest = createHash("sha256")
    .update(`${restaurantID}:${name.trim().toLowerCase()}`)
    .digest("hex");
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8), digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32)
  ].join("-");
}
