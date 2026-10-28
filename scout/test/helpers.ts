import { destination, type LatLng } from "../src/geo.ts";
import type { PipelineDeps } from "../src/pipeline.ts";
import { type SearchRequest, SearchRequestSchema } from "../src/types.ts";
import type { AssessmentResult } from "../src/vision.ts";

export const GENT: LatLng = { lat: 51.0543, lng: 3.7174 };

export function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return SearchRequestSchema.parse({ place: "Gent", radiusKm: 5, locationTypes: ["industrieel"], maxCandidates: 6, ...overrides });
}

export function verdict(score: number, overrides: Partial<NonNullable<AssessmentResult["assessment"]>> = {}): AssessmentResult {
  return {
    assessment: {
      usable: true,
      score,
      typeMatch: "industrieel",
      colorScore: null,
      palette: [{ hex: "#8c5a3c", name: "roest" }],
      bestViewIndex: 0,
      summary: "Roestige loods met grote schuifdeur.",
      strengths: ["mooie textuur"],
      concerns: [],
      tags: ["roest"],
      ...overrides,
    },
    skippedReason: null,
    inputTokens: 5000,
    outputTokens: 400,
  };
}

/** Fake Google/OSM/Claude clients. Every point has a panorama 10 m north of it. */
export function fakeDeps(opts: { scores?: number[]; places?: number; osm?: number } = {}) {
  const calls = { images: 0, meta: 0, assess: 0, places: 0 };
  let scoreIndex = 0;
  const deps: PipelineDeps = {
    maps: {
      geocode: async () => ({ location: GENT, formattedAddress: "Gent, België" }),
      searchText: async (query) => {
        calls.places++;
        return Array.from({ length: opts.places ?? 3 }, (_, i) => ({
          id: `${query}-${i}`,
          name: `${query} ${i}`,
          location: destination(GENT, 40 * calls.places + i * 90, 400 + 300 * i),
          address: "Gent",
          types: [],
        }));
      },
      streetViewMeta: async (loc) => {
        calls.meta++;
        return { panoId: `pano-${loc.lat.toFixed(5)}-${loc.lng.toFixed(5)}`, location: destination(loc, 0, 10), date: "2023-06" };
      },
      streetViewImage: async () => {
        calls.images++;
        return Buffer.from("jpeg");
      },
    },
    overpass: async () =>
      Array.from({ length: opts.osm ?? 4 }, (_, i) => ({ location: destination(GENT, 200 + i * 40, 1500 + 500 * i), name: `Silo ${i}`, tags: {} })),
    judge: {
      assess: async () => {
        calls.assess++;
        const scores = opts.scores ?? [80];
        return verdict(scores[scoreIndex++ % scores.length]);
      },
    },
  };
  return { deps, calls };
}
