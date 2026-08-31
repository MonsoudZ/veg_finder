// Finds candidate restaurants from OpenStreetMap, for a person to review and
// import.
//
// OSM is used rather than a commercial places API for one reason that outranks
// coverage: its terms let you keep what you fetch. A catalog is a database you
// persist and serve, and most places APIs restrict exactly that. Read the ODbL
// before shipping — attribution is required, and building a public database from
// it carries share-alike obligations that are a product decision, not a
// technical one.
//
// The rule this file exists to enforce: OSM's dietary tags are read for
// *prioritisation only*, never as a dietary claim. `diet:vegan=only` is an
// assertion by a map contributor, not by the restaurant, and `menuProfile:
// fully_vegan` publishes an entire menu with no human review. Wiring one to the
// other would let a stranger's map edit publish vegan claims to people who
// cannot eat animal products. So discovery emits no menuProfile at all: it says
// "look at this one first", and an operator still decides what the restaurant
// itself claims.

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

// Cafes and fast food serve meals and are frequently the vegan-friendly ones.
// Bars and pubs are excluded: most publish no menu worth checking, and they
// dilute a queue that a person has to work through by hand.
const KINDS = ["restaurant", "cafe", "fast_food"];

export function overpassQuery({ bbox, area, kinds = KINDS, timeoutSeconds = 90 }) {
  const selector = `["amenity"~"^(${kinds.join("|")})$"]`;
  if (area) {
    const escaped = String(area).replace(/["\\]/g, "\\$&");
    return [
      `[out:json][timeout:${timeoutSeconds}];`,
      `area["name"="${escaped}"]["boundary"="administrative"]->.searchArea;`,
      `(node${selector}(area.searchArea);way${selector}(area.searchArea););`,
      "out center tags;"
    ].join("\n");
  }
  if (!bbox) throw new Error("Either a bbox or an area name is required");
  const box = bbox.join(",");
  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    `(node${selector}(${box});way${selector}(${box}););`,
    "out center tags;"
  ].join("\n");
}

// "39.70,-105.02,39.76,-104.95" as south,west,north,east — the order Overpass
// expects. Rejected rather than reordered when it is backwards: a silently
// transposed box searches the wrong place and returns a plausible-looking empty
// result.
export function parseBBox(text) {
  const parts = String(text).split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error("bbox must be four numbers: south,west,north,east");
  }
  const [south, west, north, east] = parts;
  if (south < -90 || north > 90 || south >= north) {
    throw new Error("bbox latitudes must satisfy -90 <= south < north <= 90");
  }
  if (west < -180 || east > 180 || west >= east) {
    throw new Error("bbox longitudes must satisfy -180 <= west < east <= 180");
  }
  return parts;
}

export async function fetchOverpass(query, {
  fetchImpl = fetch, endpoint = OVERPASS_ENDPOINT
} = {}) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // Overpass is a donated public service and asks to know who is calling.
      "user-agent": "VegFinderDiscovery/0.1 (+restaurant catalog research)"
    },
    body: new URLSearchParams({ data: query }).toString(),
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok) throw new Error(`Overpass returned HTTP ${response.status}`);
  return response.json();
}

// Turns raw OSM elements into candidate records, and says which ones are not
// usable yet and why. Nothing is invented to fill a gap: a restaurant with no
// street address is reported as needing one, not given its city as an address.
export function toCandidates(payload, { defaultNeighborhood = null } = {}) {
  const complete = [];
  const incomplete = [];

  for (const element of payload?.elements ?? []) {
    const tags = element.tags ?? {};
    const latitude = element.lat ?? element.center?.lat ?? null;
    const longitude = element.lon ?? element.center?.lon ?? null;
    const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
    const city = tags["addr:city"] ?? null;
    const address = [street, city].filter(Boolean).join(", ");
    const website = normalizeWebsite(tags.website ?? tags["contact:website"]);

    const missing = [];
    if (!tags.name) missing.push("name");
    if (latitude == null || longitude == null) missing.push("coordinates");
    if (!street) missing.push("address");
    if (!website) missing.push("website");

    const candidate = {
      name: tags.name ?? null,
      neighborhood: tags["addr:suburb"] ?? city ?? defaultNeighborhood,
      address: address || null,
      latitude,
      longitude,
      // Filled in by menu-url resolution, or left for a person. The importer
      // refuses an entry without one, which is the correct outcome: a restaurant
      // whose menu nobody can find has nothing to verify.
      menuURL: null,
      // Everything below is provenance and ranking material. The importer reads
      // none of it, and in particular none of it becomes a menuProfile.
      discovery: {
        source: `osm:${element.type}/${element.id}`,
        website,
        cuisine: tags.cuisine ?? null,
        // A map contributor's assertion, kept verbatim and never promoted into a
        // dietary claim. It only decides what a person looks at first.
        dietVegan: tags["diet:vegan"] ?? null,
        dietVegetarian: tags["diet:vegetarian"] ?? null
      }
    };

    if (missing.length === 0) complete.push(candidate);
    else incomplete.push({ ...candidate, missing });
  }

  return { complete, incomplete };
}

// How cheap this restaurant is likely to be to verify, which is the order a
// queue worked by hand should be filled in. A restaurant that says its whole
// menu is vegan costs one operator assertion and publishes everything; an
// unlabelled steakhouse costs a person per dish and yields two sides.
//
// These are guesses from third-party tags, so they rank and nothing more. A
// wrong guess costs review order, never a published claim.
export const PRIORITIES = {
  WHOLLY_MEATLESS: 0,
  MEATLESS_FRIENDLY: 1,
  UNKNOWN: 2
};

export function priorityOf(candidate) {
  const { dietVegan, dietVegetarian, cuisine } = candidate.discovery ?? {};
  if (dietVegan === "only" || dietVegetarian === "only") return PRIORITIES.WHOLLY_MEATLESS;
  if (/\b(vegan|vegetarian)\b/i.test(cuisine ?? "")) return PRIORITIES.WHOLLY_MEATLESS;
  if (dietVegan === "yes" || dietVegetarian === "yes") return PRIORITIES.MEATLESS_FRIENDLY;
  return PRIORITIES.UNKNOWN;
}

// Cheapest first, then alphabetically so a rerun of the same area produces the
// same file and a diff between two runs is readable.
export function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    const byPriority = priorityOf(a) - priorityOf(b);
    if (byPriority !== 0) return byPriority;
    return String(a.name).localeCompare(String(b.name));
  });
}

export function summarize(candidates) {
  const counts = { whollyMeatless: 0, meatlessFriendly: 0, unknown: 0 };
  for (const candidate of candidates) {
    if (priorityOf(candidate) === PRIORITIES.WHOLLY_MEATLESS) counts.whollyMeatless += 1;
    else if (priorityOf(candidate) === PRIORITIES.MEATLESS_FRIENDLY) counts.meatlessFriendly += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function normalizeWebsite(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  // Plenty of OSM entries record "www.example.com" with no scheme.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}
