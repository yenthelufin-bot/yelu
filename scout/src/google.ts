import type { LatLng } from "./geo.ts";

// Thin client over the Google Maps Platform REST APIs we use. `fetch` is
// injectable so tests can run without a key or network.

export class GoogleApiError extends Error {
  constructor(api: string, status: string, detail?: string) {
    super(`${api}: ${status}${detail ? ` — ${detail}` : ""}`);
  }
}

export interface GeocodeResult {
  location: LatLng;
  formattedAddress: string;
}

export interface PlaceResult {
  id: string;
  name: string;
  location: LatLng;
  address: string;
  types: string[];
}

export interface StreetViewMeta {
  panoId: string;
  location: LatLng;
  date: string | null;
}

export class GoogleMaps {
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(apiKey: string, fetchFn: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  async geocode(query: string): Promise<GeocodeResult> {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.search = new URLSearchParams({ address: query, language: "nl", key: this.apiKey }).toString();
    const body = await this.getJson(url, "Geocoding");
    if (body.status !== "OK" || !body.results?.length) {
      throw new GoogleApiError("Geocoding", body.status, body.error_message ?? `geen resultaat voor "${query}"`);
    }
    const first = body.results[0];
    return { location: first.geometry.location, formattedAddress: first.formatted_address };
  }

  /** Places API (New) text search, biased to a circle. Each page of 20 is one billed request. */
  async searchText(query: string, center: LatLng, radiusM: number, maxPages = 1): Promise<PlaceResult[]> {
    const results: PlaceResult[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      pages++;
      const res = await this.fetchFn("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.formattedAddress,places.types,nextPageToken",
        },
        body: JSON.stringify({
          textQuery: query,
          languageCode: "nl",
          pageSize: 20,
          pageToken,
          // The API caps a bias circle at 50 km.
          locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: Math.min(radiusM, 50_000) } },
        }),
      });
      const body = (await res.json()) as any;
      if (!res.ok) throw new GoogleApiError("Places", String(res.status), body?.error?.message);
      for (const p of body.places ?? []) {
        results.push({
          id: p.id,
          name: p.displayName?.text ?? query,
          location: { lat: p.location.latitude, lng: p.location.longitude },
          address: p.formattedAddress ?? "",
          types: p.types ?? [],
        });
      }
      pageToken = body.nextPageToken;
    } while (pageToken && pages < maxPages);
    return results;
  }

  /** Street View metadata lookups are free of charge; image requests are not. */
  async streetViewMeta(location: LatLng, radiusM = 50): Promise<StreetViewMeta | null> {
    const url = new URL("https://maps.googleapis.com/maps/api/streetview/metadata");
    url.search = new URLSearchParams({
      location: `${location.lat},${location.lng}`,
      radius: String(radiusM),
      source: "outdoor",
      key: this.apiKey,
    }).toString();
    const body = await this.getJson(url, "Street View metadata");
    if (body.status === "ZERO_RESULTS" || body.status === "NOT_FOUND") return null;
    if (body.status !== "OK") throw new GoogleApiError("Street View metadata", body.status, body.error_message);
    // Only Google's own car imagery; user-uploaded photospheres are often indoor or blurry.
    if (typeof body.copyright === "string" && !body.copyright.includes("Google")) return null;
    return { panoId: body.pano_id, location: body.location, date: body.date ?? null };
  }

  async streetViewImage(panoId: string, heading: number, size = 640, fov = 90): Promise<Buffer> {
    const url = new URL("https://maps.googleapis.com/maps/api/streetview");
    url.search = new URLSearchParams({
      size: `${size}x${size}`,
      pano: panoId,
      heading: String(Math.round(heading)),
      fov: String(fov),
      pitch: "0",
      return_error_code: "true",
      key: this.apiKey,
    }).toString();
    const res = await this.fetchFn(url);
    if (!res.ok) throw new GoogleApiError("Street View", String(res.status), await res.text());
    return Buffer.from(await res.arrayBuffer());
  }

  private async getJson(url: URL, api: string): Promise<any> {
    const res = await this.fetchFn(url);
    if (!res.ok) throw new GoogleApiError(api, String(res.status), await res.text());
    return res.json();
  }
}
