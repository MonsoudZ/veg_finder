// One definition of what a valid catalog record is, shared by the admin API and
// the seed importer. Dietary data is the product, so bad input is rejected at the
// boundary rather than stored and served.

import { createHash } from "node:crypto";

export const DIETARY_STATUSES = [
  "Vegan", "Vegetarian", "Can be made vegan", "Can be made vegetarian"
];
export const COVERAGE_STATUSES = ["Complete", "Needs review"];
export const EXTRACTION_MODES = ["change_detection", "browser_required"];
export const MENU_PROFILES = ["unknown", "fully_vegan", "fully_vegetarian", "manual"];
// Only 'official_url' can be fingerprinted automatically. The others record a
// human observation — a photographed menu, a phone call, a visit — which the
// checker cannot re-verify, so those restaurants age out instead.
export const VERIFICATION_METHODS =
  ["official_url", "menu_document", "menu_photo", "phone", "in_person"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateRestaurant(input) {
  const errors = [];
  const value = {};

  value.id = requireUUID(input?.id, "id", errors);
  value.name = requireText(input?.name, "name", errors, 200);
  value.neighborhood = requireText(input?.neighborhood, "neighborhood", errors, 120);
  value.address = requireText(input?.address, "address", errors, 300);
  value.latitude = requireNumber(input?.latitude, "latitude", -90, 90, errors);
  value.longitude = requireNumber(input?.longitude, "longitude", -180, 180, errors);
  value.verificationMethod = optionalEnum(
    input?.verificationMethod, "verificationMethod", VERIFICATION_METHODS, "official_url", errors
  );
  // A restaurant with no menu online is still a real restaurant; it just cannot
  // be checked automatically. Require the URL only when we claim to have one.
  if (input?.menuURL == null && value.verificationMethod !== "official_url") {
    value.menuURL = null;
  } else {
    value.menuURL = requireHTTPURL(input?.menuURL, "menuURL", errors);
    if (input?.menuURL == null) {
      errors.push('menuURL is required unless verificationMethod is menu_photo, phone, or in_person');
    }
  }
  value.checkURL = input?.checkURL == null
    ? null
    : requireHTTPURL(input.checkURL, "checkURL", errors);
  // Where a restaurant declares that its whole menu is vegan or vegetarian, when
  // that is somewhere other than the menu itself — typically a home or about
  // page. Optional, and read for nothing but that claim.
  value.claimURL = input?.claimURL == null
    ? null
    : requireHTTPURL(input.claimURL, "claimURL", errors);
  value.extractionMode = optionalEnum(
    input?.extractionMode, "extractionMode", EXTRACTION_MODES, "change_detection", errors
  );
  value.menuProfile = optionalEnum(
    input?.menuProfile, "menuProfile", MENU_PROFILES, "unknown", errors
  );
  value.coverageScope = typeof input?.coverageScope === "string" && input.coverageScope.trim()
    ? input.coverageScope.trim()
    : "Qualifying items found on the official menu";

  return { valid: errors.length === 0, errors, value };
}

export function validateMenuItems(input) {
  const errors = [];
  if (!Array.isArray(input)) {
    return { valid: false, errors: ["menuItems must be an array"], value: [] };
  }

  const seen = new Set();
  const value = input.map((item, index) => {
    const at = `menuItems[${index}]`;
    const id = requireUUID(item?.id, `${at}.id`, errors);
    if (id) {
      if (seen.has(id)) errors.push(`${at}.id is duplicated within this menu`);
      seen.add(id);
    }
    const dietaryStatus = requireEnum(item?.dietaryStatus, `${at}.dietaryStatus`, DIETARY_STATUSES, errors);

    // A modified dish is only safe to publish alongside the change that makes it
    // qualify, and an unmodified dish carrying a note misleads in the other
    // direction. The app renders this note as an instruction to the diner.
    const note = typeof item?.modificationNote === "string" ? item.modificationNote.trim() : null;
    if (dietaryStatus?.startsWith("Can be made") && !note) {
      errors.push(`${at}.modificationNote is required for "${dietaryStatus}"`);
    }
    if (dietaryStatus && !dietaryStatus.startsWith("Can be made") && note) {
      errors.push(`${at}.modificationNote is only valid for a modified dish`);
    }

    return {
      id,
      name: requireText(item?.name, `${at}.name`, errors, 200),
      description: typeof item?.description === "string" ? item.description.trim() : "",
      price: requireText(item?.price, `${at}.price`, errors, 60),
      dietaryStatus,
      modificationNote: note || null,
      // Every published claim must be traceable to something on the official menu.
      sourceEvidence: requireText(item?.sourceEvidence, `${at}.sourceEvidence`, errors, 2_000)
    };
  });

  return { valid: errors.length === 0, errors, value };
}

// A v5-shaped UUID derived from a seed string. Deterministic, so the same real
// thing keeps the same identity across runs without a registry to look it up in.
export function derivedUUID(seed) {
  const digest = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8), digest.slice(8, 12),
    `5${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32)
  ].join("-");
}

// Identity for a restaurant a discovery source produced, which arrives with no
// id of its own. Derived from name and address together because neither is
// unique alone: a chain repeats the name across town, and a single address
// outlives the businesses that occupy it.
//
// This is what makes a bulk import safe to re-run. It is not a claim that the
// pair is globally unique — two records that disagree about spelling or
// formatting will import as two restaurants, which is a duplicate to merge
// rather than an audited menu overwritten by mistake. That is the right way for
// this to fail.
export function stableRestaurantID(name, address) {
  return derivedUUID(`restaurant:${collapse(name)}|${collapse(address)}`);
}

function collapse(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function requireUUID(value, field, errors) {
  if (typeof value !== "string" || !UUID.test(value)) {
    errors.push(`${field} must be a UUID`);
    return null;
  }
  return value.toLowerCase();
}

function requireText(value, field, errors, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field} is required`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    errors.push(`${field} must be ${maxLength} characters or fewer`);
    return null;
  }
  return trimmed;
}

function requireNumber(value, field, min, max, errors) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    errors.push(`${field} must be a number between ${min} and ${max}`);
    return null;
  }
  return value;
}

function requireHTTPURL(value, field, errors) {
  if (typeof value !== "string") {
    errors.push(`${field} must be an http(s) URL`);
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("bad protocol");
    return url.toString();
  } catch {
    errors.push(`${field} must be an http(s) URL`);
    return null;
  }
}

function requireEnum(value, field, allowed, errors) {
  if (!allowed.includes(value)) {
    errors.push(`${field} must be one of: ${allowed.join(", ")}`);
    return null;
  }
  return value;
}

function optionalEnum(value, field, allowed, fallback, errors) {
  if (value == null) return fallback;
  return requireEnum(value, field, allowed, errors) ?? fallback;
}
