import assert from "node:assert/strict";
import test from "node:test";
import { findMenuURL, resolveMenuURL } from "../src/menu-url.js";

const page = (body) => `<html><body>${body}</body></html>`;
const HOME = "https://example.com/";

test("a plain menu link is found and resolved against the page", () => {
  const found = findMenuURL(page('<a href="/menu">Menu</a>'), HOME);

  assert.equal(found.url, "https://example.com/menu");
  assert.equal(found.sameOrigin, true);
});

test("a navigation control is not a menu", () => {
  // The trap this module exists for. Every site has one of these, and following
  // it fingerprints a page with no dishes on it while reporting coverage.
  for (const link of [
    '<a href="#nav">Toggle menu</a>',
    '<a href="#main">Skip to menu</a>',
    '<a href="/#mobile-menu">Mobile menu</a>',
    '<a href="/nav-menu">Main menu</a>',
    '<a href="#x">Menu button</a>'
  ]) {
    assert.equal(findMenuURL(page(link), HOME), null, `matched a UI control: ${link}`);
  }
});

test("a real menu link still wins on a page that also has a nav toggle", () => {
  const found = findMenuURL(page(`
    <a href="#nav">Toggle menu</a>
    <a href="/about">About</a>
    <a href="/our-menu">Our Menu</a>
  `), HOME);

  assert.equal(found.url, "https://example.com/our-menu");
});

test("a stray mention of the word is not enough to guess a menu URL", () => {
  // A wrong menu URL is worse than none: it fingerprints a page that never
  // changes and reports coverage nobody can eat from.
  assert.equal(
    findMenuURL(page('<a href="/blog/2024/our-new-menu-designer-profile">Read more</a>'), HOME),
    null
  );
  assert.equal(findMenuURL(page('<a href="/about">About our food</a>'), HOME), null);
});

test("a menu on an ordering platform is found and flagged as needing a browser", () => {
  const found = findMenuURL(
    page('<a href="https://order.toasttab.com/online/example">Order online — menu</a>'), HOME
  );

  assert.equal(found.javascriptPlatform, true, "a plain fetch would get an empty page");
  assert.equal(found.sameOrigin, false);
});

test("a PDF menu is a legitimate find and is flagged as a document", () => {
  const found = findMenuURL(page('<a href="/files/dinner-menu.pdf">Dinner Menu</a>'), HOME);

  assert.equal(found.url, "https://example.com/files/dinner-menu.pdf");
  assert.equal(found.likelyDocument, true, "its dishes have to be transcribed by a person");
});

test("same-origin is preferred when a page offers several menus", () => {
  const found = findMenuURL(page(`
    <a href="https://elsewhere.example.net/menu">Menu</a>
    <a href="/menu">Menu</a>
  `), HOME);

  assert.equal(found.url, "https://example.com/menu");
  assert.ok(found.alternatives.includes("https://elsewhere.example.net/menu"));
});

test("unfetchable sites are reported rather than thrown", async () => {
  // A site that is down must not lose a whole discovery run.
  const dead = await resolveMenuURL("https://example.com", {
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); }
  });
  assert.equal(dead.url, null);
  assert.match(dead.reason, /ENOTFOUND/);

  const missing = await resolveMenuURL("https://example.com", {
    fetchImpl: async () => new Response("nope", { status: 404 })
  });
  assert.equal(missing.url, null);
  assert.match(missing.reason, /404/);

  const noLink = await resolveMenuURL("https://example.com", {
    fetchImpl: async () => new Response(page("<a href='/about'>About</a>"))
  });
  assert.equal(noLink.url, null);
  assert.match(noLink.reason, /no menu link/);
});

test("javascript and fragment links are never followed", () => {
  assert.equal(findMenuURL(page('<a href="javascript:openMenu()">Menu</a>'), HOME), null);
  assert.equal(findMenuURL(page('<a href="#menu">Menu</a>'), HOME), null);
  assert.equal(findMenuURL(page('<a href="mailto:x@example.com">Menu</a>'), HOME), null);
});

test("a menu on another brand's domain is offered, never chosen", async () => {
  // Found in the wild on the first real Denver batch. A restaurant tagged
  // diet:vegan=only linked from its own site to its franchise owner's menu,
  // which belongs to a hot dog chain: 13 chicken, 12 beef, 9 sausage. The link
  // is indistinguishable from a correct one by score alone — it reads "Menu" and
  // points at /menu/ — so scoring cannot be the defence.
  const found = findMenuURL(
    page('<a href="https://doghaus.com/menu/">Menu</a>'), "https://www.plantbtogo.com/"
  );

  assert.equal(found.url, null, "beef must never be filed under a vegan restaurant");
  assert.match(found.reason, /another domain/);
  assert.deepEqual(found.alternatives, ["https://doghaus.com/menu/"], "a person can still see it");
});

test("a restaurant's own menu still wins over a parent brand's", () => {
  const found = findMenuURL(page(`
    <a href="https://parentbrand.example.net/menu/">Menu</a>
    <a href="/menu">Our Menu</a>
  `), "https://example.com/");

  assert.equal(found.url, "https://example.com/menu");
});

test("a menu page that only links to PDFs resolves to the document", async () => {
  // Found in the wild. A restaurant's "Menu" page held fifty lines of navigation
  // and four PDFs. Stopping at the landing page records a URL that fingerprints
  // perfectly and never contains a dish, so the restaurant sits in the catalog
  // looking checked and holding nothing.
  const pages = {
    "https://example.com/": '<a href="/mainmenu">Menu</a>',
    "https://example.com/mainmenu": `
      <a href="/s/Summer-Menu-2026.pdf">lunch and dinner menu</a>
      <a href="/s/Brunch-Menu-Summer.pdf">brunch menu</a>
      <a href="/about">About</a>`
  };
  const found = await resolveMenuURL("https://example.com/", {
    fetchImpl: async (url) => new Response(pages[url] ?? "", { status: pages[url] ? 200 : 404 })
  });

  assert.equal(found.url, "https://example.com/s/Summer-Menu-2026.pdf");
  assert.equal(found.verificationMethod, "menu_document", "its dishes need a person");
  assert.equal(found.landingPage, "https://example.com/mainmenu");
  assert.equal(found.documents.length, 2);
});

test("a menu page with dishes on it is not traded for a downloadable copy", async () => {
  // Plenty of sites offer a PDF beside a perfectly readable menu. The readable
  // one is worth more: it extracts, and the document would need transcribing.
  const pages = {
    "https://example.com/": '<a href="/menu">Menu</a>',
    "https://example.com/menu": `
      <a href="/s/print-menu.pdf">printable menu</a>
      <li>Roasted Cauliflower (VG)</li><li>$11</li>
      <li>Halloumi Skewers (V)</li><li>$13</li>
      <li>Charred Broccoli (VG)</li><li>$12</li>`
  };
  const found = await resolveMenuURL("https://example.com/", {
    fetchImpl: async (url) => new Response(pages[url] ?? "", { status: pages[url] ? 200 : 404 })
  });

  assert.equal(found.url, "https://example.com/menu");
  assert.equal(found.verificationMethod, undefined);
});

test("an unreachable second hop keeps the menu page it already found", async () => {
  const found = await resolveMenuURL("https://example.com/", {
    fetchImpl: async (url) => url.endsWith("/menu")
      ? new Response("", { status: 500 })
      : new Response('<a href="/menu">Menu</a>')
  });

  assert.equal(found.url, "https://example.com/menu", "a failed hop must not lose the first answer");
});
