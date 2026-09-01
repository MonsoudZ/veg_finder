// Finds a restaurant's menu page from its homepage.
//
// A places source gives you a website; this pipeline needs a menu. Bridging that
// gap is the difference between a list of restaurants and a list of things that
// can actually be verified, and it is the one step with no authoritative answer
// — so this guesses, scores its guess, and says how confident it is rather than
// pretending.
//
// The trap worth naming: "menu" is the most overloaded word on a web page. Every
// site has a navigation menu, a hamburger menu, a "skip to menu" link. Matching
// the word alone points at a UI control roughly as often as at food, so the
// interface senses are scored *down* rather than merely not scored up.

import { hasDishContent } from "./extraction.js";

// Ordering platforms that render their menu with JavaScript. The catalog already
// knows how to fetch these through a headless browser; naming them here lets an
// operator set extractionMode without discovering the empty page first.
const JAVASCRIPT_PLATFORMS =
  /toasttab|squareup|square\.site|clover|doordash|ubereats|grubhub|chownow|popmenu|bentobox|olo\.com|slicelife/i;

// A navigation control, not food. Scored down hard: a false positive here sends
// the whole pipeline to fingerprint a page with no dishes on it.
const INTERFACE_SENSE =
  /toggle|hamburger|skip\s+to|close\s+menu|open\s+menu|main\s+menu|nav(igation)?\s*menu|mobile\s+menu|menu\s*(button|icon|bar|toggle)/i;

const MENU_WORD = /\bmenus?\b/i;
const FOOD_WORDS = /\b(food|dinner|lunch|breakfast|brunch|drinks|eat|dine|order)\b/i;
const LINK = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

export function findMenuURL(html, pageURL) {
  const base = safeURL(pageURL);
  if (!base) return null;

  const scored = [];
  for (const match of String(html ?? "").matchAll(LINK)) {
    const [, href, inner] = match;
    const target = resolve(href, base);
    if (!target) continue;

    const text = stripTags(inner);
    const path = decodeURIComponent(target.pathname).toLowerCase();
    const haystack = `${text} ${path}`;

    // Judged on the link text and the path only. A query string or fragment
    // carries tracking noise that matches these words by accident.
    if (INTERFACE_SENSE.test(haystack)) continue;

    let score = scorePath(path);
    if (/^\s*(view\s+|our\s+|the\s+|see\s+)?menus?\s*$/i.test(text)) score += 9;
    else if (MENU_WORD.test(text)) score += 5;
    if (FOOD_WORDS.test(haystack)) score += 2;
    const platform = JAVASCRIPT_PLATFORMS.test(target.hostname);
    const sameOrigin = target.origin === base.origin;
    if (sameOrigin) score += 3;
    // An ordering platform *is* the menu for a great many restaurants, so a link
    // to one is evidence rather than noise — enough to carry a link whose text
    // says "menu" but whose path does not.
    else if (platform) score += 4;
    // A menu on a third domain that is neither this restaurant's nor a known
    // ordering platform is usually a parent brand's. Found in the wild: a vegan
    // restaurant's site linked to its franchise owner's menu, which belongs to a
    // hot dog chain. Accepting it would have filed beef and sausage under a
    // restaurant tagged vegan-only, which is the precise failure this catalog
    // exists to prevent — and no score is worth trusting against that, because
    // the link looks perfect. It reads "Menu" and it points at /menu/.
    //
    // So it is never the answer. It is offered to a person as an alternative,
    // and the restaurant is reported as needing a menu URL by hand.
    const crossBrand = !sameOrigin && !platform;
    // A menu mentioned in an article is being written about, not served.
    if (/\/(blog|news|press|article|post|stories)\//.test(path)) score -= 6;
    // A PDF or image menu is a legitimate source — it fingerprints, it just has
    // to be transcribed by a person. Worth finding, worth flagging.
    const isDocument = /\.(pdf|jpe?g|png|webp)$/i.test(path);
    if (isDocument) score += 1;

    if (score <= 0) continue;
    scored.push({
      url: target.toString(),
      score,
      crossBrand,
      sameOrigin,
      likelyDocument: isDocument,
      javascriptPlatform: JAVASCRIPT_PLATFORMS.test(target.hostname),
      text: text.slice(0, 80)
    });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.url.length - b.url.length);

  // A cross-brand link is never chosen, only offered.
  const best = scored.find((entry) => !entry.crossBrand);
  if (!best) {
    return {
      url: null,
      reason: "the only menu link found belongs to another domain, which is usually a parent brand",
      alternatives: scored.slice(0, 3).map((entry) => entry.url)
    };
  }
  // Below this a "match" is a stray word rather than a link to a menu, and a
  // wrong menu URL is worse than none: it fingerprints a page that never
  // changes and reports coverage nobody can eat from.
  if (best.score < 8) return null;
  return { ...best, alternatives: scored.slice(1, 4).map((entry) => entry.url) };
}

// A link to a menu that is a document rather than a page. Its dishes cannot be
// read as text, but its bytes fingerprint, which is exactly what the catalog's
// menu_document verification method is for.
const DOCUMENT_LINK = /\.(pdf|jpe?g|png|webp)(\?|$)/i;

// Fetches a homepage and looks for its menu. Never throws: a site that is down,
// slow, or hostile to robots is a candidate for a person to finish, not a reason
// to lose the whole discovery run.
export async function resolveMenuURL(website, {
  fetchImpl = fetch, timeoutMs = 15_000, followDocuments = true
} = {}) {
  const home = await load(website, fetchImpl, timeoutMs);
  if (home.error) return { url: null, reason: home.error };

  const found = findMenuURL(home.text, home.url);
  if (!found) return { url: null, reason: "no menu link found on the homepage" };
  // findMenuURL returns a url-less result with its own reason when the only
  // candidate belonged to another brand. Keeping that reason matters: "we found
  // a menu and refused it" is a different job for a person than "there was
  // nothing here".
  if (!found.url) return found;
  if (!followDocuments || found.likelyDocument) return { ...found, reason: null };

  // One more hop, and only one. Plenty of restaurants publish a page called
  // "Menu" whose entire content is links to PDFs — found in the wild on a
  // restaurant whose four menus were all documents behind a landing page with
  // fifty lines of navigation and no food. Stopping at the landing page records
  // a menu URL that fingerprints perfectly and never contains a dish, so the
  // restaurant sits in the catalog looking checked and holding nothing.
  const page = await load(found.url, fetchImpl, timeoutMs);
  if (page.error || hasDishContent(page.text)) return { ...found, reason: null };

  const documents = menuDocuments(page.text, page.url);
  if (documents.length === 0) return { ...found, reason: null };

  return {
    ...found,
    url: documents[0],
    likelyDocument: true,
    // Its dishes have to be transcribed by a person, and its bytes are still
    // fingerprinted every cycle, so an edit to it is caught.
    verificationMethod: "menu_document",
    landingPage: found.url,
    documents,
    reason: null
  };
}

// Menu documents linked from a page, best first. A restaurant with four PDFs has
// a main one and three others; the shortest menu-ish name is the usual winner
// ("Dinner-Menu.pdf" over "Happy-Hour-6-x-85-in.pdf").
function menuDocuments(html, pageURL) {
  const base = safeURL(pageURL);
  if (!base) return [];
  const found = [];
  for (const match of String(html ?? "").matchAll(LINK)) {
    const target = resolve(match[1], base);
    if (!target || !DOCUMENT_LINK.test(target.pathname)) continue;
    const text = stripTags(match[2]);
    // The word has to appear somewhere, or a press photo becomes the menu.
    if (!MENU_WORD.test(`${text} ${decodeURIComponent(target.pathname)}`)) continue;
    if (!found.includes(target.toString())) found.push(target.toString());
  }
  return found.sort((a, b) => a.length - b.length);
}

async function load(url, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(url, {
      headers: { "user-agent": "VegFinderDiscovery/0.1 (+restaurant catalog research)" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return { text: await response.text(), url: response.url || url };
  } catch (error) {
    return { error: String(error.message ?? error) };
  }
}

// How much the URL path itself says this is a menu. The distinction that matters
// is between a path *about* menus and a path that mentions the word: "/our-menu"
// is a menu, "/blog/our-new-menu-designer-profile" is an article. A short segment
// whose words include "menu" is the former; a long slug that happens to contain
// it is the latter.
function scorePath(path) {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "menu" || segment === "menus")) return 8;

  const last = segments[segments.length - 1] ?? "";
  const words = last.split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.some((word) => word === "menu" || word === "menus")) return 0;
  if (words.length === 1) return 10;
  // "dinner-menu", "our-menu", "menu-2024". Past about three words it has
  // stopped being a label and started being a sentence.
  if (words.length <= 3) return 8;
  return 2;
}

function resolve(href, base) {
  const raw = String(href ?? "").trim();
  if (!raw || raw.startsWith("#")) return null;
  if (/^(javascript|mailto|tel|sms):/i.test(raw)) return null;
  try {
    const url = new URL(raw, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function safeURL(value) {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

function stripTags(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
