// Nearby queries prefilter with a bounding box in SQL — plain arithmetic that both
// SQLite and PostgreSQL index the same way — then rank by true distance in JS.
// Exact enough for a city, and it keeps the two stores from drifting apart.

const KM_PER_DEGREE_LATITUDE = 111.045;
export const EARTH_RADIUS_KM = 6371.0088;

export function boundingBox(latitude, longitude, radiusKm) {
  const latitudeDelta = radiusKm / KM_PER_DEGREE_LATITUDE;
  // Longitude degrees shrink toward the poles. The floor stops the box exploding
  // to the whole world near them.
  const shrink = Math.max(Math.cos(toRadians(latitude)), 0.01);
  const longitudeDelta = radiusKm / (KM_PER_DEGREE_LATITUDE * shrink);
  return {
    minLatitude: latitude - latitudeDelta,
    maxLatitude: latitude + latitudeDelta,
    minLongitude: longitude - longitudeDelta,
    maxLongitude: longitude + longitudeDelta
  };
}

export function distanceKm(fromLatitude, fromLongitude, toLatitude, toLongitude) {
  const dLat = toRadians(toLatitude - fromLatitude);
  const dLon = toRadians(toLongitude - fromLongitude);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(fromLatitude)) * Math.cos(toRadians(toLatitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

// Cursors are opaque to clients but must survive a round trip unchanged, so they
// carry the exact sort key the next page resumes from.
export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null) return null;
    return value;
  } catch {
    return null;
  }
}
