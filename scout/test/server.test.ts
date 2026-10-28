import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { buildOverpassQuery, describeTags } from "../src/overpass.ts";
import { createApp } from "../src/server.ts";
import { fakeDeps } from "./helpers.ts";

let base = "";
let dataDir = "";
let close: () => Promise<void>;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "scout-"));
  const { deps } = fakeDeps({ scores: [85, 40, 65] });
  const app = createApp({ dataDir, googleKey: "test-key", hasAnthropicCredentials: true, deps });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => app.close(() => resolve()));
});

after(async () => {
  await close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

/** Reads server-sent events until the stream ends. */
async function readEvents(url: string): Promise<any[]> {
  const res = await fetch(url);
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)));
}

test("serves the frontend and the config", async () => {
  const html = await fetch(`${base}/`).then((r) => r.text());
  assert.match(html, /Location Scout/);
  const config = await fetch(`${base}/api/config`).then((r) => r.json());
  assert.equal(config.ready, true);
  assert.ok(config.locationTypes.length >= 10);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});

test("rejects an invalid search", async () => {
  const res = await fetch(`${base}/api/searches`, { method: "POST", body: JSON.stringify({ place: "", radiusKm: 5, locationTypes: [] }) });
  assert.equal(res.status, 400);
  assert.ok((await res.json()).error);
});

test("full flow: start, stream, rate, export, list, delete", async () => {
  const req = { place: "Gent", radiusKm: 5, locationTypes: ["industrieel"], maxCandidates: 5, minScore: 50 };
  const created = await fetch(`${base}/api/searches`, { method: "POST", body: JSON.stringify(req) });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  const events = await readEvents(`${base}/api/searches/${id}/events`);
  assert.equal(events[0].type, "snapshot");
  // The fake clients are instant, so the search may already be over when we
  // connect; then the snapshot alone carries the final state.
  const final = events[0].running ? events.at(-1) : events[0];
  assert.equal(final.search.status, "done");
  assert.equal(final.search.results.length, 5);

  const search = await fetch(`${base}/api/searches/${id}`).then((r) => r.json());
  const [best, , worst] = search.results;
  const img = await fetch(`${base}/api/searches/${id}/results/${best.id}/image/0`);
  assert.equal(img.headers.get("content-type"), "image/jpeg");

  const patched = await fetch(`${base}/api/searches/${id}/results/${best.id}`, {
    method: "PATCH",
    body: JSON.stringify({ rating: "favorite", note: "toestemming vragen" }),
  }).then((r) => r.json());
  assert.equal(patched.rating, "favorite");
  await fetch(`${base}/api/searches/${id}/results/${worst.id}`, { method: "PATCH", body: JSON.stringify({ rating: "rejected" }) });

  const kml = await fetch(`${base}/api/searches/${id}/export.kml?favorites=1`).then((r) => r.text());
  assert.equal((kml.match(/<Placemark>/g) ?? []).length, 1);
  assert.match(kml, /toestemming vragen/);
  const csv = await fetch(`${base}/api/searches/${id}/export.csv?minScore=0`).then((r) => r.text());
  assert.equal(csv.trim().split("\n").length, 1 + 4, "rejected spot is left out");
  const gpx = await fetch(`${base}/api/searches/${id}/export.gpx`).then((r) => r.text());
  assert.match(gpx, /<gpx/);

  const list = await fetch(`${base}/api/searches`).then((r) => r.json());
  assert.equal(list[0].id, id);
  assert.equal(list[0].favoriteCount, 1);

  assert.equal((await fetch(`${base}/api/searches/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${base}/api/searches/${id}`)).status, 404);
});

test("overpass query and labels", () => {
  const q = buildOverpassQuery(['nwr["landuse"="industrial"]'], { lat: 51, lng: 3.7 }, 5000, 100);
  assert.match(q, /nwr\["landuse"="industrial"\]\(around:5000,51\.000000,3\.700000\);/);
  assert.match(q, /out center tags 100;/);
  assert.equal(describeTags({ man_made: "silo" }), "Silo");
  assert.equal(describeTags({}), "OSM-locatie");
});
