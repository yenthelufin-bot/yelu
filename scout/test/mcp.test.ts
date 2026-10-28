import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, createScoutTools, type ScoutContext } from "../src/mcp.ts";
import { ImageCache } from "../src/server.ts";
import { SearchStore } from "../src/store.ts";
import { FreeLimitError, meteredMaps, UsageMeter } from "../src/usage.ts";
import { fakeDeps } from "./helpers.ts";

let dataDir = "";
before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "scout-mcp-"));
});
after(async () => {
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

function context(limits?: ConstructorParameters<typeof UsageMeter>[1]): ScoutContext {
  const dir = path.join(dataDir, String(Math.random()).slice(2));
  const meter = new UsageMeter(dir, limits);
  const { deps } = fakeDeps();
  return {
    store: new SearchStore(dir),
    images: new ImageCache(),
    meter,
    deps: { maps: meteredMaps(deps.maps, meter), overpass: deps.overpass },
    webUrl: "http://localhost:4173",
  };
}

const assessment = (spot_id: string, score: number) => ({
  spot_id,
  usable: true,
  score,
  type_match: "industrieel",
  color_score: null,
  palette: [{ hex: "#8c5a3c", name: "roest" }],
  best_view_index: 1,
  summary: "Silo aan het kanaal.",
  strengths: ["hoog"],
  concerns: [],
  tags: ["silo"],
});

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.flatMap((c) => (c.type === "text" ? [c.text!] : [])).join("\n");

test("the free limit blocks calls instead of going over", () => {
  const meter = new UsageMeter(path.join(dataDir, "meter"), { limits: { streetViewImage: 3 } });
  meter.take("streetViewImage", 2);
  meter.take("streetViewImage");
  assert.throws(() => meter.take("streetViewImage"), FreeLimitError);
  assert.equal(meter.remaining("streetViewImage"), 0);
  assert.equal(meter.report().items.find((i) => i.sku === "streetViewImage")!.used, 3);
});

test("the counters start again in a new month", () => {
  let now = new Date("2026-10-15T12:00:00Z");
  const meter = new UsageMeter(path.join(dataDir, "month"), { limits: { geocode: 1 }, now: () => now });
  meter.take("geocode");
  assert.throws(() => meter.take("geocode"));
  now = new Date("2026-11-02T12:00:00Z");
  meter.take("geocode");
});

test("with enforcement off, usage is counted but never blocked", () => {
  const meter = new UsageMeter(path.join(dataDir, "off"), { limits: { geocode: 1 }, enforced: false });
  meter.take("geocode");
  meter.take("geocode");
  assert.equal(meter.report().items.find((i) => i.sku === "geocode")!.used, 2);
});

test("Claude flow: search, view, assess, finish", async () => {
  const ctx = context();
  const tools = createScoutTools(ctx);

  const started = await tools.search({ place: "Gent", radius_km: 5, location_types: ["industrieel"], color_presets: ["industrieel"], max_spots: 5 });
  const intro = textOf(started);
  assert.ok(!("isError" in started), intro);
  const searchId = intro.match(/Zoektocht ([0-9a-f-]{36})/)![1];
  assert.match(intro, /SCORING GUIDE/);
  assert.match(intro, /rust, weathered steel/);
  assert.match(intro, /^s5 · /m);

  const viewed = await tools.view({ search_id: searchId, spot_ids: ["s1", "s2", "s3", "s4"] });
  const images = viewed.content.filter((c) => c.type === "image");
  assert.ok(images.length >= 9 && images.length <= 12, `got ${images.length}`); // 3 spots, 3 or 4 views each
  assert.equal(ctx.meter.report().items.find((i) => i.sku === "streetViewImage")!.used, images.length);
  assert.ok(ctx.images.get(searchId, "s1", 0));

  const saved = await tools.save({
    search_id: searchId,
    assessments: [assessment("s1", 88), assessment("s2", 52), { ...assessment("s3", 0), usable: false }],
  });
  assert.match(textOf(saved), /3 van 5 plekken beoordeeld\. Nog te bekijken: s4, s5/);

  const stored = (await ctx.store.get(searchId))!;
  assert.equal(stored.engine, "claude-app");
  assert.deepEqual(
    stored.results.map((r) => [r.id, r.score]),
    [
      ["s1", 88],
      ["s2", 52],
    ],
  );
  assert.equal(stored.results[0].bestHeading, stored.spots![0].headings[1]);
  assert.ok(stored.results[0].lightAdvice);

  const finished = textOf(await tools.finish({ search_id: searchId }));
  assert.match(finished, /88 · /);
  assert.match(finished, /2 plekken niet bekeken/);
  assert.match(finished, new RegExp(`localhost:4173/#zoektocht/${searchId}`));
  assert.equal((await ctx.store.get(searchId))!.status, "done");
});

test("a search is shrunk to fit the free images left this month", async () => {
  const ctx = context({ limits: { streetViewImage: 12 } });
  const out = textOf(await createScoutTools(ctx).search({ place: "Gent", radius_km: 5, location_types: ["industrieel"], max_spots: 20 }));
  assert.match(out, /3 plekken met Street View/);

  const empty = context({ limits: { streetViewImage: 2 } });
  const refused = await createScoutTools(empty).search({ place: "Gent", radius_km: 5, location_types: ["industrieel"] });
  assert.ok("isError" in refused);
  assert.match(textOf(refused), /gratis Street View-beelden van deze maand zijn op/);
});

test("over the MCP protocol: tools are listed and callable", async () => {
  const server = createMcpServer(context());
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  assert.match(client.getInstructions() ?? "", /scout_view_spots/);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["scout_finish", "scout_save_assessments", "scout_search", "scout_usage", "scout_view_spots"]);

  const bad = await client.callTool({ name: "scout_search", arguments: { place: "Gent", radius_km: 5, location_types: ["onbestaand"] } });
  assert.equal(bad.isError, true);

  const ok = await client.callTool({ name: "scout_search", arguments: { place: "Gent", radius_km: 5, location_types: ["water"], max_spots: 5 } });
  assert.notEqual(ok.isError, true);
  const id = textOf(ok as any).match(/Zoektocht ([0-9a-f-]{36})/)![1];
  const view = await client.callTool({ name: "scout_view_spots", arguments: { search_id: id, spot_ids: ["s1"] } });
  assert.ok((view.content as any[]).some((c) => c.type === "image" && c.mimeType === "image/jpeg"));
  await client.close();
});
