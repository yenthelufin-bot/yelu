import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toCsv, toGpx, toKml } from "./export.ts";
import { GoogleMaps } from "./google.ts";
import { queryOverpass } from "./overpass.ts";
import { estimateMaxCost, type PipelineDeps, runSearch, type SearchEvent } from "./pipeline.ts";
import { COLOR_PRESETS, EXTRA_FILTERS, LOCATION_TYPES, SHOOT_TYPES } from "./presets.ts";
import { SearchStore } from "./store.ts";
import { ResultPatchSchema, type SavedSearch, SearchRequestSchema } from "./types.ts";
import { LocationJudge, type ViewImage } from "./vision.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const PUBLIC_DIR = path.join(ROOT, "public");

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
class ImageCache {
  private readonly images = new Map<string, Buffer>();
  private readonly maxImages = 1500;
  put(searchId: string, resultId: string, views: ViewImage[]) {
    views.forEach((v, i) => this.images.set(`${searchId}/${resultId}/${i}`, v.jpeg));
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
  /** Overrides the real API clients; used by tests. */
  deps?: Omit<PipelineDeps, "onImages" | "onUpdate">;
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new HttpError(413, "Verzoek te groot");
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
  const store = new SearchStore(options.dataDir);
  const images = new ImageCache();
  const running = new Map<string, Running>();

  const buildDeps = (): Omit<PipelineDeps, "onImages" | "onUpdate"> => {
    if (options.deps) return options.deps;
    if (!options.googleKey) throw new HttpError(503, "GOOGLE_MAPS_API_KEY ontbreekt. Zie README.");
    if (!options.hasAnthropicCredentials) throw new HttpError(503, "ANTHROPIC_API_KEY ontbreekt. Zie README.");
    return { maps: new GoogleMaps(options.googleKey), judge: new LocationJudge(), overpass: queryOverpass };
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

    if (parts[0] !== "api") {
      const file = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : path.normalize(url.pathname));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, "Niet gevonden");
      const body = await readFile(file).catch(() => null);
      if (!body) throw new HttpError(404, "Niet gevonden");
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
      return;
    }

    // GET /api/config
    if (parts[1] === "config" && method === "GET") {
      sendJson(res, 200, {
        ready: Boolean(options.deps || (options.googleKey && options.hasAnthropicCredentials)),
        hasGoogleKey: Boolean(options.googleKey),
        hasAnthropicKey: options.hasAnthropicCredentials,
        // For the Street View embed in the browser. The server only listens on
        // localhost by default; restrict the key in Google Cloud as well.
        embedKey: options.googleKey ?? null,
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
      const maps = options.deps?.maps ?? (options.googleKey ? new GoogleMaps(options.googleKey) : null);
      if (!maps) throw new HttpError(503, "GOOGLE_MAPS_API_KEY ontbreekt. Zie README.");
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
      sendJson(res, 200, { maxUsd: estimateMaxCost(parsed.data) });
      return;
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
        const deps = buildDeps();
        const searchId = randomUUID();
        const entry: Running = { controller: new AbortController(), listeners: new Set(), search: null };
        running.set(searchId, entry);
        void runSearch(
          parsed.data,
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
        sendJson(res, 201, { id: searchId });
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
      const jpeg = images.get(id, parts[4], Number(parts[6]));
      if (!jpeg) throw new HttpError(404, "Beeld niet meer in het geheugen");
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" });
      res.end(jpeg);
      return;
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

function loadEnv() {
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
  const app = createApp({
    dataDir: process.env.SCOUT_DATA_DIR ?? path.join(ROOT, "data"),
    googleKey: process.env.GOOGLE_MAPS_API_KEY,
    hasAnthropicCredentials: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  });
  app.listen(port, host, () => {
    console.log(`Location Scout draait op http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    if (!process.env.GOOGLE_MAPS_API_KEY) console.warn("Let op: GOOGLE_MAPS_API_KEY ontbreekt.");
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) console.warn("Let op: ANTHROPIC_API_KEY ontbreekt.");
  });
}
