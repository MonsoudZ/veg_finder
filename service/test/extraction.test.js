import assert from "node:assert/strict";
import test from "node:test";
import { extractMenu, TIERS } from "../src/extraction.js";

const page = (body) => `<html><body>${body}</body></html>`;

test("an operator-declared vegan restaurant yields vegan items with the line as evidence", () => {
  const result = extractMenu(page(`
    <h1>Green Kitchen</h1>
    <li>Chana Masala Bowl $12.00</li>
    <li>Jackfruit Tacos $13.50</li>
    <li>Our story</li>
  `), { menuProfile: TIERS.FULLY_VEGAN });

  assert.equal(result.tier, TIERS.FULLY_VEGAN);
  assert.equal(result.assertedBy, "operator");
  assert.equal(result.items.length, 2, "only priced lines are dishes");
  assert.deepEqual(result.items.map((item) => item.name), ["Chana Masala Bowl", "Jackfruit Tacos"]);
  assert.ok(result.items.every((item) => item.dietaryStatus === "Vegan"));
  assert.match(result.items[0].sourceEvidence, /Chana Masala Bowl \$12\.00/);
});

test("a page that states it is entirely vegan is detected, but marked as such", () => {
  const result = extractMenu(page(`
    <p>We are a 100% vegan restaurant.</p>
    <li>Seitan Gyro $14</li>
  `));
  assert.equal(result.tier, TIERS.FULLY_VEGAN);
  assert.equal(result.assertedBy, "detection", "detection must be distinguishable from an operator's word");
  assert.equal(result.items.length, 1);
});

test("a published legend is applied exactly as the menu defines it", () => {
  const result = extractMenu(page(`
    <p>VG = Vegan, V = Vegetarian</p>
    <li>Roasted Cauliflower (VG) $11</li>
    <li>Halloumi Skewers (V) $13</li>
    <li>Lamb Kofta $18</li>
  `));

  assert.equal(result.tier, TIERS.LABELLED_MENU);
  assert.deepEqual(
    result.items.map((item) => [item.name, item.dietaryStatus]),
    [["Roasted Cauliflower", "Vegan"], ["Halloumi Skewers", "Vegetarian"]]
  );
  assert.ok(!result.items.some((item) => item.name.includes("Kofta")), "unmarked dishes are not claimed");
});

test("V means vegetarian when the menu says so, even though it often means vegan", () => {
  const result = extractMenu(page(`
    <p>V = Vegetarian</p>
    <li>Mushroom Risotto (V) $16</li>
  `));
  assert.equal(result.items[0].dietaryStatus, "Vegetarian");
});

test("markers with no legend are refused outright", () => {
  const result = extractMenu(page(`
    <li>Roasted Cauliflower (VG) $11</li>
    <li>Mushroom Risotto (V) $16</li>
  `));
  assert.equal(result.tier, TIERS.MANUAL, "an undefined symbol is not evidence");
  assert.equal(result.items.length, 0);
  assert.match(result.reasons.join(" "), /No dietary legend/);
});

test("a menu that defines one symbol two ways defines nothing usable", () => {
  const result = extractMenu(page(`
    <p>V = Vegan</p><p>V = Vegetarian</p>
    <li>Falafel Plate (V) $12</li>
  `));
  assert.equal(result.tier, TIERS.MANUAL);
  assert.equal(result.items.length, 0);
});

test("dish names and ingredient prose are never treated as evidence", () => {
  const result = extractMenu(page(`
    <p>V = Vegan</p>
    <li>Veggie Burger $14</li>
    <li>Garden Salad $9</li>
    <li>Plant-Based Sausage Roll $8</li>
    <li>Impossible Burger $16</li>
    <li>This dish contains no meat $11</li>
    <li>Vegetable Soup $7</li>
  `));

  assert.equal(
    result.items.length, 0,
    "a suggestive name is not a claim by the restaurant and must never be published"
  );
});

test("a dish that only qualifies after a change is left to a human", () => {
  const result = extractMenu(page(`
    <p>VG = Vegan</p>
    <li>Pad Thai (VG) on request $15</li>
    <li>Green Curry (VG) vegan option available $16</li>
    <li>Papaya Salad (VG) $10</li>
  `));

  assert.deepEqual(result.items.map((item) => item.name), ["Papaya Salad"]);
  assert.ok(
    result.items.every((item) => item.dietaryStatus === "Vegan"),
    "extraction never proposes a modification it would have to invent"
  );
});

test("extraction never proposes a modification-dependent status", () => {
  const pages = [
    page(`<p>VG = Vegan</p><li>Tacos (VG) can be made vegan $13</li>`),
    page(`<p>We are 100% vegan</p><li>Bowl $12</li>`),
    page(`<p>V = Vegetarian</p><li>Risotto (V) $16</li>`)
  ];
  for (const html of pages) {
    for (const item of extractMenu(html).items) {
      assert.ok(
        item.dietaryStatus === "Vegan" || item.dietaryStatus === "Vegetarian",
        `unexpected status ${item.dietaryStatus}`
      );
      assert.equal(item.modificationNote, null);
    }
  }
});

test("prose, headings and navigation are not mistaken for dishes", () => {
  const result = extractMenu(page(`
    <p>We are a 100% vegan cafe</p>
    <nav>Home About Contact</nav>
    <h2>Lunch</h2>
    <p>Open daily from 11am. Call us at 303-555-0134.</p>
    <li>Tempeh Reuben $13</li>
  `), {});
  assert.deepEqual(result.items.map((item) => item.name), ["Tempeh Reuben"]);
});

test("a dish repeated on the page is proposed once", () => {
  const result = extractMenu(page(`
    <p>We are entirely vegan</p>
    <li>House Bowl $12</li>
    <li>House Bowl $12</li>
  `));
  assert.equal(result.items.length, 1);
});

test("an empty or unparseable page degrades to manual rather than guessing", () => {
  for (const html of ["", "<html></html>", "not html at all", "<p>$12</p>"]) {
    const result = extractMenu(html);
    assert.equal(result.tier, TIERS.MANUAL);
    assert.equal(result.items.length, 0);
  }
});

test("a dish whose price sits on the next line is still found", () => {
  // The layout almost every real menu uses: dish and marker on one line, price
  // beneath it. Requiring both in one block missed these entirely.
  const result = extractMenu(page(`
    <p>Ve - vegetarian, VG - vegan</p>
    <li>Fried Cheese Curds (Ve)</li><li>$11.99</li>
    <li>Wisconsin white cheddar curds served with housemade ranch.</li>
    <li>Roasted Cauliflower (VG)</li><li>$13.50</li>
  `));

  assert.deepEqual(
    result.items.map((item) => [item.name, item.dietaryStatus, item.price]),
    [["Fried Cheese Curds", "Vegetarian", "$11.99"], ["Roasted Cauliflower", "Vegan", "$13.50"]]
  );
});

test("a price is never borrowed from a line that carries its own words", () => {
  const result = extractMenu(page(`
    <p>V = Vegan</p>
    <li>Grilled Halloumi (V)</li>
    <li>Lamb Kofta $18</li>
  `));
  assert.equal(result.items.length, 0, "the next dish's price must not attach to this one");
});

test("a description following a marked dish does not become its own item", () => {
  const result = extractMenu(page(`
    <p>V = Vegan</p>
    <li>Chana Bowl (V)</li><li>$12</li>
    <li>Chickpeas, rice, cilantro (V)</li><li>$0</li>
  `));
  assert.ok(result.items.every((item) => item.name !== "Chickpeas, rice, cilantro" || item.price === "$0"));
  assert.equal(result.items[0].name, "Chana Bowl");
});
