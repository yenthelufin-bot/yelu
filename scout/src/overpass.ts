import type { LatLng } from "./geo.ts";

// OpenStreetMap via the public Overpass API. Free, no key, and it knows things
// Google Places doesn't list: industrial land use, ruins, disused buildings,
// silos, bridges. Be gentle with it: one request per search.

export interface OsmFeature {
  location: LatLng;
  name: string;
  tags: Record<string, string>;
}

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

export function buildOverpassQuery(selectors: string[], center: LatLng, radiusM: number, limit: number): string {
  const around = `(around:${Math.round(radiusM)},${center.lat.toFixed(6)},${center.lng.toFixed(6)})`;
  const body = selectors.map((s) => `  ${s}${around};`).join("\n");
  return `[out:json][timeout:60];\n(\n${body}\n);\nout center tags ${limit};`;
}

export async function queryOverpass(
  selectors: string[],
  center: LatLng,
  radiusM: number,
  limit: number,
  fetchFn: typeof fetch = fetch,
): Promise<OsmFeature[]> {
  if (!selectors.length) return [];
  const res = await fetchFn(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "location-scout/1.0" },
    body: new URLSearchParams({ data: buildOverpassQuery(selectors, center, radiusM, limit) }),
    // The public server can be slow; better to continue without OSM than to hang.
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Overpass: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { elements?: any[] };
  const features: OsmFeature[] = [];
  for (const el of body.elements ?? []) {
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    const tags: Record<string, string> = el.tags ?? {};
    features.push({ location: { lat, lng }, name: tags.name ?? describeTags(tags), tags });
  }
  return features;
}

/** A readable Dutch label for an unnamed OSM feature. */
export function describeTags(tags: Record<string, string>): string {
  const labels: [string, string, string][] = [
    ["building", "ruins", "Ruïne"],
    ["historic", "ruins", "Ruïne"],
    ["abandoned", "yes", "Verlaten plek"],
    ["disused", "yes", "Buiten gebruik"],
    ["man_made", "silo", "Silo"],
    ["man_made", "gasometer", "Gashouder"],
    ["man_made", "storage_tank", "Opslagtank"],
    ["man_made", "chimney", "Schoorsteen"],
    ["man_made", "windmill", "Molen"],
    ["man_made", "works", "Fabriek"],
    ["landuse", "industrial", "Industriegebied"],
    ["landuse", "farmland", "Akkerland"],
    ["landuse", "meadow", "Weiland"],
    ["landuse", "orchard", "Boomgaard"],
    ["landuse", "forest", "Bos"],
    ["natural", "wood", "Bos"],
    ["natural", "heath", "Heide"],
    ["natural", "water", "Water"],
    ["natural", "beach", "Strand"],
    ["building", "barn", "Schuur"],
    ["building", "church", "Kerk"],
    ["building", "chapel", "Kapel"],
    ["bridge", "yes", "Brug"],
    ["tunnel", "yes", "Tunnel"],
    ["tourism", "artwork", "Kunstwerk"],
    ["amenity", "parking", "Parkeergarage"],
  ];
  for (const [key, value, label] of labels) if (tags[key] === value) return label;
  const first = Object.entries(tags)[0];
  return first ? `${first[0]}=${first[1]}` : "OSM-locatie";
}
