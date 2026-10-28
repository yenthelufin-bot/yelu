import { randomUUID } from "node:crypto";
import { bearingDeg, dedupeByDistance, distanceM, type LatLng, spreadPoints } from "./geo.ts";
import type { GoogleMaps } from "./google.ts";
import { lightAdvice } from "./light.ts";
import type { OsmFeature } from "./overpass.ts";
import { LOCATION_TYPES } from "./presets.ts";
import type { Candidate, CandidateSource, PanoCandidate, SavedSearch, ScoredLocation, SearchCost, SearchRequest } from "./types.ts";
import { type AssessmentResult, buildBrief, PRICE_INPUT_PER_MTOK, PRICE_OUTPUT_PER_MTOK, type ViewImage } from "./vision.ts";

// Google list prices (USD), used for the cost shown in the UI.
export const PRICE_STREET_VIEW_IMAGE = 0.007;
export const PRICE_PLACES_TEXT_SEARCH = 0.032;

const QUERIES_PER_TYPE = 3;
const OSM_LIMIT = 400;
const METADATA_CALLS_PER_CANDIDATE = 4;
const CONCURRENCY = 3;

export type SearchEvent =
  | { type: "status"; message: string }
  | { type: "candidates"; total: number; bySource: Record<CandidateSource, number> }
  | { type: "progress"; analysed: number; total: number; cost: SearchCost }
  | { type: "result"; result: ScoredLocation }
  | { type: "skipped"; name: string; reason: string }
  | { type: "done"; search: SavedSearch };

export interface Judge {
  assess(brief: string, views: ViewImage[], context: string): Promise<AssessmentResult>;
}

export interface PipelineDeps {
  maps: Pick<GoogleMaps, "geocode" | "searchText" | "streetViewMeta" | "streetViewImage">;
  judge: Judge;
  overpass: (selectors: string[], center: LatLng, radiusM: number, limit: number) => Promise<OsmFeature[]>;
  /** Called with the analysed images of a result, so the server can show them. */
  onImages?: (searchId: string, resultId: string, images: ViewImage[]) => void;
  /** Called whenever the search changed enough to be worth saving. */
  onUpdate?: (search: SavedSearch) => void;
}

function emptyCost(): SearchCost {
  return { streetViewImages: 0, placesRequests: 0, claudeInputTokens: 0, claudeOutputTokens: 0, estimatedUsd: 0 };
}

function priceCost(cost: SearchCost): SearchCost {
  const usd =
    cost.streetViewImages * PRICE_STREET_VIEW_IMAGE +
    cost.placesRequests * PRICE_PLACES_TEXT_SEARCH +
    (cost.claudeInputTokens * PRICE_INPUT_PER_MTOK + cost.claudeOutputTokens * PRICE_OUTPUT_PER_MTOK) / 1e6;
  return { ...cost, estimatedUsd: Math.round(usd * 100) / 100 };
}

/** Upper bound on what a search can cost, shown before it starts. */
export function estimateMaxCost(req: SearchRequest): number {
  const placesQueries = req.sources.places ? req.locationTypes.length * QUERIES_PER_TYPE + (req.description ? 1 : 0) : 0;
  const images = req.maxCandidates * 4;
  const claude = req.maxCandidates * ((5_000 * PRICE_INPUT_PER_MTOK + 1_500 * PRICE_OUTPUT_PER_MTOK) / 1e6);
  return Math.round((placesQueries * PRICE_PLACES_TEXT_SEARCH + images * PRICE_STREET_VIEW_IMAGE + claude) * 100) / 100;
}

/** Takes items from each list in turn, so no single source dominates the budget. */
export function interleave<T>(lists: T[][]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const list of lists) if (i < list.length) out.push(list[i]);
  return out;
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The camera directions to look in from a panorama. */
export function headingsFor(candidate: Candidate, panoLocation: LatLng): number[] {
  // A named spot next to the road: look at it, and a bit to either side.
  if (candidate.source !== "grid" && distanceM(panoLocation, candidate.location) > 15) {
    const toward = bearingDeg(panoLocation, candidate.location);
    return [toward, toward - 70, toward + 70].map((h) => ((h % 360) + 360) % 360);
  }
  // A sampled point or a spot right on the road: look all around.
  return [0, 90, 180, 270];
}

/**
 * Errors that will fail for every spot alike: a bad or missing key, an API
 * that isn't enabled, no credit. Continuing would only spend money.
 */
export function isFatal(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (status === 401 || status === 402 || status === 403) return true;
  const message = err instanceof Error ? err.message : "";
  return /REQUEST_DENIED|API key|: 40[13]\b|credit balance/i.test(message);
}

async function mapLimit<T>(items: T[], limit: number, signal: AbortSignal, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !signal.aborted) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function runSearch(
  req: SearchRequest,
  deps: PipelineDeps,
  emit: (event: SearchEvent) => void,
  outerSignal: AbortSignal,
  id: string = randomUUID(),
): Promise<SavedSearch> {
  const radiusM = req.radiusKm * 1000;
  const halt = new AbortController();
  const signal = AbortSignal.any([outerSignal, halt.signal]);
  let fatalError: unknown = null;
  let cost = emptyCost();
  const search: SavedSearch = {
    id,
    createdAt: new Date().toISOString(),
    request: req,
    center: { lat: 0, lng: 0 },
    resolvedPlace: req.place,
    status: "running",
    error: null,
    candidatesFound: 0,
    analysed: 0,
    results: [],
    cost,
  };
  const update = () => {
    search.cost = cost = priceCost(cost);
    deps.onUpdate?.(search);
  };
  update();

  try {
    emit({ type: "status", message: `Zoeken naar "${req.place}"…` });
    const geo = await deps.maps.geocode(req.place);
    search.center = geo.location;
    search.resolvedPlace = geo.formattedAddress;
    update();

    const types = req.locationTypes.map((id) => LOCATION_TYPES.find((t) => t.id === id)).filter((t) => t !== undefined);
    const inRadius = (c: Candidate) => distanceM(geo.location, c.location) <= radiusM;
    const warn = (source: string, err: unknown) =>
      emit({ type: "status", message: `${source} niet beschikbaar: ${err instanceof Error ? err.message : String(err)}` });

    const fromPlaces: Candidate[] = [];
    if (req.sources.places) {
      emit({ type: "status", message: "Google Places doorzoeken…" });
      const queries = types.flatMap((t) => t.placesQueries.slice(0, QUERIES_PER_TYPE));
      if (req.description) queries.unshift(req.description);
      for (const query of queries) {
        if (signal.aborted) break;
        try {
          cost.placesRequests++;
          for (const p of await deps.maps.searchText(query, geo.location, radiusM)) {
            fromPlaces.push({ location: p.location, source: "places", name: p.name, detail: p.address });
          }
        } catch (err) {
          warn("Google Places", err);
          break;
        }
      }
    }

    let fromOsm: Candidate[] = [];
    if (req.sources.osm && !signal.aborted) {
      emit({ type: "status", message: "OpenStreetMap doorzoeken…" });
      try {
        const features = await deps.overpass(types.flatMap((t) => t.overpass), geo.location, radiusM, OSM_LIMIT);
        // Big areas such as an industrial zone come back as dozens of buildings;
        // keep one spot per 300 m so they don't eat the whole budget.
        fromOsm = dedupeByDistance(
          shuffle(features).map((f) => ({ location: f.location, source: "osm" as const, name: f.name, detail: "OpenStreetMap" })),
          300,
        );
      } catch (err) {
        warn("OpenStreetMap", err);
      }
    }

    const fromGrid: Candidate[] = req.sources.grid
      ? spreadPoints(geo.location, radiusM, req.maxCandidates * 2).map((location, i) => ({
          location,
          source: "grid" as const,
          name: `Steekproefpunt ${i + 1}`,
          detail: "Willekeurige straat in de zoekzone",
        }))
      : [];

    const candidates = dedupeByDistance(
      interleave([fromPlaces.filter(inRadius), fromOsm.filter(inRadius), shuffle(fromGrid)]),
      120,
    );
    search.candidatesFound = candidates.length;
    emit({
      type: "candidates",
      total: candidates.length,
      bySource: {
        places: candidates.filter((c) => c.source === "places").length,
        osm: candidates.filter((c) => c.source === "osm").length,
        grid: candidates.filter((c) => c.source === "grid").length,
      },
    });
    update();
    if (!candidates.length) throw new Error("Geen kandidaat-locaties gevonden. Vergroot de straal of kies andere types.");

    // Find Street View coverage. Metadata is free, so we look at more
    // candidates than we will analyse and keep the first that have a panorama.
    emit({ type: "status", message: "Street View-dekking controleren…" });
    const panos: PanoCandidate[] = [];
    const seenPanos = new Set<string>();
    const toCheck = candidates.slice(0, req.maxCandidates * METADATA_CALLS_PER_CANDIDATE);
    await mapLimit(toCheck, 8, signal, async (c) => {
      if (panos.length >= req.maxCandidates) return;
      const meta = await deps.maps.streetViewMeta(c.location, c.source === "grid" ? 150 : 80).catch((err) => {
        if (isFatal(err)) {
          fatalError ??= err;
          halt.abort();
        }
        return null;
      });
      if (!meta || seenPanos.has(meta.panoId)) return;
      const year = meta.date ? Number(meta.date.slice(0, 4)) : null;
      if (req.minPanoYear && year !== null && year < req.minPanoYear) return;
      seenPanos.add(meta.panoId);
      if (panos.length < req.maxCandidates) {
        panos.push({ ...c, panoId: meta.panoId, panoLocation: meta.location, panoDate: meta.date, headings: headingsFor(c, meta.location) });
      }
    });
    if (fatalError) throw fatalError;
    if (!panos.length && !signal.aborted) throw new Error("Geen Street View-beelden gevonden in deze zone.");

    const brief = buildBrief(req);
    emit({ type: "status", message: `${panos.length} plekken bekijken met Street View en Claude…` });
    emit({ type: "progress", analysed: 0, total: panos.length, cost });

    await mapLimit(panos, CONCURRENCY, signal, async (pano) => {
      try {
        const views: ViewImage[] = [];
        for (const heading of pano.headings) {
          views.push({ heading, jpeg: await deps.maps.streetViewImage(pano.panoId, heading) });
          cost.streetViewImages++;
        }
        const context = `${pano.name} (${pano.detail}), Street View from ${pano.panoDate ?? "unknown date"}`;
        const verdict = await deps.judge.assess(brief, views, context);
        cost.claudeInputTokens += verdict.inputTokens;
        cost.claudeOutputTokens += verdict.outputTokens;
        const a = verdict.assessment;
        if (!a) {
          emit({ type: "skipped", name: pano.name, reason: verdict.skippedReason ?? "onbekend" });
        } else if (!a.usable) {
          emit({ type: "skipped", name: pano.name, reason: "geen bruikbaar Street View-beeld" });
        } else {
          const bestHeading = views[a.bestViewIndex].heading;
          const result: ScoredLocation = {
            ...pano,
            id: randomUUID(),
            score: a.score,
            typeMatch: a.typeMatch,
            colorScore: a.colorScore,
            palette: a.palette,
            bestHeading,
            summary: a.summary,
            strengths: a.strengths,
            concerns: a.concerns,
            tags: a.tags,
            lightAdvice: lightAdvice(bestHeading),
            rating: null,
            note: "",
          };
          deps.onImages?.(id, result.id, views);
          search.results.push(result);
          search.results.sort((x, y) => y.score - x.score);
          emit({ type: "result", result });
        }
      } catch (err) {
        if (isFatal(err)) {
          fatalError ??= err;
          halt.abort();
          return;
        }
        emit({ type: "skipped", name: pano.name, reason: err instanceof Error ? err.message : String(err) });
      }
      search.analysed++;
      update();
      emit({ type: "progress", analysed: search.analysed, total: panos.length, cost });
    });

    if (fatalError) throw fatalError;
    search.status = outerSignal.aborted ? "cancelled" : "done";
  } catch (err) {
    search.status = outerSignal.aborted ? "cancelled" : "error";
    search.error = err instanceof Error ? err.message : String(err);
  }
  update();
  emit({ type: "done", search });
  return search;
}
