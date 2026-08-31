// Tier 3: the model reads an official menu and proposes qualifying dishes.
//
// This tier exists because most menus publish no dietary legend, and a human
// reading every one is what caps the catalog at a few hundred restaurants. It is
// also the tier where a model could invent a dish, or invent a reason a dish
// qualifies, so it is built around one mechanical guard:
//
//   Every proposal must quote the menu verbatim, and every quote is checked
//   against the fetched page before the proposal is allowed to exist.
//
// A quote that is not in the source is not "low confidence" — it is discarded.
// That turns fabricated evidence from a reviewer's judgement call into an
// automatic drop, and it is why this tier is worth running at all.
//
// Output is *always* a proposal for a human. No configuration makes this tier
// publish on its own; see assertNeverAutoPublished in proposals.js.

import Anthropic from "@anthropic-ai/sdk";
import { DIETARY_STATUSES } from "./catalog-input.js";
import { textBlocks } from "./extraction.js";

export const LLM_TIER = "llm_assisted";
export const DEFAULT_MODEL = "claude-opus-5";

// Structured outputs guarantee the shape, so the prompt spends its words on the
// judgement rules instead of on formatting instructions.
const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "The dish name exactly as the menu writes it." },
          description: { type: "string", description: "The menu's own description, or an empty string." },
          price: { type: "string", description: "The price as printed, e.g. \"$12\" or \"$6.50 half\". Empty string if unpriced." },
          dietaryStatus: { type: "string", enum: DIETARY_STATUSES },
          modificationNote: {
            type: "string",
            description:
              "For a \"Can be made ...\" dish only: the exact change the diner must ask for. Empty string otherwise."
          },
          evidence: {
            type: "string",
            description:
              "A verbatim span copied character-for-character from the menu text that supports this dietary status. Never paraphrase, never reconstruct from memory, never join two separate places in the menu."
          },
          reasoning: {
            type: "string",
            description: "One sentence: why the evidence establishes this status."
          }
        },
        required: ["name", "description", "price", "dietaryStatus", "modificationNote", "evidence", "reasoning"],
        additionalProperties: false
      }
    },
    unreadable: {
      type: "boolean",
      description: "True if this text is not a readable menu (an error page, a cookie wall, a JavaScript shell)."
    },
    notes: { type: "string", description: "Anything a human reviewer should know before reading these proposals." }
  },
  required: ["items", "unreadable", "notes"],
  additionalProperties: false
};

const SYSTEM_PROMPT = `You read restaurant menus and propose which dishes a vegan or vegetarian diner can eat. Your proposals are reviewed by a person before anything reaches diners, so your job is to be *useful and honest*, not to be confident.

Someone with a strict dietary commitment — ethical, religious, or an allergy — will act on what is eventually published. A dish you wrongly mark vegan is worse than a dish you leave out.

## Dietary statuses

- "Vegan" — contains no animal products at all: no meat, fish, dairy, egg, honey, gelatin, fish sauce, anchovy, lard, or animal stock.
- "Vegetarian" — no meat or fish, but may contain dairy or egg.
- "Can be made vegan" / "Can be made vegetarian" — qualifies only after a specific change the diner asks for. Give that exact change in modificationNote.

## Evidence — the rule that matters most

Every proposal carries an "evidence" field. It must be a span you copied **character-for-character** from the menu text you were given.

- Copy it. Do not retype it, do not fix its spelling, do not normalize its punctuation or capitalization, do not translate it.
- Quote one continuous span. Do not stitch together text from two different parts of the menu.
- The span must be long enough that a reviewer can see the claim in it — the dish line, or the ingredient list, or the labelled legend entry.
- If you cannot find a span in *this text* that supports a status, do not propose the dish at all.

Evidence is verified programmatically against the page. A quote that does not appear in the source is discarded automatically, and a proposal without usable evidence is worth nothing to the reviewer.

## What to propose

Propose a dish when the menu's own words establish its status:

- The menu labels it (a V/VG marker with a legend, "vegan", "plant-based").
- The menu lists its ingredients and they are all plant-based, or all meat-free.
- The menu states a substitution that makes it qualify ("sub tofu", "vegan cheese available").

## What not to propose

- A dish whose name merely sounds meat-free. "Veggie Burger" is often beef-adjacent or contains egg; "Garden Salad" often arrives with cheese. A name is not evidence.
- A dish whose ingredients are not listed and not labelled. You cannot know what stock the soup uses or whether the pasta contains egg. Leave it out.
- A dish you believe qualifies from general knowledge of this restaurant or this cuisine. Only this text counts.
- Anything from a page that is not a menu.

Common traps worth checking before you call something vegan: parmesan and fish sauce in Caesar dressing and pasta; honey in dressings and glazes; butter on bread, vegetables, and grills; egg in fresh pasta, batter, and brioche; chicken or beef stock in soups, rice, beans, and risotto; gelatin in desserts; lard in refried beans and pastry.

When the menu is ambiguous, propose nothing and say so in notes. An empty result on an unclear menu is the correct answer, not a failure.`;

export function createExtractionClient({ apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

export async function proposeWithModel(sourceText, {
  restaurantName,
  client,
  model = process.env.EXTRACTION_MODEL ?? DEFAULT_MODEL,
  maxTokens = 32_000
} = {}) {
  if (!client) throw new Error("No model client configured. Set ANTHROPIC_API_KEY.");

  const menu = readableMenu(sourceText);
  if (menu.length < 40) {
    return { tier: LLM_TIER, items: [], unreadable: true, notes: "Source contained no readable text.", dropped: [] };
  }

  // The system prompt is identical on every call, so caching it turns the bulk
  // of the input cost into a cache read once a batch gets going.
  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "high", format: { type: "json_schema", schema: PROPOSAL_SCHEMA } },
    messages: [{
      role: "user",
      content: `Menu text for ${restaurantName ?? "an unnamed restaurant"}. Propose the qualifying dishes.\n\n<menu>\n${menu}\n</menu>`
    }]
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(`Model declined to process this menu (${message.stop_details?.category ?? "unspecified"})`);
  }

  const text = message.content.find((block) => block.type === "text")?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Model returned unparseable output");
  }

  const checked = verifyProposals(parsed.items ?? [], menu);
  return {
    tier: LLM_TIER,
    items: checked.kept,
    dropped: checked.dropped,
    unreadable: Boolean(parsed.unreadable),
    notes: parsed.notes ?? "",
    usage: message.usage,
    model: message.model
  };
}

// The guard. Anything the model could not have read off the page is removed
// here rather than left for a reviewer to catch.
export function verifyProposals(items, menu) {
  const haystack = comparable(menu);
  const kept = [];
  const dropped = [];

  for (const item of items) {
    const evidence = String(item?.evidence ?? "").trim();
    const name = String(item?.name ?? "").trim();

    if (!name) {
      dropped.push({ item, reason: "no dish name" });
      continue;
    }
    if (!DIETARY_STATUSES.includes(item?.dietaryStatus)) {
      dropped.push({ item, reason: `unrecognised dietary status "${item?.dietaryStatus}"` });
      continue;
    }
    // Short quotes match by accident; they are not evidence a reviewer can use.
    if (evidence.length < 12) {
      dropped.push({ item, reason: "evidence too short to verify" });
      continue;
    }
    if (!haystack.includes(comparable(evidence))) {
      dropped.push({ item, reason: "evidence does not appear in the source page" });
      continue;
    }

    const needsNote = item.dietaryStatus.startsWith("Can be made");
    const note = String(item.modificationNote ?? "").trim();
    if (needsNote && !note) {
      dropped.push({ item, reason: "modification-dependent dish with no stated modification" });
      continue;
    }

    kept.push({
      name,
      description: String(item.description ?? "").trim(),
      price: String(item.price ?? "").trim(),
      dietaryStatus: item.dietaryStatus,
      modificationNote: needsNote ? note : null,
      sourceEvidence: evidence.slice(0, 2_000),
      reasoning: String(item.reasoning ?? "").trim()
    });
  }

  return { kept, dropped };
}

// Verification compares what a reader would see, not raw bytes: HTML rendering
// collapses whitespace and menus use several dash and quote characters
// interchangeably. Everything else — wording, ingredients, numbers — must match.
function comparable(text) {
  return String(text)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function readableMenu(sourceText) {
  return textBlocks(sourceText).join("\n").slice(0, 200_000);
}
