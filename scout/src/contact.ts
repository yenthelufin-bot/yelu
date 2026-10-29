import { distanceM } from "./geo.ts";
import type { GoogleMaps } from "./google.ts";
import type { Contact, ScoredLocation } from "./types.ts";

// Who to ask for permission to shoot at a spot. In order of certainty:
// 1. the Google place the spot came from,
// 2. contact details mapped in OpenStreetMap,
// 3. the nearest Google place within a few dozen metres (a neighbour at worst,
//    so it is marked as "nearby" for the photographer to judge).

const NEARBY_RADIUS_M = 60;

export type ContactMaps = Pick<GoogleMaps, "placeDetails" | "nearbyPlaces">;

function fromOsm(result: ScoredLocation): Contact | null {
  const t = result.osm;
  if (!t) return null;
  const phone = t.phone ?? t["contact:phone"] ?? "";
  const email = t.email ?? t["contact:email"] ?? "";
  // No website but an e-mail address: a mailto link is just as useful to ask for permission.
  const website = t.website ?? t["contact:website"] ?? (email ? `mailto:${email}` : "");
  const name = t.operator ?? t.owner ?? t.name ?? "";
  if (!phone && !website) return null;
  const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
  const address = [street, [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return { source: "osm", name, address, phone, website, mapsUrl: "", match: "exact" };
}

export async function lookupContact(result: ScoredLocation, maps: ContactMaps): Promise<Contact | null> {
  if (result.placeId) {
    return { source: "google", match: "exact", ...(await maps.placeDetails(result.placeId)) };
  }
  const osm = fromOsm(result);
  if (osm) return osm;
  const nearby = (await maps.nearbyPlaces(result.location, NEARBY_RADIUS_M)).sort(
    (a, b) => distanceM(result.location, a.location) - distanceM(result.location, b.location),
  )[0];
  if (!nearby) return null;
  return { source: "google", match: "nearby", ...(await maps.placeDetails(nearby.id)) };
}
