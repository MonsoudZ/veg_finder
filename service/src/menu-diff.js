// Compares what is currently published against a fresh reading of a changed
// source, and states the difference as operations a person can accept one by one.
//
// This engine is deliberately literal. It matches dishes by identity and reports
// every difference it sees, including ones a cleverer engine would explain away.
// That is the intended trade for version one: a false positive costs a reviewer a
// minute, and a false vegan label costs somebody who trusted it. Where it cannot
// tell two readings apart it says so in `ambiguities` rather than picking one.
//
// Nothing here reads or writes. It is given two lists and returns a description.

// Fields whose change is worth a reviewer's attention. `sourceEvidence` is
// excluded on purpose: it moves whenever the page is re-rendered, and an
// operation whose only difference is that the same claim was quoted from a
// different line is noise, not a menu change.
const COMPARED_FIELDS = ["name", "description", "price", "dietaryStatus", "modificationNote"];

export function diffMenu({ published = [], extracted = [], tier = "unknown", readable = true } = {}) {
  const publishedByID = new Map(published.map((item) => [item.id, item]));
  const operations = [];
  const ambiguities = [];

  // A source we could not read is not a source that lists no dishes. Treating
  // the two the same would propose retiring an entire menu because a PDF
  // replaced an HTML page, so an unreadable reading proposes nothing at all.
  if (!readable) {
    return {
      operations: [],
      ambiguities: [
        "The source changed but could not be read as a menu, so no difference " +
        "could be computed. The change is real; what it was has to be established " +
        "by a person."
      ]
    };
  }

  for (const [index, item] of extracted.entries()) {
    const current = publishedByID.get(item.id);
    if (!current) {
      operations.push(operation("add", item, null, [], index));
      continue;
    }
    publishedByID.delete(item.id);
    const changed = COMPARED_FIELDS.filter((field) => !same(current[field], item[field]));
    // An unchanged dish is not a change. Re-proposing every dish on the menu
    // every time one price moves is how a review queue becomes wallpaper.
    if (changed.length === 0) continue;
    operations.push(operation("update", item, current, changed, index));
  }

  // Whatever the new reading did not account for. Ordered after the additions so
  // the reviewer reads the menu as it will be before reading what leaves it.
  for (const [index, current] of [...publishedByID.values()].entries()) {
    operations.push(operation("retire", null, current, [], extracted.length + index));
  }

  const retirements = operations.filter((op) => op.operation === "retire");

  // The failure mode this system exists to survive. A restaurant that genuinely
  // withdrew its entire vegan menu and a restaurant that reworded its legend
  // produce the identical diff, and only one of them should empty the catalog.
  if (published.length > 0 && retirements.length === published.length) {
    ambiguities.push(
      `Every published item (${published.length}) would be retired. A menu that was ` +
      `genuinely withdrawn and a page whose layout or dietary legend simply changed ` +
      `look the same from here. Check the new source before accepting these.`
    );
    for (const op of retirements) op.confidence = "low";
  } else if (extracted.length === 0 && published.length > 0) {
    ambiguities.push(
      "The new source yielded no dishes at all. This is more often a changed page " +
      "structure than an emptied menu."
    );
  }

  for (const rename of possibleRenames(operations)) {
    ambiguities.push(
      `"${rename.retired}" is retired and "${rename.added}" is added. These may be ` +
      `one renamed dish rather than two changes; accepting both is correct either ` +
      `way, but its history will show a retirement and a new item.`
    );
  }

  const relabelled = operations.filter(
    (op) => op.operation === "update" && op.changedFields.includes("dietaryStatus")
  );
  for (const op of relabelled) {
    ambiguities.push(
      `"${op.proposed.name}" changes dietary status from ` +
      `"${op.current.dietaryStatus}" to "${op.proposed.dietaryStatus}". This is the ` +
      `claim diners rely on; confirm it against the quoted evidence.`
    );
  }

  if (tier === "llm_assisted") {
    ambiguities.push(
      "This reading came from a model, not from the menu's own dietary legend. " +
      "Every operation needs checking against its quoted evidence."
    );
  }

  return { operations, ambiguities };
}

function operation(kind, proposed, current, changedFields, position) {
  return {
    operation: kind,
    position,
    menuItemID: proposed?.id ?? current?.id ?? null,
    proposed: proposed ? canonical(proposed) : null,
    current: current ? canonical(current) : null,
    changedFields,
    evidence: proposed?.sourceEvidence ?? "",
    confidence: confidenceOf(kind, proposed, current, changedFields)
  };
}

// How much of a reviewer's attention this operation needs, which is not the same
// as how likely it is to be right. A price correction that moves no dietary claim
// is cheap to accept; anything that starts, ends, or alters such a claim is not.
function confidenceOf(kind, proposed, current, changedFields) {
  if (kind === "update") {
    return changedFields.every((field) => field === "price" || field === "description")
      ? "high"
      : "low";
  }
  // An addition asserts a new dietary claim, and a retirement withdraws one.
  // Neither is free, but withdrawing errs towards showing a diner less rather
  // than misleading them, so it is not the more dangerous direction.
  return "medium";
}

// Pairs a retirement with an addition whose names are close enough that they are
// plausibly the same dish renamed. This deliberately does not merge them into an
// update — guessing wrong would silently carry a stale dietary status onto a
// dish whose recipe changed. It only tells the reviewer to look.
function possibleRenames(operations) {
  const added = operations.filter((op) => op.operation === "add");
  const retired = operations.filter((op) => op.operation === "retire");
  const pairs = [];
  for (const out of retired) {
    for (const into of added) {
      if (similar(out.current.name, into.proposed.name)) {
        pairs.push({ retired: out.current.name, added: into.proposed.name });
      }
    }
  }
  return pairs;
}

function similar(left, right) {
  const a = words(left);
  const b = words(right);
  if (a.length === 0 || b.length === 0) return false;
  const shared = a.filter((word) => b.includes(word)).length;
  return shared / Math.max(a.length, b.length) >= 0.5;
}

function words(name) {
  return String(name ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);
}

// Null, undefined and "" all mean "nothing recorded" across the two sides of this
// comparison — extraction writes "", the database column may hold NULL — and
// reporting that as a change would fill every proposal with phantom edits.
function same(left, right) {
  return normalize(left) === normalize(right);
}

function normalize(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function canonical(item) {
  return {
    id: item.id ?? null,
    name: item.name ?? null,
    description: normalize(item.description),
    price: item.price ?? null,
    dietaryStatus: item.dietaryStatus ?? null,
    modificationNote: item.modificationNote ?? null,
    sourceEvidence: item.sourceEvidence ?? ""
  };
}
