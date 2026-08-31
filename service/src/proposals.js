// Runs extraction against a restaurant's official source and applies the
// publishing policy. Extraction proposes; this decides whether a proposal is
// allowed to publish itself or has to wait for a person.

import { createHash } from "node:crypto";
import { validateMenuItems } from "./catalog-input.js";
import { fetchSource } from "./checker.js";
import { extractMenu, TIERS } from "./extraction.js";
import { createExtractionClient, LLM_TIER, proposeWithModel } from "./llm-extraction.js";

// Which tiers may publish without a human. Defaults to the single case where the
// restaurant itself has been recorded as entirely vegan by an operator: there is
// no per-dish judgement left to make. Everything else waits for review until an
// operator widens this deliberately.
export function autoPublishTiers(value = process.env.AUTO_PUBLISH_TIERS) {
  const configured = value == null
    ? new Set([TIERS.FULLY_VEGAN])
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
  modelClient = createExtractionClient(), modelName
} = {}) {
  if (restaurant.menu_profile === "manual") {
    return {
      restaurantID: restaurant.id, name: restaurant.name, tier: TIERS.MANUAL,
      reasons: ["Operator opted this restaurant out of automated extraction"],
      items: [], published: false
    };
  }

  const html = await fetchSource(restaurant, { fetchImpl, browserFetchImpl });
  const extraction = extractMenu(html, { menuProfile: restaurant.menu_profile });

  // Tiers 1 and 2 read the restaurant's own labelling. When the menu carries
  // none, the choice is a human reading it or a model drafting for a human —
  // and the draft is only worth having because its evidence is verified.
  if (extraction.tier === TIERS.MANUAL && modelClient) {
    const drafted = await proposeWithModel(html, {
      restaurantName: restaurant.name, client: modelClient, model: modelName
    });
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

  const publishable = validated.valid && result.items.length > 0 && tiers.has(extraction.tier);
  if (!publishable) {
    if (!tiers.has(extraction.tier)) {
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
  return extraction.tier === TIERS.FULLY_VEGAN
    ? "Every dish on this menu; the restaurant states its whole menu is vegan"
    : "Dishes the official menu marks with its own dietary legend";
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
