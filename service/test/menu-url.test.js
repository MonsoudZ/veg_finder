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
