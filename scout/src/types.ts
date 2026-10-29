import { z } from "zod";
import type { LatLng } from "./geo.ts";
import type { ReferenceAnalysis } from "./vision.ts";

const LatLngSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

/**
 * - brief: find spots matching the chosen types, colours and wishes
 * - similar: find spots that look like the reference photos
 * - exact: find where a reference photo was taken
 */
export const SearchModeSchema = z.enum(["brief", "similar", "exact"]);
export type SearchMode = z.infer<typeof SearchModeSchema>;

export const SearchRequestSchema = z
  .object({
    mode: SearchModeSchema.default("brief"),
    /** Uploaded reference photos (see /api/references). */
    referenceIds: z.array(z.string().regex(/^[0-9a-f-]{36}$/)).max(4).default([]),
    place: z.string().trim().default(""),
    /** Searches around this point instead of geocoding `place` ("more like this"). */
    center: LatLngSchema.nullable().default(null),
    radiusKm: z.number().min(0.5).max(50),
    locationTypes: z.array(z.string()).default([]),
    /** Extra Places searches, filled in from the analysis of the reference photos. */
    extraQueries: z.array(z.string().max(120)).max(12).default([]),
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
  })
  .superRefine((r, ctx) => {
    if (r.place.length < 2 && !r.center && r.mode !== "exact") ctx.addIssue({ code: "custom", path: ["place"], message: "Geef een gemeente of stad op" });
    if (r.mode !== "brief" && !r.referenceIds.length) ctx.addIssue({ code: "custom", path: ["referenceIds"], message: "Voeg minstens één voorbeeldfoto toe" });
    if (r.mode === "brief" && !r.locationTypes.length && !r.description) {
      ctx.addIssue({ code: "custom", path: ["locationTypes"], message: "Kies minstens één type locatie" });
    }
  });

export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export type CandidateSource = "places" | "osm" | "grid";

/** A spot worth looking at, before Street View has been checked. */
export interface Candidate {
  location: LatLng;
  source: CandidateSource;
  name: string;
  detail: string;
  /** Google Places id, to look up the owner and contact details later. */
  placeId?: string;
  /** OpenStreetMap tags about access and ownership (access, operator, website, phone, ...). */
  osm?: Record<string, string>;
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

export type AccessVerdict = "publiek" | "privé" | "onduidelijk";

export interface Contact {
  source: "google" | "osm";
  name: string;
  address: string;
  phone: string;
  website: string;
  mapsUrl: string;
  /** How sure we are this is the owner/operator of the spot, not just a neighbour. */
  match: "exact" | "nearby";
}

export interface Vote {
  name: string;
  vote: "up" | "down";
  comment: string;
  at: string;
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
  access: AccessVerdict;
  accessNotes: string;
  /** 0-100 resemblance to the reference photos; null without references. */
  similarity: number | null;
  /** Looked up on request; undefined until then, null when nothing was found. */
  contact?: Contact | null;
}

/** A selection shared with a client or team, who can vote per spot. */
export interface Share {
  token: string;
  searchId: string;
  title: string;
  message: string;
  resultIds: string[];
  createdAt: string;
  votes: Record<string, Vote[]>;
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

/** A spot found for a search that Claude (in the Claude app) still has to look at. */
export interface PendingSpot extends PanoCandidate {
  spotId: string;
  status: "pending" | "viewed" | "assessed" | "skipped";
}

export interface SavedSearch {
  id: string;
  /** "api": assessed with an Anthropic API key; "claude-app": assessed by Claude through the MCP link. */
  engine?: "api" | "claude-app";
  spots?: PendingSpot[];
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
  /** What the reference photos showed, when there were any. */
  analysis?: ReferenceAnalysis;
  /** Why fewer locations were found than asked for. */
  shortfall?: string;
}
