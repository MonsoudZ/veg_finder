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

test("a marker sharing its bracket with other codes is still read", () => {
  // "(V, GF)" is one dish that is both vegetarian and gluten-free.
  const result = extractMenu(page(`
    <p>V = Vegan, GF = Gluten Free</p>
    <li>Crispy Tofu (V, GF )</li><li>12.00</li>
    <li>Spicy Edamame (V, GF )</li><li>9.50</li>
  `));
  assert.deepEqual(
    result.items.map((item) => [item.name, item.dietaryStatus, item.price]),
    [["Crispy Tofu", "Vegan", "12.00"], ["Spicy Edamame", "Vegan", "9.50"]]
  );
});

test("a marker qualifying one choice among several is not a dish marker", () => {
  // The (V) here applies to the tofu option; the dish itself can be pork.
  const result = extractMenu(page(`
    <p>V = Vegan</p>
    <li>Lettuce Wrap (Pork, Chicken, or Tofu (V) )</li><li>16.00</li>
  `));
  assert.equal(result.items.length, 0, "an ingredient parenthetical must not mark the dish");
});

test("a dish carrying two conflicting dietary codes is left alone", () => {
  const result = extractMenu(page(`
    <p>V = Vegan, VE = Vegetarian</p>
    <li>Mystery Plate (V, VE)</li><li>10.00</li>
  `));
  assert.equal(result.items.length, 0);
});

test("prices without a currency symbol are recognised, quantities are not", () => {
  const result = extractMenu(page(`
    <p>VG = Vegan</p>
    <li>Half Sandwich (VG)</li><li>11.75</li>
    <li>Serves 2 (VG)</li><li>2</li>
    <li>Since 1998 (VG)</li><li>1998</li>
  `));
  assert.deepEqual(result.items.map((item) => item.name), ["Half Sandwich"]);
});

test("a marker printed below a dish is attached to that dish", () => {
  // The Corner Beet's layout: name, price, description, add-ons, then the codes.
  const result = extractMenu(page(`
    <p>V - Vegan</p>
    <li>Thai Peanut</li><li>$19</li>
    <li>mixed greens tossed in thai peanut dressing with crispy tamari tofu</li>
    <li>pasture-raised egg | 2</li>
    <li>V/GF</li>
    <li>Greek</li><li>$16</li>
    <li>mixed greens with feta and a side of hummus</li>
    <li>GF | 2</li>
  `));

  assert.deepEqual(
    result.items.map((item) => [item.name, item.dietaryStatus]),
    [["Thai Peanut", "Vegan"]],
    "only the dish whose codes the legend defines is claimed"
  );
});

test("an undefined option code below a dish is not interpreted", () => {
  // "VO" conventionally means vegan-option, but this menu never says so.
  const result = extractMenu(page(`
    <p>V - Vegan</p>
    <li>Beirut Plate</li><li>$17</li>
    <li>creamy labneh, two pasture-raised eggs, pickled turnips</li>
    <li>VO | sub hummus for labneh, sub tofu for egg</li>
  `));
  assert.equal(result.items.length, 0, "a code the menu never defined is not evidence");
});

test("a trailing marker does not leak onto the following dish", () => {
  const result = extractMenu(page(`
    <p>V - Vegan</p>
    <li>House Greens</li><li>$10</li><li>V</li>
    <li>Steak Frites</li><li>$32</li>
    <li>grass-fed sirloin with hand-cut fries</li>
  `));
  assert.deepEqual(result.items.map((item) => item.name), ["House Greens"]);
});

test("an operator can declare a restaurant entirely vegetarian", () => {
  const result = extractMenu(page(`
    <h1>City Cafe</h1>
    <li>Mac and Cheese</li><li>$17</li>
    <li>Buffalo Cauliflower</li><li>$14</li>
  `), { menuProfile: "fully_vegetarian" });

  assert.equal(result.tier, "fully_vegetarian");
  assert.equal(result.assertedBy, "operator");
  assert.deepEqual(
    result.items.map((item) => [item.name, item.dietaryStatus]),
    [["Mac and Cheese", "Vegetarian"], ["Buffalo Cauliflower", "Vegetarian"]],
    "meat-free does not mean dairy-free"
  );
});

test("a page stating it is entirely vegetarian is detected", () => {
  const result = extractMenu(page(`
    <p>We are a 100% vegetarian restaurant.</p>
    <li>Mushroom Risotto</li><li>$18</li>
  `));
  assert.equal(result.tier, "fully_vegetarian");
  assert.equal(result.assertedBy, "detection");
  assert.equal(result.items[0].dietaryStatus, "Vegetarian");
});

test("merely offering vegetarian options is not a whole-menu claim", () => {
  for (const claim of ["Great vegetarian options available", "Vegetarian friendly since 1998",
                       "Ask about our vegetarian dishes"]) {
    const result = extractMenu(page(`<p>${claim}</p><li>Soup of the Day</li><li>$9</li>`));
    assert.equal(result.tier, "manual", `"${claim}" must not be read as a whole-menu claim`);
  }
});

test("a marker does not drift up past a dish priced inline", () => {
  // Regression from the live menus: B.L.A.T's price is "Full $17 | Half $12",
  // which is not a price-only line, so its V marker was attributed to the
  // burrata above it — turning a dairy dish into a vegan one.
  const result = extractMenu(page(`
    <p>V - Vegan</p>
    <li>Bloomin' Burrata</li><li>$17</li>
    <li>creamy burrata with marinated cherry tomatoes, basil, and red onion</li>
    <li>VO | sub crispy tamari tofu</li>
    <li>B.L.A.T</li><li>Full $17 | Half $12</li>
    <li>savory tofu bacon with spinach, tomatoes, avocado and vegan spicy mayo</li>
    <li>V | 4</li>
  `));

  assert.ok(
    !result.items.some((item) => item.name.includes("Burrata")),
    "a dairy dish must never inherit the next dish's vegan marker"
  );
});

test("a price written with its sizes is kept whole", () => {
  // SubCulture's layout: one dish, two sizes, no currency symbol.
  const result = extractMenu(page(`
    <p>VG = Vegan</p>
    <li>Roast Veggie Parm (VG)</li><li>Half 11.00 | Whole 16.45</li>
    <li>Roasted Veggies, Marinara, Mozzarella</li>
  `));
  assert.deepEqual(
    result.items.map((item) => [item.name, item.price]),
    [["Roast Veggie Parm", "Half 11.00 | Whole 16.45"]],
    "the diner needs both sizes, not just the first number"
  );
});

test("other price-and-size shapes real menus use are recognised", () => {
  const shapes = [
    ["$6.00 ea.", "$6.00 ea."],
    ["Full $19 | Half $14", "Full $19 | Half $14"],
    ["Side $3.00 | Cup $5.00 | Bowl $7.00", "Side $3.00 | Cup $5.00 | Bowl $7.00"],
    ["$5.99/Cup", "$5.99/Cup"],
    ["cup 4.50 or bowl 7.50", "cup 4.50 or bowl 7.50"]
  ];
  for (const [line, expected] of shapes) {
    const result = extractMenu(page(`
      <p>VG = Vegan</p><li>Test Dish (VG)</li><li>${line}</li>
    `));
    assert.equal(result.items[0]?.price, expected, `failed on "${line}"`);
  }
});

test("a line that is words plus a price is the next dish, not this dish's price", () => {
  // The failure this guards: "Lamb Kofta $18" reading as the halloumi's price.
  const result = extractMenu(page(`
    <p>V = Vegan</p>
    <li>Grilled Halloumi (V)</li>
    <li>Lamb Kofta $18</li>
  `));
  assert.equal(result.items.length, 0);
});

test("numbers that are not prices never become one", () => {
  // Every one of these appears on a real menu in the pilot catalog.
  for (const line of ["1 Egg", "4 Donut Bites", "(720)-532-0757", "3 Wise Men",
                      "Serves 10-12 each", "12 Hour", "%PDF-1.4", "1 0 obj"]) {
    const result = extractMenu(page(`
      <p>VG = Vegan</p><li>Test Dish (VG)</li><li>${line}</li>
    `));
    assert.equal(result.items.length, 0, `"${line}" must not be read as a price`);
  }
});

test("a whole-menu claim on a linked page is read, quoted, and marked as linked", () => {
  // The Cake Bar's menu page lists cakes and never uses the word vegan; the
  // claim that makes all of them vegan lives on the home page.
  const menu = page(`
    <h2>BAKED GOODS</h2>
    <p>Fudge Brownies</p>
    <p>$6.50 ea.</p>
  `);
  const claim = page("<h1>The Cake Bar - Denver&#039;s Favorite Vegan Bakery</h1>");

  assert.equal(extractMenu(menu).tier, TIERS.MANUAL);

  const result = extractMenu(menu, { claimHTML: claim });
  assert.equal(result.tier, TIERS.FULLY_VEGAN);
  assert.equal(result.assertedBy, "linked-claim");
  assert.deepEqual(result.items.map((item) => item.name), ["Fudge Brownies"]);
  assert.equal(result.items[0].dietaryStatus, "Vegan");
  // The words that justified publishing a whole menu are recorded, not merely
  // the fact that something matched.
  assert.match(result.reasons[0], /Denver's Favorite Vegan Bakery/);
});

test("a claim on the menu itself is distinguished from a claim on a linked page", () => {
  const result = extractMenu(
    page(`
      <p>We are a 100% vegan kitchen.</p>
      <p>Fudge Brownies</p>
      <p>$6.50</p>
    `),
    { claimHTML: page("<p>Somewhere else entirely</p>") }
  );
  assert.equal(result.assertedBy, "detection");
  assert.match(result.reasons[0], /menu page states/);
});

test("a linked page that makes no whole-menu claim changes nothing", () => {
  // City, O' City's about page describes its sister restaurant Watercourse as
  // plant-based. A linked page must still make a claim about a whole menu;
  // "vegetarian options" and prose about another business are not that.
  const menu = page(`
    <p>Fried Cheese</p>
    <p>$9</p>
  `);
  const vague = page("<p>Where veggies meet comfort food. Plenty of vegetarian options.</p>");
  assert.equal(extractMenu(menu, { claimHTML: vague }).tier, TIERS.MANUAL);
});

test("a price line's leftover text does not become a dish", () => {
  // A two-column layout prints "$6.50 ea." twice. Stripping the price off the
  // second one left "ea" behind as a dish with a price, and on a wholly vegan
  // menu that publishes without anybody seeing it.
  const result = extractMenu(page(`
    <h1>Denver's Favorite Vegan Bakery</h1>
    <p>Fudge Brownies</p>
    <p>$6.50 ea.</p>
    <p>$6.50 ea.</p>
    <p>B.L.A.T</p>
    <p>$12.00</p>
  `));
  const names = result.items.map((item) => item.name);
  assert.ok(!names.includes("ea"), `"ea" is not a dish: ${JSON.stringify(names)}`);
  // Letters are counted rather than required to run consecutively, because this
  // is a real sandwich and has no run of three.
  assert.ok(names.includes("B.L.A.T"), `B.L.A.T is a dish: ${JSON.stringify(names)}`);
});

test("a zero-padded numeric entity is decoded like its unpadded twin", () => {
  const result = extractMenu(page(`
    <h1>Angie&#039;s Vegan Bakery</h1>
    <p>Angie&#39;s Brownie</p>
    <p>$6.50</p>
  `));
  assert.equal(result.items[0].name, "Angie's Brownie");
  assert.match(result.reasons[0], /Angie's Vegan Bakery/);
  assert.ok(!result.reasons[0].includes("&#"), "no undecoded entity reaches a published quote");
});

// A menu that prices its dishes as bare numbers, in the repeating
// name / price / description shape found on a real Denver vegan restaurant's
// page. Before this was recognised the page yielded nothing at all.
const BARE_PRICE_MENU = `<html><body>
  <p>100% vegan kitchen</p>
  <div><h3>Hand Cut Fries</h3><p>g/f 8</p><p>Crisped idaho potatoes tossed in sour cream powder and herbs</p></div>
  <div><h3>Carrot Sticks</h3><p>g/f | c/s | c/n 11</p><p>Roasted carrots tossed in tangy buffalo sauce with dill</p></div>
  <div><h3>Garlic Bread</h3><p>12</p><p>Thick sliced ciabatta toasted in herbed butter and roasted garlic</p></div>
  <div><h3>Charred Caesar</h3><p>13</p><p>Charred cabbage and escarole tossed with black garlic dressing</p></div>
</body></html>`;

test("a menu priced in bare numbers is read once the layout repeats", () => {
  const result = extractMenu(BARE_PRICE_MENU);

  assert.equal(result.tier, "fully_vegan");
  assert.deepEqual(
    result.items.map((item) => [item.name, item.price]),
    [["Hand Cut Fries", "8"], ["Carrot Sticks", "11"],
     ["Garlic Bread", "12"], ["Charred Caesar", "13"]],
    "allergen codes ahead of the number are not part of the price"
  );
  assert.match(
    result.items[0].description, /^Crisped idaho potatoes/,
    "in this layout the third line is the description by construction"
  );
});

test("a stray number is not a price without the layout to vouch for it", () => {
  // The whole risk of reading bare numbers. Years, counts and street numbers sit
  // under headings on every page on the web; only the repetition makes one a price.
  const notAMenu = `<html><body>
    <p>100% vegan kitchen</p>
    <div><h3>Our Story</h3><p>2014</p><p>We opened our doors in a converted garage on Colfax Avenue</p></div>
    <div><h3>Find Us</h3><p>837</p><p>East 17th Avenue, Denver, Colorado, open seven days a week</p></div>
  </body></html>`;

  assert.deepEqual(
    extractMenu(notAMenu).items, [],
    "two lookalikes are not a menu, and neither is a dish"
  );
});

test("bare prices stay unread on a menu that never establishes the layout", () => {
  const oneOff = `<html><body>
    <p>100% vegan kitchen</p>
    <div><h3>Hand Cut Fries</h3><p>8</p><p>Crisped idaho potatoes tossed in sour cream powder and herbs</p></div>
    <li>Roasted Cauliflower</li><li>$11</li>
  </body></html>`;
  const result = extractMenu(oneOff);

  assert.deepEqual(
    result.items.map((item) => item.name), ["Roasted Cauliflower"],
    "a single bare-priced dish is below the threshold, so only the priced one is read"
  );
});

test("a serving note beside a price is not an orderable dish", () => {
  // Found in the wild on a wholly-vegan menu, where this tier publishes with no
  // human in the way: "Served with steamed rice | Substitutions: Brown Rice"
  // reached a diner as something to order. Notes sit where dishes sit and carry
  // prices, so position and price cannot tell them apart.
  const menu = `<html><body>
    <p>We are a 100% vegan restaurant</p>
    <li>Orange Chickin' Bowl</li><li>$14.99</li>
    <li>Served with steamed rice | Substitutions: Brown Rice | Bamboo Rice</li><li>$1.50</li>
    <li>Add avocado to any bowl for</li><li>$2.00</li>
    <li>Kung Pao Tofu</li><li>$13.99</li>
  </body></html>`;

  assert.deepEqual(
    extractMenu(menu).items.map((item) => item.name),
    ["Orange Chickin' Bowl", "Kung Pao Tofu"]
  );
});

test("a long but genuine dish name is still a dish", () => {
  const menu = `<html><body>
    <p>We are a 100% vegan restaurant</p>
    <li>Sweet & Spicy Katsu Burger</li><li>$12.99</li>
    <li>Salt & Pepper Chickin' Wings</li><li>$12.99</li>
    <li>Black Pepper Mushrooms (3 bao)</li><li>$12.99</li>
  </body></html>`;

  assert.equal(extractMenu(menu).items.length, 3, "the guard must not eat real menus");
});
