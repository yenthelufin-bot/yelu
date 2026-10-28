import { z } from "zod";
import type { LatLng } from "./geo.ts";

export const SearchRequestSchema = z.object({
  place: z.string().trim().min(2, "Geef een gemeente of stad op"),
  radiusKm: z.number().min(0.5).max(50),
  locationTypes: z.array(z.string()).min(1, "Kies minstens één type locatie"),
  description: z.string().trim().max(500).default(""),
  colorPresets: z.array(z.string()).default([]),
  customColors: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).max(6).default([]),
  extraFilters: z.array(z.string()).default([]),
  shootType: z.string().default(""),
  minPanoYear: z.number().int().min(2007).max(2100).nullable().default(null),
  maxCandidates: z.number().int().min(5).max(200).default(40),
  minScore: z.number().min(0).max(100).default(60),
  sources: z
    .object({ places: z.boolean(), osm: z.boolean(), grid: z.boolean() })
    .default({ places: true, osm: true, grid: true }),
});

export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export type CandidateSource = "places" | "osm" | "grid";

/** A spot worth looking at, before Street View has been checked. */
export interface Candidate {
  location: LatLng;
  source: CandidateSource;
  name: string;
  detail: string;
}

/** A candidate with a Street View panorama next to it. */
export interface PanoCandidate extends Candidate {
  panoId: string;
  panoLocation: LatLng;
  panoDate: string | null;
  headings: number[];
}

export interface ColorSwatch {
  hex: string;
  name: string;
}

export interface ScoredLocation extends PanoCandidate {
  id: string;
  score: number;
  typeMatch: string;
  colorScore: number | null;
  palette: ColorSwatch[];
  bestHeading: number;
  summary: string;
  strengths: string[];
  concerns: string[];
  tags: string[];
  lightAdvice: string;
  rating: "favorite" | "rejected" | null;
  note: string;
}

export const ResultPatchSchema = z.object({
  rating: z.enum(["favorite", "rejected"]).nullable().optional(),
  note: z.string().max(2000).optional(),
});

export interface SearchCost {
  streetViewImages: number;
  placesRequests: number;
  claudeInputTokens: number;
  claudeOutputTokens: number;
  estimatedUsd: number;
}

export interface SavedSearch {
  id: string;
  createdAt: string;
  request: SearchRequest;
  center: LatLng;
  resolvedPlace: string;
  status: "running" | "done" | "cancelled" | "error";
  error: string | null;
  candidatesFound: number;
  analysed: number;
  results: ScoredLocation[];
  cost: SearchCost;
}
