// Geometry helpers on a spherical earth. Accurate to a few metres at the
// distances a scouting radius covers (max 50 km), which is all we need.

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing (0 = north, 90 = east) from `from` towards `to`. */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const φ1 = toRad(from.lat);
  const φ2 = toRad(to.lat);
  const Δλ = toRad(to.lng - from.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeHeading(toDeg(Math.atan2(y, x)));
}

export function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Point reached by travelling `distance` metres from `origin` along `bearing`. */
export function destination(origin: LatLng, bearing: number, distance: number): LatLng {
  const δ = distance / EARTH_RADIUS_M;
  const θ = toRad(bearing);
  const φ1 = toRad(origin.lat);
  const λ1 = toRad(origin.lng);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lng: ((toDeg(λ2) + 540) % 360) - 180 };
}

/**
 * Roughly `count` points spread evenly over a disc, on a sunflower (Fibonacci)
 * spiral. Unlike a square grid this gives an even density for any count, so
 * the sample budget is spent uniformly over the whole radius.
 */
export function spreadPoints(center: LatLng, radiusM: number, count: number): LatLng[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points: LatLng[] = [];
  for (let i = 0; i < count; i++) {
    const r = radiusM * Math.sqrt((i + 0.5) / count);
    points.push(destination(center, toDeg(i * golden), r));
  }
  return points;
}

/**
 * Keeps the first item of every cluster of items closer than `minDistanceM`
 * to an already kept item. Order matters: put the items you prefer first.
 */
export function dedupeByDistance<T extends { location: LatLng }>(items: T[], minDistanceM: number): T[] {
  const kept: T[] = [];
  for (const item of items) {
    if (!kept.some((k) => distanceM(k.location, item.location) < minDistanceM)) kept.push(item);
  }
  return kept;
}
