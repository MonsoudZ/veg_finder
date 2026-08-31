// Turns an official menu page into *proposals*, never directly into published
// dietary claims.
//
// The one rule this file exists to enforce: a proposal may only ever restate a
// claim the restaurant itself makes. Two things count as such a claim.
//
//   1. The restaurant says its whole menu is vegan.
//   2. The menu marks a dish with a symbol, and the menu also publishes a legend
//      saying what that symbol means.
//
// Nothing is inferred from a dish name or its ingredients. "Veggie Burger",
// "garden salad" and "contains no meat" are not evidence, and a marker whose
// meaning the menu never defines is not evidence either. Anything outside those
// two cases is left for a human, which is the whole point of tiering.

export const TIERS = {
  FULLY_VEGAN: "fully_vegan",
  FULLY_VEGETARIAN: "fully_vegetarian",
  LABELLED_MENU: "labelled_menu",
  MANUAL: "manual"
};

// Deliberately narrow. A missed dish costs coverage; a wrong one costs the trust
// of somebody who cannot eat it.
// Plenty of menus print prices without a currency symbol, so a bare amount with
// two decimal places counts too. Two decimals is what keeps this from matching
// quantities, years, and serving sizes.
const PRICE = /\$\s?\d{1,3}(?:[.,]\d{2})?(?:\s*[–—-]\s*\$?\s?\d{1,3}(?:[.,]\d{2})?)?|\b\d{1,3}\.\d{2}\b/;

// A marker may share its bracket with other codes — "(V, GF)" is one dish that
// is both vegetarian and gluten-free. The bracket must sit at the end of the
// line and hold nothing but short codes, which is what separates a dietary
// marker from an ingredient note like "(Pork, Chicken, or Tofu (V))" — there the
// (V) qualifies one choice among several, and the dish itself is not vegetarian.
const MARKER = /[(\[{]\s*([a-z]{1,3}(?:\s*[,/]\s*[a-z]{1,3})*)\s*[)\]}](?=\s*$|\s*\$?\s*\d)/i;
const MARKER_GLOBAL = /[(\[{]\s*[a-z]{1,3}(?:\s*[,/]\s*[a-z]{1,3})*\s*[)\]}]/gi;

// "VG = Vegan", "(V) — Vegetarian", "V: vegan".
const LEGEND_ENTRY = /[(\[{]?\s*\b(vgn|vg|ve|v)\b\s*[)\]}]?\s*[=:–—-]\s*(vegan|vegetarian)\b/gi;

// Some menus print the codes on their own line beneath the dish rather than
// beside its name: a price line, a description, then "V/GF". The leading codes
// are the marker; anything after a pipe is a surcharge or a substitution note.
const STANDALONE_MARKER = /^([a-z]{1,3}(?:\s*[,/]\s*[a-z]{1,3})*)\s*(?:\|.*)?$/i;

const WHOLLY_VEGAN_CLAIM = new RegExp([
  /100\s*%\s*(vegan|plant[\s-]?based)/,
  /\b(entirely|completely|fully|all)\s+(vegan|plant[\s-]?based)\b/,
  /\ball\s+(of\s+)?(our\s+)?(food|dishes|menu|items)\s+(is|are)\s+vegan\b/,
  /\b(a|an)?\s*(100\s*%\s*)?vegan\s+(restaurant|cafe|café|bakery|kitchen|eatery|deli)\b/
].map((pattern) => pattern.source).join("|"), "i");

// A dish that only qualifies after a change needs a specific instruction to the
// diner, and guessing that instruction is exactly the kind of inference this
// pipeline refuses to make. Those dishes stay human work.
const CONDITIONAL = /\b(on|upon)\s+request\b|\bavailable\b|\boption(al)?\b|\bsub(stitute)?\b|\bask\b|\bcan\s+be\s+made\b/i;

// Meat-free but not dairy-free. Deliberately narrower than the vegan claim: a
// page saying "vegetarian friendly" or "vegetarian options" is not saying the
// whole menu is meat-free, and must not be read that way.
const WHOLLY_VEGETARIAN_CLAIM = new RegExp([
  /100\s*%\s*vegetarian/,
  /\b(entirely|completely|fully|all)\s+vegetarian\b/,
  /\ball\s+(of\s+)?(our\s+)?(food|dishes|menu|items)\s+(is|are)\s+vegetarian\b/,
  /\b(a|an)?\s*(100\s*%\s*)?vegetarian\s+(restaurant|cafe|café|bakery|kitchen|eatery|deli)\b/
].map((pattern) => pattern.source).join("|"), "i");

export function extractMenu(html, { menuProfile = "unknown" } = {}) {
  const blocks = textBlocks(html);
  const page = blocks.join(" \n ");
  const reasons = [];

  const legend = readLegend(page);
  const operatorSaysVegan = menuProfile === TIERS.FULLY_VEGAN;
  const pageSaysVegan = WHOLLY_VEGAN_CLAIM.test(page);

  if (operatorSaysVegan) reasons.push("Operator recorded this restaurant as entirely vegan");
  else if (pageSaysVegan) reasons.push("The page states the whole menu is vegan");

  if (operatorSaysVegan || pageSaysVegan) {
    return {
      tier: TIERS.FULLY_VEGAN,
      assertedBy: operatorSaysVegan ? "operator" : "detection",
      legend: null,
      reasons,
      items: collectItems(blocks, () => ({ dietaryStatus: "Vegan" }))
    };
  }

  const operatorSaysVegetarian = menuProfile === TIERS.FULLY_VEGETARIAN;
  const pageSaysVegetarian = WHOLLY_VEGETARIAN_CLAIM.test(page);
  if (operatorSaysVegetarian) reasons.push("Operator recorded this restaurant as entirely vegetarian");
  else if (pageSaysVegetarian) reasons.push("The page states the whole menu is vegetarian");

  if (operatorSaysVegetarian || pageSaysVegetarian) {
    return {
      tier: TIERS.FULLY_VEGETARIAN,
      assertedBy: operatorSaysVegetarian ? "operator" : "detection",
      legend: null,
      reasons,
      // Meat-free, but the cheese is real cheese.
      items: collectItems(blocks, () => ({ dietaryStatus: "Vegetarian" }))
    };
  }

  if (legend) {
    reasons.push(
      `Menu publishes a legend: ${Object.entries(legend)
        .map(([marker, meaning]) => `${marker.toUpperCase()} = ${meaning}`).join(", ")}`
    );
    const trailing = trailingMarkers(blocks, legend);
    const items = collectItems(blocks, (block, index) => {
      const match = block.match(MARKER);
      if (!match) {
        // No marker beside the name; look for one printed below the dish.
        const meaning = trailing.get(index);
        if (!meaning) return null;
        if (CONDITIONAL.test(block)) return null;
        return { dietaryStatus: meaning === "vegan" ? "Vegan" : "Vegetarian" };
      }
      // Take the dietary code from the bracket and ignore the rest ("GF", "N").
      const meanings = match[1].split(/[,/]/)
        .map((code) => legend[code.trim().toLowerCase()])
        .filter(Boolean);
      // Two different dietary codes on one dish is a menu we do not understand.
      if (new Set(meanings).size !== 1) return null;
      const [meaning] = meanings;
      // A marker qualified by "on request" describes a dish that must be changed.
      // The change itself is never guessed here.
      if (CONDITIONAL.test(block)) return null;
      return { dietaryStatus: meaning === "vegan" ? "Vegan" : "Vegetarian" };
    });
    if (items.length > 0) {
      return { tier: TIERS.LABELLED_MENU, assertedBy: "menu-legend", legend, reasons, items };
    }
    reasons.push("Legend found but no dish carried a defined marker");
  } else {
    reasons.push("No dietary legend found, so any marker on this menu is undefined");
  }

  return { tier: TIERS.MANUAL, assertedBy: null, legend, reasons, items: [] };
}

function collectItems(blocks, classify) {
  const items = [];
  const seen = new Set();

  for (const [index, block] of blocks.entries()) {
    const decision = classify(block, index);
    if (!decision) continue;

    // Menus overwhelmingly put the price on its own line beneath the dish, so a
    // dish line and its price are different blocks. Requiring both in one block
    // silently dropped every menu laid out that way.
    const inline = block.match(PRICE);
    const price = inline
      ? inline[0].replace(/\s+/g, "")
      : priceOnFollowingLine(blocks[index + 1]);
    if (!price) continue;

    const name = readName(block);
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
      name,
      price,
      description: "",
      dietaryStatus: decision.dietaryStatus,
      modificationNote: null,
      // The exact line the claim came from, so a reviewer can check it without
      // refetching the page.
      sourceEvidence: block.slice(0, 500)
    });
  }
  return items;
}

// Walks the page attaching each standalone marker line to the dish above it. A
// dish owns every line from its own until the next dish begins, so a marker in
// that span belongs to it. Codes the legend does not define are ignored — "VO"
// (vegan option) is a convention, not something this menu defined, and guessing
// it would be inference.
function trailingMarkers(blocks, legend) {
  const owners = new Map();
  let dish = null;
  let ownPriceLine = -1;
  for (const [index, block] of blocks.entries()) {
    if (index === ownPriceLine) continue;
    if (priceOnFollowingLine(blocks[index + 1]) && readName(block)) {
      dish = index;
      ownPriceLine = index + 1;
      continue;
    }
    // Any other priced line starts something new — often a dish whose price is
    // written inline, like "Full $17 | Half $12". Close the window rather than
    // let the next dish's marker drift up onto this one.
    if (PRICE.test(block)) {
      dish = null;
      continue;
    }
    if (dish === null || owners.has(dish)) continue;
    const match = block.match(STANDALONE_MARKER);
    if (!match) continue;
    const meanings = match[1].split(/[,/]/)
      .map((code) => legend[code.trim().toLowerCase()])
      .filter(Boolean);
    if (new Set(meanings).size === 1) owners.set(dish, meanings[0]);
  }
  return owners;
}

// A price line beneath a dish is rarely bare. Menus write "Half 11.75 | Whole
// 17.25", "$6.00 ea.", "cup 4.50 or bowl 7.50" — a price with the size or option
// it applies to. The whole line is kept as the price, because "Half 11.75 | Whole
// 17.25" is what the diner needs to see, not "11.75".
//
// Every number must still be a recognisable price: a currency amount or two
// decimal places. Bare integers are excluded deliberately — "1 Egg",
// "3 Wise Men (Ve,GF)" and "(720)-532-0757" all contain one, and treating those
// as prices attaches nonsense to a dish or invents a dish out of a phone number.
const PRICE_GLOBAL = new RegExp(PRICE.source, "g");
const MAX_PRICE_LINE_LENGTH = 60;

// The words a menu puts next to a price. Anything else beside a number is a
// dish name or a description — "Lamb Kofta $18" is the next dish, not this
// dish's price, and reading it as one silently mis-prices the dish above.
const SIZE_WORDS = new Set([
  "half", "whole", "full", "side", "cup", "bowl", "ea", "each", "sm", "small",
  "md", "medium", "lg", "large", "reg", "regular", "oz", "pc", "pcs", "piece",
  "slice", "single", "double", "or", "and", "per", "add", "gf", "v", "vg"
]);

function priceOnFollowingLine(next) {
  if (!next || next.length > MAX_PRICE_LINE_LENGTH) return null;
  if (!PRICE.test(next)) return null;

  const labels = (next.replace(PRICE_GLOBAL, " ").match(/[a-z]+/gi) ?? [])
    .map((label) => label.toLowerCase());
  const prices = next.match(PRICE_GLOBAL) ?? [];
  const separated = /[|/]/.test(next) || labels.includes("or");

  // A bare price; a price beside recognised size words; or several prices split
  // by a separator, which is how a menu writes one dish at two sizes.
  const usable = labels.length === 0
    || labels.every((label) => SIZE_WORDS.has(label))
    || (prices.length > 1 && separated);
  if (!usable) return null;

  // The whole line is the price: "Half 11.75 | Whole 17.25" is what a diner
  // needs to see, not "11.75".
  return next.replace(/\s+/g, " ").trim();
}

function readName(block) {
  const name = block
    .replace(MARKER_GLOBAL, " ")
    .replace(new RegExp(PRICE.source, "g"), " ")
    .replace(/[.·•|–—-]+\s*$/, "")
    .replace(/^\s*[.·•|–—-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 2 || name.length > 80) return null;
  if (!/[a-z]/i.test(name)) return null;
  return name;
}

function readLegend(page) {
  const legend = {};
  const conflicting = new Set();
  for (const match of page.matchAll(LEGEND_ENTRY)) {
    const marker = match[1].toLowerCase();
    const meaning = match[2].toLowerCase();
    if (legend[marker] && legend[marker] !== meaning) conflicting.add(marker);
    legend[marker] = meaning;
  }
  // A menu that defines the same symbol two ways defines nothing usable.
  for (const marker of conflicting) delete legend[marker];
  return Object.keys(legend).length > 0 ? legend : null;
}

// Recovers per-dish lines. Flattening the whole page to one string loses the
// boundary between a dish and its neighbour, which is what makes a marker
// attributable to the right dish.
export function textBlocks(html) {
  return String(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\s*(br|hr)\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|td|th|h[1-6]|section|article|dt|dd|figcaption)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map(decodeEntities)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;|&#8217;/gi, "'")
    .replace(/&lt;|&#60;/gi, "<")
    .replace(/&gt;|&#62;/gi, ">")
    .replace(/&eacute;|&#233;/gi, "é");
}
