import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { distanceM } from "./geo.ts";
import { GoogleMaps } from "./google.ts";
import { queryOverpass } from "./overpass.ts";
import { findSpots, newSearch, type SpotDeps, toResult } from "./pipeline.ts";
import { COLOR_PRESETS, EXTRA_FILTERS, LOCATION_TYPES } from "./presets.ts";
import { ImageCache, loadEnv } from "./server.ts";
import { SearchStore } from "./store.ts";
import { type PendingSpot, type SavedSearch, SearchRequestSchema } from "./types.ts";
import { meteredMaps, UsageMeter } from "./usage.ts";
import { buildBrief, SYSTEM_PROMPT } from "./vision.ts";

// The free way to run Location Scout: an MCP server for the Claude app.
// The tools here do the Google and OpenStreetMap work and hand the Street
// View images to Claude, who looks at them within the user's Claude plan and
// stores a verdict per spot. Results show up in the same web app.

const IMAGE_SIZE = 512;
const MAX_SPOTS_PER_VIEW = 3;

const ids = <T extends { id: string }>(items: readonly T[]) => items.map((i) => i.id) as [string, ...string[]];

export const SearchInput = {
  place: z.string().min(2).describe("Municipality or city, e.g. 'Gent' or 'Charleroi'"),
  radius_km: z.number().min(0.5).max(50).describe("Search radius around the place, in km"),
  location_types: z.array(z.enum(ids(LOCATION_TYPES))).min(1).describe("One or more kinds of location"),
  description: z.string().max(500).optional().describe("The photographer's own words for what they look for"),
  color_presets: z.array(z.enum(ids(COLOR_PRESETS))).optional().describe("Wanted colour settings"),
  custom_colors: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(6).optional().describe("Wanted colours as #rrggbb"),
  extra_filters: z.array(z.enum(ids(EXTRA_FILTERS))).optional().describe("Extra wishes"),
  shoot_type: z.string().optional().describe("Kind of shoot, e.g. mode, portret, bruiloft, product, auto"),
  min_pano_year: z.number().int().min(2007).optional().describe("Skip Street View imagery older than this year"),
  max_spots: z.number().int().min(5).max(40).optional().describe("How many spots to look at (default 20)"),
};

const AssessmentInput = z.object({
  spot_id: z.string().describe("e.g. 's3'"),
  usable: z.boolean().describe("false if the images are indoor, black, blurred or show nothing assessable"),
  score: z.number().min(0).max(100),
  type_match: z.string().describe("id of the best matching requested location type, or 'geen'"),
  color_score: z.number().min(0).max(100).nullable().describe("null if no colour setting was requested"),
  palette: z.array(z.object({ hex: z.string().regex(/^#[0-9a-fA-F]{6}$/), name: z.string() })).max(5),
  best_view_index: z.number().int().min(0).describe("index of the best image of this spot, as labelled"),
  summary: z.string().describe("1-2 sentences in Dutch"),
  strengths: z.array(z.string()).max(5),
  concerns: z.array(z.string()).max(5),
  tags: z.array(z.string()).max(6),
});

export const INSTRUCTIONS = `Location Scout finds photo and video shoot locations in Belgium, the Netherlands and elsewhere, using Google Street View. You do the looking: the tools fetch the images, you judge them.

Workflow:
1. scout_search with the photographer's wishes. It returns the brief, the scoring guide and a list of spots (s1, s2, ...).
2. scout_view_spots for ${MAX_SPOTS_PER_VIEW} spots at a time, in list order.
3. After each batch, scout_save_assessments with one assessment per spot you just looked at.
4. Repeat 2-3 until every spot is assessed, then scout_finish. Tell the user the best spots and give them the link it returns.
Keep the user posted briefly between batches. Write all text for the user in Dutch.`;

export interface ScoutContext {
  store: SearchStore;
  images: ImageCache;
  meter: UsageMeter;
  /** Real Google and OSM clients, already metered; null when the Google key is missing. */
  deps: SpotDeps | null;
  webUrl: string;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (t: string): { content: Content[] } => ({ content: [{ type: "text", text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });

function describeSpot(s: PendingSpot, search: SavedSearch): string {
  const km = (distanceM(search.center, s.location) / 1000).toFixed(1);
  const source = { places: "Google Places", osm: "OpenStreetMap", grid: "steekproef" }[s.source];
  return `${s.spotId} · ${s.name} · ${source} · ${km} km van centrum · beeld ${s.panoDate ?? "?"}`;
}

function progress(search: SavedSearch): string {
  const spots = search.spots ?? [];
  const open = spots.filter((s) => s.status === "pending" || s.status === "viewed").map((s) => s.spotId);
  const done = spots.length - open.length;
  return open.length
    ? `${done} van ${spots.length} plekken beoordeeld. Nog te bekijken: ${open.slice(0, MAX_SPOTS_PER_VIEW).join(", ")}${open.length > MAX_SPOTS_PER_VIEW ? ` (en ${open.length - MAX_SPOTS_PER_VIEW} meer)` : ""}.`
    : `Alle ${spots.length} plekken zijn beoordeeld. Rond af met scout_finish.`;
}

export function createScoutTools(ctx: ScoutContext) {
  const load = async (id: string) => {
    const search = await ctx.store.get(id).catch(() => null);
    if (!search?.spots) throw new Error(`Zoektocht ${id} niet gevonden. Start een nieuwe met scout_search.`);
    return search;
  };

  return {
    async search(args: z.infer<z.ZodObject<typeof SearchInput>>) {
      if (!ctx.deps) return fail("GOOGLE_MAPS_API_KEY ontbreekt. Zet de sleutel in scout/.env en herstart de Claude-app.");
      const req = SearchRequestSchema.parse({
        place: args.place,
        radiusKm: args.radius_km,
        locationTypes: args.location_types,
        description: args.description ?? "",
        colorPresets: args.color_presets ?? [],
        customColors: args.custom_colors ?? [],
        extraFilters: args.extra_filters ?? [],
        shootType: args.shoot_type ?? "",
        minPanoYear: args.min_pano_year ?? null,
        maxCandidates: args.max_spots ?? 20,
      });
      // Never plan more spots than the free Street View images left this month allow.
      const imagesLeft = ctx.meter.remaining("streetViewImage");
      req.maxCandidates = Math.min(req.maxCandidates, Math.floor(imagesLeft / 4));
      if (req.maxCandidates < 1) return fail("De gratis Street View-beelden van deze maand zijn op. Vanaf de 1e van de volgende maand kan het weer.");

      const search = newSearch(req);
      search.engine = "claude-app";
      const notes: string[] = [];
      try {
        const found = await findSpots(req, ctx.deps, (e) => e.type === "status" && e.message.includes("niet beschikbaar") && notes.push(e.message), AbortSignal.timeout(120_000), search.cost);
        search.center = found.geo.location;
        search.resolvedPlace = found.geo.formattedAddress;
        search.candidatesFound = found.candidatesFound;
        search.spots = found.spots.map((s, i) => ({ ...s, spotId: `s${i + 1}`, status: "pending" }));
      } catch (err) {
        return fail(`Zoeken mislukt: ${err instanceof Error ? err.message : String(err)}`);
      }
      await ctx.store.save(search);

      return text(
        [
          `Zoektocht ${search.id} voor ${search.resolvedPlace}, straal ${req.radiusKm} km.`,
          `${search.candidatesFound} kandidaten gevonden, ${search.spots.length} plekken met Street View.`,
          ...notes,
          `Gratis Street View-beelden over deze maand: ${imagesLeft} (deze zoektocht gebruikt er hooguit ${search.spots.length * 4}).`,
          "",
          "SCORING GUIDE",
          SYSTEM_PROMPT,
          "",
          "THE PHOTOGRAPHER'S BRIEF",
          buildBrief(req),
          "",
          "SPOTS",
          ...search.spots.map((s) => describeSpot(s, search)),
          "",
          `Next: scout_view_spots with search_id "${search.id}" and the first ${MAX_SPOTS_PER_VIEW} spot ids.`,
        ].join("\n"),
      );
    },

    async view(args: { search_id: string; spot_ids: string[] }) {
      if (!ctx.deps) return fail("GOOGLE_MAPS_API_KEY ontbreekt.");
      const search = await load(args.search_id);
      const content: Content[] = [];
      for (const spotId of args.spot_ids.slice(0, MAX_SPOTS_PER_VIEW)) {
        const spot = search.spots!.find((s) => s.spotId === spotId);
        if (!spot) {
          content.push({ type: "text", text: `${spotId}: onbekende plek.` });
          continue;
        }
        content.push({ type: "text", text: `── ${describeSpot(spot, search)}` });
        const views = [];
        try {
          for (const heading of spot.headings) {
            const jpeg = await ctx.deps.maps.streetViewImage(spot.panoId, heading, IMAGE_SIZE);
            search.cost.streetViewImages++;
            views.push({ heading, jpeg });
          }
        } catch (err) {
          content.push({ type: "text", text: `${spotId}: beelden ophalen mislukt (${err instanceof Error ? err.message : String(err)}).` });
          if (views.length === 0) continue;
        }
        views.forEach((v, i) => {
          content.push({ type: "text", text: `${spotId} beeld ${i} (camera kijkt naar ${Math.round(v.heading)}°)` });
          content.push({ type: "image", data: v.jpeg.toString("base64"), mimeType: "image/jpeg" });
        });
        // Result ids equal spot ids, so the web app can show these images.
        ctx.images.put(search.id, spotId, views);
        if (spot.status === "pending") spot.status = "viewed";
      }
      await ctx.store.save(search);
      content.push({ type: "text", text: "Beoordeel deze plekken volgens de scoring guide en sla ze op met scout_save_assessments." });
      return { content };
    },

    async save(args: { search_id: string; assessments: z.infer<typeof AssessmentInput>[] }) {
      const search = await load(args.search_id);
      const saved: string[] = [];
      for (const a of args.assessments) {
        const spot = search.spots!.find((s) => s.spotId === a.spot_id);
        if (!spot) continue;
        search.results = search.results.filter((r) => r.id !== spot.spotId);
        if (a.usable) {
          const result = toResult(
            spot,
            {
              usable: true,
              score: Math.round(a.score),
              typeMatch: a.type_match,
              colorScore: a.color_score === null ? null : Math.round(a.color_score),
              palette: a.palette,
              bestViewIndex: Math.min(a.best_view_index, spot.headings.length - 1),
              summary: a.summary,
              strengths: a.strengths,
              concerns: a.concerns,
              tags: a.tags,
            },
            spot.headings,
            spot.spotId,
          );
          search.results.push(result);
          spot.status = "assessed";
          saved.push(`${spot.spotId} (${result.score})`);
        } else {
          spot.status = "skipped";
          saved.push(`${spot.spotId} (onbruikbaar)`);
        }
      }
      search.results.sort((x, y) => y.score - x.score);
      search.analysed = search.spots!.filter((s) => s.status === "assessed" || s.status === "skipped").length;
      await ctx.store.save(search);
      return text(`Opgeslagen: ${saved.join(", ") || "niets"}. ${progress(search)}`);
    },

    async finish(args: { search_id: string }) {
      const search = await load(args.search_id);
      search.status = "done";
      await ctx.store.save(search);
      const min = search.request.minScore;
      const top = search.results.filter((r) => r.score >= min).slice(0, 8);
      const skippedSpots = search.spots!.filter((s) => s.status === "pending" || s.status === "viewed").length;
      const lines = [
        `Zoektocht afgerond: ${search.results.length} plekken beoordeeld, ${top.length ? `beste ${top.length} met score ${min}+` : `geen enkele met score ${min}+`}.`,
        ...top.map((r) => `- ${r.score} · ${r.name}: ${r.summary} https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(r.panoId)}&heading=${Math.round(r.bestHeading)}`),
        skippedSpots ? `${skippedSpots} plekken niet bekeken.` : "",
        `Alle resultaten, met kaart, favorieten en export: ${ctx.webUrl}/#zoektocht/${search.id}`,
      ];
      return text(lines.filter(Boolean).join("\n"));
    },

    async usage() {
      const r = ctx.meter.report();
      return text(`Gratis Google-gebruik in ${r.month}:\n${r.items.map((i) => `- ${i.label}: ${i.used} van ${i.limit}`).join("\n")}`);
    },
  };
}

export function createMcpServer(ctx: ScoutContext): McpServer {
  const tools = createScoutTools(ctx);
  const server = new McpServer({ name: "location-scout", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const guard =
    <A,>(fn: (args: A) => Promise<{ content: Content[]; isError?: boolean }>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    };

  server.registerTool(
    "scout_search",
    {
      title: "Zoek fotoshootlocaties",
      description: `Start a location search. Finds candidate spots with Street View coverage around a place. Location types: ${LOCATION_TYPES.map((t) => `${t.id} (${t.label})`).join(", ")}. Colour presets: ${COLOR_PRESETS.map((c) => `${c.id} (${c.label})`).join(", ")}. Extra wishes: ${EXTRA_FILTERS.map((f) => `${f.id} (${f.label})`).join(", ")}.`,
      inputSchema: SearchInput,
    },
    guard(tools.search),
  );
  server.registerTool(
    "scout_view_spots",
    {
      title: "Bekijk plekken in Street View",
      description: `Returns the Street View images of up to ${MAX_SPOTS_PER_VIEW} spots of a search, labelled per spot and per image.`,
      inputSchema: { search_id: z.string(), spot_ids: z.array(z.string()).min(1).max(MAX_SPOTS_PER_VIEW) },
      annotations: { readOnlyHint: true },
    },
    guard(tools.view),
  );
  server.registerTool(
    "scout_save_assessments",
    {
      title: "Sla beoordelingen op",
      description: "Stores your verdict for the spots you looked at. Use the scoring guide from scout_search; write text fields in Dutch.",
      inputSchema: { search_id: z.string(), assessments: z.array(AssessmentInput).min(1) },
    },
    guard(tools.save),
  );
  server.registerTool(
    "scout_finish",
    {
      title: "Rond de zoektocht af",
      description: "Marks the search as done and returns the best spots and a link to the results page.",
      inputSchema: { search_id: z.string() },
    },
    guard(tools.finish),
  );
  server.registerTool(
    "scout_usage",
    {
      title: "Gratis Google-gebruik",
      description: "Shows how much of Google's free monthly amount has been used.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    guard(tools.usage),
  );
  return server;
}

const here = path.dirname(fileURLToPath(import.meta.url));

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadEnv();
  const dataDir = process.env.SCOUT_DATA_DIR ?? path.join(here, "..", "data");
  const port = Number(process.env.PORT ?? 4173);
  const store = new SearchStore(dataDir);
  const images = new ImageCache();
  const meter = new UsageMeter(dataDir, { enforced: process.env.SCOUT_FREE_LIMITS !== "off" });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const deps: SpotDeps | null = key ? { maps: meteredMaps(new GoogleMaps(key), meter), overpass: queryOverpass } : null;

  // The results page is the web app (start file); this process doesn't serve it,
  // so it can never stand in the way of a newer version of the app.
  const server = createMcpServer({ store, images, meter, deps, webUrl: `http://localhost:${port}` });
  await server.connect(new StdioServerTransport());
}
