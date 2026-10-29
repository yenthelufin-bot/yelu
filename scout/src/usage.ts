import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LatLng } from "./geo.ts";
import type { GoogleMaps } from "./google.ts";

// Keeps Google usage inside the free monthly amount of each paid API, so the
// tool never costs anything. Google resets free usage on the 1st of the month,
// midnight Pacific time; the counters here follow the same calendar.
// Street View metadata and the Maps Embed API are free without a cap.

export type Sku = "geocode" | "placesTextSearch" | "streetViewImage" | "placeDetails" | "nearbySearch";

/** Google's free monthly amounts, minus a margin for calls made outside this tool. */
export const FREE_LIMITS: Record<Sku, number> = {
  geocode: 9_500, // Geocoding (Essentials): 10,000 free
  placesTextSearch: 4_750, // Text Search Pro: 5,000 free
  streetViewImage: 9_500, // Static Street View (Essentials): 10,000 free
  placeDetails: 950, // Place Details with phone and website (Enterprise): 1,000 free
  nearbySearch: 4_750, // Nearby Search (Pro): 5,000 free
};

export const SKU_LABELS: Record<Sku, string> = {
  geocode: "Plaatsen opzoeken",
  placesTextSearch: "Google Places-zoekopdrachten",
  streetViewImage: "Street View-beelden",
  placeDetails: "Contactgegevens opzoeken",
  nearbySearch: "Eigenaar in de buurt zoeken",
};

export class FreeLimitError extends Error {
  // Read by isFatal(): continuing would cost money.
  readonly status = 402;
  constructor(sku: Sku, limit: number) {
    super(`Gratis maandlimiet bereikt voor ${SKU_LABELS[sku]} (${limit}). Vanaf de 1e van de volgende maand kan het weer.`);
  }
}

function currentMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).formatToParts(now);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

interface UsageFile {
  month: string;
  counts: Record<Sku, number>;
}

export interface UsageReport {
  month: string;
  enforced: boolean;
  items: { sku: Sku; label: string; used: number; limit: number }[];
}

/**
 * Monthly counters on disk. Reads and writes are synchronous so two processes
 * (the web app and the Claude link) sharing one data folder stay consistent.
 */
export class UsageMeter {
  private readonly file: string;
  private readonly limits: Record<Sku, number>;
  private readonly enforced: boolean;
  private readonly now: () => Date;

  constructor(dataDir: string, opts: { limits?: Partial<Record<Sku, number>>; enforced?: boolean; now?: () => Date } = {}) {
    this.file = path.join(dataDir, "usage.json");
    this.limits = { ...FREE_LIMITS, ...opts.limits };
    this.enforced = opts.enforced ?? true;
    this.now = opts.now ?? (() => new Date());
  }

  private read(): UsageFile {
    const month = currentMonth(this.now());
    const empty: UsageFile = { month, counts: { geocode: 0, placesTextSearch: 0, streetViewImage: 0, placeDetails: 0, nearbySearch: 0 } };
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as UsageFile;
      return data.month === month ? { month, counts: { ...empty.counts, ...data.counts } } : empty;
    } catch {
      return empty;
    }
  }

  /** Counts one call, or throws FreeLimitError instead when it would go over the free amount. */
  take(sku: Sku, amount = 1): void {
    const data = this.read();
    if (this.enforced && data.counts[sku] + amount > this.limits[sku]) throw new FreeLimitError(sku, this.limits[sku]);
    data.counts[sku] += amount;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(data, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  remaining(sku: Sku): number {
    return Math.max(0, this.limits[sku] - this.read().counts[sku]);
  }

  report(): UsageReport {
    const data = this.read();
    return {
      month: data.month,
      enforced: this.enforced,
      items: (Object.keys(this.limits) as Sku[]).map((sku) => ({ sku, label: SKU_LABELS[sku], used: data.counts[sku], limit: this.limits[sku] })),
    };
  }
}

type Maps = Pick<GoogleMaps, "geocode" | "searchText" | "streetViewMeta" | "streetViewImage">;
type ContactMaps = Pick<GoogleMaps, "placeDetails" | "nearbyPlaces">;

/** Same as meteredMaps, for the contact lookups. */
export function meteredContactMaps(maps: ContactMaps, meter: UsageMeter): ContactMaps {
  return {
    placeDetails: (placeId: string) => {
      meter.take("placeDetails");
      return maps.placeDetails(placeId);
    },
    nearbyPlaces: (location: LatLng, radiusM: number) => {
      meter.take("nearbySearch");
      return maps.nearbyPlaces(location, radiusM);
    },
  };
}

/** Wraps the Google client so every paid call is counted first. */
export function meteredMaps(maps: Maps, meter: UsageMeter): Maps {
  return {
    geocode: (query: string) => {
      meter.take("geocode");
      return maps.geocode(query);
    },
    searchText: (query: string, center: LatLng, radiusM: number) => {
      meter.take("placesTextSearch");
      return maps.searchText(query, center, radiusM, 1);
    },
    streetViewMeta: (location: LatLng, radiusM?: number) => maps.streetViewMeta(location, radiusM),
    streetViewImage: (panoId: string, heading: number, size?: number, fov?: number) => {
      meter.take("streetViewImage");
      return maps.streetViewImage(panoId, heading, size, fov);
    },
  };
}
