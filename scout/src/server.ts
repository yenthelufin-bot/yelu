import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toCsv, toGpx, toKml } from "./export.ts";
import { GoogleMaps } from "./google.ts";
import { queryOverpass } from "./overpass.ts";
import { estimateUsage, type PipelineDeps, runSearch, type SearchEvent } from "./pipeline.ts";
import { COLOR_PRESETS, EXTRA_FILTERS, LOCATION_TYPES, SHOOT_TYPES } from "./presets.ts";
import { ReferenceStore, SearchStore, ShareStore } from "./store.ts";
import { type ContactMaps, lookupContact } from "./contact.ts";
import { Tunnel } from "./tunnel.ts";
import { randomBytes } from "node:crypto";
import { ResultPatchSchema, type SavedSearch, type ScoredLocation, type SearchRequest, SearchRequestSchema, type Share } from "./types.ts";
import { meteredContactMaps, meteredMaps, UsageMeter } from "./usage.ts";
import { z } from "zod";
import { checkKey, claudeConfigPath, cleanKey, isClaudeLinked, linkClaudeDesktop, looksLikeGoogleKey, MCP_SCRIPT, setEnvValue } from "../setup.mjs";
import { LocationJudge, type ViewImage } from "./vision.ts";
import { DEFAULT_GEMINI_MODEL, GEMINI_MODELS, GeminiJudge } from "./gemini.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
export const VERSION: string = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).version;

interface Running {
  controller: AbortController;
  listeners: Set<ServerResponse>;
  /** The live search object, ahead of what has been written to disk. */
  search: SavedSearch | null;
}

/**
 * Street View images of the current session, kept in memory only: Google's
 * terms don't allow storing them. Saved searches show the live Street View
 * embed instead.
 */
export class ImageCache {
  private readonly images = new Map<string, Buffer>();
  private readonly maxImages = 1500;
  put(searchId: string, resultId: string, views: ViewImage[]) {
    views.forEach((v, i) => this.images.set(`${searchId}/${resultId}/${i}`, v.jpeg));
    while (this.images.size > this.maxImages) this.images.delete(this.images.keys().next().value!);
  }
  putOne(searchId: string, resultId: string, index: number, jpeg: Buffer) {
    this.images.set(`${searchId}/${resultId}/${index}`, jpeg);
    while (this.images.size > this.maxImages) this.images.delete(this.images.keys().next().value!);
  }
  get(searchId: string, resultId: string, index: number) {
    return this.images.get(`${searchId}/${resultId}/${index}`);
  }
}

export interface AppOptions {
  dataDir: string;
  googleKey: string | undefined;
  hasAnthropicCredentials: boolean;
  /** Free assessments in the browser, with Google Gemini's free tier. */
  geminiKey?: string;
  geminiModel?: string;
  /** Overrides the real API clients; used by tests. */
  deps?: Omit<PipelineDeps, "onImages" | "onUpdate">;
  /** Shared with the Claude link when it hosts this app in the same process. */
  store?: SearchStore;
  images?: ImageCache;
  meter?: UsageMeter;
  /** Where the settings screen saves the Google key and links the Claude app; overridable for tests. */
  envFile?: string;
  claudeConfigFile?: string;
  checkGoogleKey?: (key: string) => Promise<string[]>;
  /** Returns null when the key and model work, else what is wrong. */
  checkGemini?: (key: string, model: string) => Promise<string | null>;
  /** Overrides the owner/contact lookups and the internet link; used by tests. */
  contactMaps?: ContactMaps;
  tunnel?: Pick<Tunnel, "url" | "findBinary" | "install" | "start" | "stop">;
}

const VoteSchema = z.object({
  resultId: z.string().min(1).max(64),
  vote: z.enum(["up", "down"]),
  name: z.string().trim().min(1, "Vul je naam in").max(60),
  comment: z.string().trim().max(500).default(""),
});

const ShareCreateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  message: z.string().trim().max(1000).default(""),
  resultIds: z.array(z.string().max(64)).min(1, "Kies minstens één locatie").max(60),
});

/** What someone with a share link may see: no notes, contacts or internal details. */
function publicResult(r: ScoredLocation) {
  return {
    id: r.id,
    name: r.name,
    summary: r.summary,
    strengths: r.strengths,
    concerns: r.concerns,
    tags: r.tags,
    palette: r.palette,
    lightAdvice: r.lightAdvice,
    access: r.access,
    panoId: r.panoId,
    bestHeading: r.bestHeading,
    location: r.panoLocation,
  };
}

/**
 * The settings endpoints write files on this computer, so only the app's own
 * page may call the API: the Host must be this machine (against DNS
 * rebinding) and a write must come from the same origin (against other
 * websites posting to localhost).
 */
function isTrustedRequest(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) return false;
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.origin;
  return origin === undefined || origin === `http://${host}`;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, maxBytes = 100_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "Verzoek te groot");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Ongeldige JSON");
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createApp(options: AppOptions): http.Server {
  const store = options.store ?? new SearchStore(options.dataDir);
  const images = options.images ?? new ImageCache();
  const meter = options.meter ?? new UsageMeter(options.dataDir);
  const running = new Map<string, Running>();
  const references = new ReferenceStore(options.dataDir);
  const shares = new ShareStore(options.dataDir);
  const tunnel = options.tunnel ?? new Tunnel(path.join(ROOT, "bin"));
  // Can change at runtime through the settings screen.
  let googleKey = options.googleKey;
  const envFile = options.envFile ?? path.join(ROOT, ".env");
  const claudeConfigFile = options.claudeConfigFile ?? claudeConfigPath();
  const checkGoogleKey = options.checkGoogleKey ?? ((key: string) => checkKey(key));
  let geminiKey = options.geminiKey;
  let geminiModel = options.geminiModel || DEFAULT_GEMINI_MODEL;
  const checkGemini = options.checkGemini ?? ((key: string, model: string) => new GeminiJudge({ apiKey: key, model, minIntervalMs: 0 }).test());
  /** Who assesses the images of a search started on this page; Gemini first because it is free. */
  const engine = (): "gemini" | "api" | "claude-app" =>
    options.deps || geminiKey ? "gemini" : options.hasAnthropicCredentials ? "api" : "claude-app";

  const googleMaps = () => {
    if (options.deps) return options.deps.maps;
    if (!googleKey) throw new HttpError(503, "Er is nog geen Google-sleutel. Vul hem in bij Instellingen.");
    return meteredMaps(new GoogleMaps(googleKey), meter);
  };

  const contactMaps = (): ContactMaps => {
    if (options.contactMaps) return options.contactMaps;
    if (!googleKey) throw new HttpError(503, "Er is nog geen Google-sleutel. Vul hem in bij Instellingen.");
    return meteredContactMaps(new GoogleMaps(googleKey), meter);
  };

  const buildDeps = (): Omit<PipelineDeps, "onImages" | "onUpdate"> => {
    const loadReference = (refId: string) => references.load(refId);
    if (options.deps) return { loadReference, ...options.deps };
    const maps = googleMaps();
    if (geminiKey) return { maps, judge: new GeminiJudge({ apiKey: geminiKey, model: geminiModel }), overpass: queryOverpass, loadReference };
    if (options.hasAnthropicCredentials) return { maps, judge: new LocationJudge(), overpass: queryOverpass, loadReference };
    throw new HttpError(503, "Er is nog geen Gemini-sleutel. Vul hem in bij Instellingen.");
  };

  /** Starts a search in the background and returns its id. */
  const startSearch = (request: SearchRequest): string => {
    const deps = buildDeps();
    const searchId = randomUUID();
    const entry: Running = { controller: new AbortController(), listeners: new Set(), search: null };
    running.set(searchId, entry);
    void runSearch(
      request,
      {
        ...deps,
        onImages: (sid, rid, views) => images.put(sid, rid, views),
        onUpdate: (search) => {
          entry.search = search;
          store.save(search).catch((err) => console.error("Opslaan mislukt:", err));
        },
      },
      (event) => broadcast(searchId, event),
      entry.controller.signal,
      searchId,
    )
      // Only forget the live object once the final state is on disk.
      .then((search) => store.save(search))
      .catch((err) => console.error("Opslaan mislukt:", err))
      .finally(() => {
        for (const listener of entry.listeners) listener.end();
        running.delete(searchId);
      });
    return searchId;
  };

  /**
   * A Street View image of a result: from memory when it was looked at this
   * session, otherwise fetched again (within the free amount) and kept in memory.
   */
  const resultImage = async (searchId: string, result: ScoredLocation, index: number): Promise<Buffer> => {
    const cached = images.get(searchId, result.id, index);
    if (cached) return cached;
    const heading = result.headings[index];
    if (heading === undefined) throw new HttpError(404, "Beeld niet gevonden");
    const jpeg = await googleMaps().streetViewImage(result.panoId, heading);
    images.putOne(searchId, result.id, index, jpeg);
    return jpeg;
  };
  const bestIndex = (r: ScoredLocation) => Math.max(0, r.headings.indexOf(r.bestHeading));

  const sendJpeg = (res: ServerResponse, jpeg: Buffer) => {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" });
    res.end(jpeg);
  };

  const broadcast = (id: string, event: SearchEvent) => {
    for (const res of running.get(id)?.listeners ?? []) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const loadSearch = async (id: string): Promise<SavedSearch> => {
    const search = running.get(id)?.search ?? (await store.get(id));
    if (!search) throw new HttpError(404, "Zoekopdracht niet gevonden");
    return search;
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    // Share pages: the only part reachable from outside this computer (through the internet link).
    if (parts[0] === "s" && parts[1] && method === "GET") {
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
      res.end(await readFile(path.join(PUBLIC_DIR, "share.html")));
      return;
    }
    if (parts[0] === "api" && parts[1] === "public" && parts[2] === "shares" && parts[3]) {
      const share = await shares.get(parts[3]).catch(() => null);
      if (!share) throw new HttpError(404, "Deze link bestaat niet (meer).");
      const search = await loadSearch(share.searchId).catch(() => null);
      if (!search) throw new HttpError(404, "Deze selectie bestaat niet meer.");
      const shared = share.resultIds.map((rid) => search.results.find((r) => r.id === rid)).filter((r) => r !== undefined);

      // GET /api/public/shares/:token
      if (!parts[4] && method === "GET") {
        sendJson(res, 200, {
          title: share.title,
          message: share.message,
          createdAt: share.createdAt,
          embedKey: googleKey ?? null,
          results: shared.map((r) => ({ ...publicResult(r), votes: share.votes[r.id] ?? [] })),
        });
        return;
      }
      // POST /api/public/shares/:token/votes
      if (parts[4] === "votes" && method === "POST") {
        const vote = VoteSchema.safeParse(await readJson(req, 5_000));
        if (!vote.success) throw new HttpError(400, vote.error.issues[0].message);
        if (!share.resultIds.includes(vote.data.resultId)) throw new HttpError(404, "Locatie niet gevonden");
        const list = (share.votes[vote.data.resultId] ??= []);
        // One vote per name per spot; voting again changes it.
        const existing = list.findIndex((v) => v.name.toLowerCase() === vote.data.name.toLowerCase());
        const entry = { name: vote.data.name, vote: vote.data.vote, comment: vote.data.comment, at: new Date().toISOString() };
        if (existing >= 0) list[existing] = entry;
        else if (list.length < 200) list.push(entry);
        else throw new HttpError(429, "Te veel stemmen op deze locatie");
        await shares.save(share);
        sendJson(res, 200, { votes: list });
        return;
      }
      // GET /api/public/shares/:token/image/:rid
      if (parts[4] === "image" && parts[5] && method === "GET") {
        const result = shared.find((r) => r.id === parts[5]);
        if (!result) throw new HttpError(404, "Beeld niet gevonden");
        sendJpeg(res, await resultImage(search.id, result, bestIndex(result)));
        return;
      }
      throw new HttpError(404, "Niet gevonden");
    }

    if (parts[0] === "api" && !isTrustedRequest(req)) throw new HttpError(403, "Alleen toegankelijk vanaf deze computer");

    if (parts[0] !== "api") {
      const file = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, "Niet gevonden");
      const body = await readFile(file).catch(() => null);
      if (!body) throw new HttpError(404, "Niet gevonden");
      // Always fetch fresh, so an update shows up without clearing the browser cache.
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(body);
      return;
    }

    // GET /api/config
    if (parts[1] === "config" && method === "GET") {
      sendJson(res, 200, {
        version: VERSION,
        ready: Boolean(options.deps || (googleKey && engine() !== "claude-app")),
        engine: engine(),
        hasGoogleKey: Boolean(googleKey),
        hasGeminiKey: Boolean(geminiKey),
        geminiModel,
        geminiModels: GEMINI_MODELS,
        claudeLinked: isClaudeLinked(claudeConfigFile),
        hasAnthropicKey: options.hasAnthropicCredentials,
        // For the Street View embed in the browser. The server only listens on
        // localhost by default; restrict the key in Google Cloud as well.
        embedKey: googleKey ?? null,
        locationTypes: LOCATION_TYPES.map(({ id, label }) => ({ id, label })),
        colorPresets: COLOR_PRESETS.map(({ id, label, swatches }) => ({ id, label, swatches })),
        extraFilters: EXTRA_FILTERS,
        shootTypes: SHOOT_TYPES,
      });
      return;
    }

    // GET /api/geocode?q=… (for the zone preview on the map)
    if (parts[1] === "geocode" && method === "GET") {
      const q = url.searchParams.get("q")?.trim();
      if (!q) throw new HttpError(400, "Geen plaats opgegeven");
      const maps = googleMaps();
      try {
        sendJson(res, 200, await maps.geocode(q));
      } catch (err) {
        throw new HttpError(404, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // POST /api/estimate
    if (parts[1] === "estimate" && method === "POST") {
      const parsed = SearchRequestSchema.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
      sendJson(res, 200, { usage: estimateUsage(parsed.data), free: meter.report() });
      return;
    }

    // POST /api/settings/google-key: test the key with Google, then save it in .env
    if (parts[1] === "settings" && parts[2] === "google-key" && method === "POST") {
      const body = (await readJson(req)) as { key?: unknown };
      const key = cleanKey(body.key);
      if (!key) throw new HttpError(400, "Plak eerst je sleutel in het veld.");
      if (!looksLikeGoogleKey(key)) throw new HttpError(400, "Die sleutel bevat spaties, aanhalingstekens, # of \\, en dat hoort niet in een sleutel. Kopieer hem opnieuw.");
      const problems = await checkGoogleKey(key);
      if (problems.length) {
        sendJson(res, 200, { saved: false, problems });
        return;
      }
      setEnvValue(envFile, "GOOGLE_MAPS_API_KEY", key);
      googleKey = key;
      process.env.GOOGLE_MAPS_API_KEY = key;
      sendJson(res, 200, { saved: true, problems: [] });
      return;
    }

    // POST /api/settings/gemini: test the Gemini key and model, then save them in .env
    if (parts[1] === "settings" && parts[2] === "gemini" && method === "POST") {
      const body = (await readJson(req)) as { key?: unknown; model?: unknown };
      const key = cleanKey(body.key) || geminiKey || "";
      const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : geminiModel;
      if (!key) throw new HttpError(400, "Plak eerst je Gemini-sleutel in het veld.");
      if (!looksLikeGoogleKey(key)) throw new HttpError(400, "Die sleutel bevat spaties, aanhalingstekens, # of \\, en dat hoort niet in een sleutel. Kopieer hem opnieuw.");
      if (!/^[a-z0-9.-]{3,60}$/.test(model)) throw new HttpError(400, "Ongeldige modelnaam.");
      const problem = await checkGemini(key, model);
      if (problem) {
        sendJson(res, 200, { saved: false, problems: [problem] });
        return;
      }
      setEnvValue(envFile, "GEMINI_API_KEY", key);
      setEnvValue(envFile, "GEMINI_MODEL", model);
      geminiKey = key;
      geminiModel = model;
      process.env.GEMINI_API_KEY = key;
      process.env.GEMINI_MODEL = model;
      sendJson(res, 200, { saved: true, problems: [] });
      return;
    }

    // POST /api/settings/link-claude: add Location Scout to the Claude desktop app's config
    if (parts[1] === "settings" && parts[2] === "link-claude" && method === "POST") {
      try {
        const result = linkClaudeDesktop(claudeConfigFile, process.execPath, MCP_SCRIPT);
        sendJson(res, 200, { result, configFile: claudeConfigFile });
      } catch (err) {
        throw new HttpError(500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // GET /api/usage: how much of Google's free monthly amount is used
    if (parts[1] === "usage" && method === "GET") {
      sendJson(res, 200, meter.report());
      return;
    }

    // POST /api/references: upload a reference photo (JPEG, base64)
    if (parts[1] === "references" && !parts[2] && method === "POST") {
      const body = (await readJson(req, 8_000_000)) as { image?: unknown };
      const data = typeof body.image === "string" ? body.image.replace(/^data:image\/jpeg;base64,/, "") : "";
      const jpeg = Buffer.from(data, "base64");
      if (jpeg.length < 1000 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new HttpError(400, "Dat is geen JPEG-foto.");
      sendJson(res, 201, { id: await references.save(jpeg) });
      return;
    }
    // GET /api/references/:id
    if (parts[1] === "references" && parts[2] && method === "GET") {
      const jpeg = await references.load(parts[2]).catch(() => null);
      if (!jpeg) throw new HttpError(404, "Foto niet gevonden");
      sendJpeg(res, jpeg);
      return;
    }

    // /api/tunnel: the internet link for share pages
    if (parts[1] === "tunnel") {
      if (method === "GET") {
        sendJson(res, 200, { url: tunnel.url, installed: Boolean(await tunnel.findBinary()) });
        return;
      }
      if (method === "POST") {
        const body = (await readJson(req)) as { install?: unknown };
        if (!(await tunnel.findBinary())) {
          if (body.install !== true) throw new HttpError(409, "cloudflared is nog niet geïnstalleerd.");
          await tunnel.install().catch((err) => {
            throw new HttpError(502, `cloudflared downloaden mislukt: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        const port = req.socket.localPort ?? 4173;
        const publicUrl = await tunnel.start(port).catch((err) => {
          throw new HttpError(502, err instanceof Error ? err.message : String(err));
        });
        sendJson(res, 200, { url: publicUrl });
        return;
      }
      if (method === "DELETE") {
        tunnel.stop();
        sendJson(res, 200, { url: null });
        return;
      }
    }

    if (parts[1] !== "searches") throw new HttpError(404, "Niet gevonden");
    const id = parts[2];

    // GET /api/searches, POST /api/searches
    if (!id) {
      if (method === "GET") {
        const all = await store.list();
        sendJson(
          res,
          200,
          all.map(({ results, ...rest }) => ({
            ...rest,
            resultCount: results.length,
            favoriteCount: results.filter((r) => r.rating === "favorite").length,
            topScore: results[0]?.score ?? null,
            running: running.has(rest.id),
          })),
        );
        return;
      }
      if (method === "POST") {
        const parsed = SearchRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
        sendJson(res, 201, { id: startSearch(parsed.data) });
        return;
      }
    }

    // GET /api/searches/:id/events (server-sent events)
    if (parts[3] === "events" && method === "GET") {
      const search = await loadSearch(id);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "snapshot", search, running: running.has(id) })}\n\n`);
      const entry = running.get(id);
      if (!entry) {
        res.end();
        return;
      }
      entry.listeners.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(ping);
        entry.listeners.delete(res);
      });
      return;
    }

    // POST /api/searches/:id/cancel
    if (parts[3] === "cancel" && method === "POST") {
      running.get(id)?.controller.abort();
      sendJson(res, 200, { ok: true });
      return;
    }

    // GET /api/searches/:id/export.{gpx,kml,csv}
    const exportMatch = parts[3]?.match(/^export\.(gpx|kml|csv)$/);
    if (exportMatch && method === "GET") {
      const search = await loadSearch(id);
      const minScore = Number(url.searchParams.get("minScore") ?? 0);
      const favoritesOnly = url.searchParams.get("favorites") === "1";
      const selection = search.results.filter(
        (r) => r.rating !== "rejected" && r.score >= minScore && (!favoritesOnly || r.rating === "favorite"),
      );
      const title = `Locaties ${search.request.place}`;
      const format = exportMatch[1];
      const [body, type] =
        format === "gpx"
          ? [toGpx(title, selection), "application/gpx+xml"]
          : format === "kml"
            ? [toKml(title, selection), "application/vnd.google-earth.kml+xml"]
            : [toCsv(selection), "text/csv; charset=utf-8"];
      const filename = `locaties-${search.request.place.replace(/[^\w-]+/g, "_")}.${format}`;
      res.writeHead(200, { "Content-Type": type, "Content-Disposition": `attachment; filename="${filename}"` });
      res.end(body);
      return;
    }

    // GET /api/searches/:id/results/:rid/image/:index
    if (parts[3] === "results" && parts[5] === "image" && method === "GET") {
      const search = await loadSearch(id);
      const result = search.results.find((r) => r.id === parts[4]);
      if (!result) throw new HttpError(404, "Resultaat niet gevonden");
      sendJpeg(res, await resultImage(id, result, Number(parts[6])));
      return;
    }

    // POST /api/searches/:id/results/:rid/more: "more like this" around a result
    if (parts[3] === "results" && parts[5] === "more" && method === "POST") {
      const search = await loadSearch(id);
      const result = search.results.find((r) => r.id === parts[4]);
      if (!result) throw new HttpError(404, "Resultaat niet gevonden");
      const body = (await readJson(req)) as { radiusKm?: unknown };
      const radiusKm = typeof body.radiusKm === "number" && body.radiusKm >= 0.5 && body.radiusKm <= 50 ? body.radiusKm : 3;
      const referenceId = await references.save(await resultImage(id, result, bestIndex(result)));
      const original = search.request;
      const request = SearchRequestSchema.parse({
        ...original,
        mode: "similar",
        referenceIds: [referenceId],
        place: `rond ${result.name}`,
        center: result.panoLocation,
        radiusKm,
        extraQueries: [],
        description: original.mode === "exact" ? "" : original.description.split("\n")[0],
        maxCandidates: Math.min(original.maxCandidates, 15),
      });
      sendJson(res, 201, { id: startSearch(request) });
      return;
    }

    // POST /api/searches/:id/results/:rid/contact: who to ask for permission
    if (parts[3] === "results" && parts[5] === "contact" && method === "POST") {
      const search = await loadSearch(id);
      const result = search.results.find((r) => r.id === parts[4]);
      if (!result) throw new HttpError(404, "Resultaat niet gevonden");
      try {
        result.contact = await lookupContact(result, contactMaps());
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, `Contact opzoeken mislukt: ${err instanceof Error ? err.message : String(err)}`);
      }
      await store.save(search);
      sendJson(res, 200, result);
      return;
    }

    // GET/POST /api/searches/:id/shares, DELETE /api/searches/:id/shares/:token
    if (parts[3] === "shares") {
      const search = await loadSearch(id);
      if (method === "GET" && !parts[4]) {
        sendJson(res, 200, await shares.forSearch(search.id));
        return;
      }
      if (method === "POST" && !parts[4]) {
        const body = ShareCreateSchema.safeParse(await readJson(req));
        if (!body.success) throw new HttpError(400, body.error.issues[0].message);
        const resultIds = body.data.resultIds.filter((rid) => search.results.some((r) => r.id === rid));
        if (!resultIds.length) throw new HttpError(400, "Kies minstens één locatie");
        const share: Share = {
          token: randomBytes(16).toString("base64url"),
          searchId: search.id,
          title: body.data.title,
          message: body.data.message,
          resultIds,
          createdAt: new Date().toISOString(),
          votes: {},
        };
        await shares.save(share);
        sendJson(res, 201, share);
        return;
      }
      if (method === "DELETE" && parts[4]) {
        const share = await shares.get(parts[4]);
        if (share?.searchId !== search.id) throw new HttpError(404, "Link niet gevonden");
        await shares.delete(parts[4]);
        sendJson(res, 200, { ok: true });
        return;
      }
    }

    // PATCH /api/searches/:id/results/:rid
    if (parts[3] === "results" && parts[4] && !parts[5] && method === "PATCH") {
      // A running search returns its live object here, so the rating also
      // survives the pipeline's own later saves.
      const patch = ResultPatchSchema.safeParse(await readJson(req));
      if (!patch.success) throw new HttpError(400, patch.error.issues[0].message);
      const search = await loadSearch(id);
      const result = search.results.find((r) => r.id === parts[4]);
      if (!result) throw new HttpError(404, "Resultaat niet gevonden");
      if (patch.data.rating !== undefined) result.rating = patch.data.rating;
      if (patch.data.note !== undefined) result.note = patch.data.note;
      await store.save(search);
      sendJson(res, 200, result);
      return;
    }

    // GET /api/searches/:id, DELETE /api/searches/:id
    if (!parts[3]) {
      if (method === "GET") {
        sendJson(res, 200, { ...(await loadSearch(id)), running: running.has(id) });
        return;
      }
      if (method === "DELETE") {
        running.get(id)?.controller.abort();
        await store.delete(id);
        sendJson(res, 200, { ok: true });
        return;
      }
    }
    throw new HttpError(404, "Niet gevonden");
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
  });
}

export function loadEnv() {
  for (const file of [path.join(ROOT, ".env"), path.join(ROOT, "..", ".env")]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // No .env file there; environment variables alone are fine.
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  loadEnv();
  const port = Number(process.env.PORT ?? 4173);
  const host = process.env.HOST ?? "127.0.0.1";
  const dataDir = process.env.SCOUT_DATA_DIR ?? path.join(ROOT, "data");
  const app = createApp({
    dataDir,
    googleKey: process.env.GOOGLE_MAPS_API_KEY,
    hasAnthropicCredentials: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    geminiKey: process.env.GEMINI_API_KEY || undefined,
    geminiModel: process.env.GEMINI_MODEL || undefined,
    meter: new UsageMeter(dataDir, { enforced: process.env.SCOUT_FREE_LIMITS !== "off" }),
  });
  const openBrowser = process.argv.includes("--open");
  start(app, port, host, openBrowser);
}

/** Opens a URL in the default browser; best effort. */
function openInBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  } catch {
    // No browser to open; the address is printed anyway.
  }
}

/** The version of Location Scout answering on a port; "?" for an older version or another program. */
async function versionOn(port: number): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(2_000) });
    const body = (await res.json()) as { version?: string };
    return body.version ?? "?";
  } catch {
    return "?";
  }
}

/**
 * Listens on the first free port from `port`. If this same version already
 * runs, opens that instead. Another program or an older version (for
 * example one started by the Claude app) never blocks the new one.
 */
function start(app: http.Server, firstPort: number, host: string, openBrowser: boolean) {
  let port = firstPort;
  app.on("error", async (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE" || port >= firstPort + 10) throw err;
    const running = await versionOn(port);
    if (running === VERSION) {
      console.log(`Frame Finder draait al op http://127.0.0.1:${port}`);
      if (openBrowser) openInBrowser(`http://127.0.0.1:${port}`);
      process.exit(0);
    }
    console.log(`Poort ${port} is bezet${running === "?" ? "" : ` door een oudere versie (${running})`}; ik probeer ${port + 1}.`);
    port++;
    app.listen(port, host);
  });
  // One listener for whichever attempt succeeds.
  app.once("listening", () => {
    // The exact address we listen on: "localhost" can resolve to IPv6 first on some systems.
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    console.log(`Frame Finder ${VERSION} draait op ${url}`);
    if (!process.env.GOOGLE_MAPS_API_KEY || !process.env.GEMINI_API_KEY) {
      console.log("Nog niet alles ingesteld: de app opent op Instellingen.");
    }
    if (openBrowser) openInBrowser(url);
  });
  app.listen(port, host);
}
