import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { lookupContact } from "../src/contact.ts";
import { createApp } from "../src/server.ts";
import type { ScoredLocation } from "../src/types.ts";
import { fakeDeps, GENT } from "./helpers.ts";

let base = "";
let port = 0;
let dir = "";
let close: () => Promise<void>;
const contactCalls: string[] = [];
let tunnelStarted = 0;

// A real (tiny) JPEG: starts with FF D8 and is over 1000 bytes.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 1), Buffer.from([0xff, 0xd9])]);

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "scout-features-"));
  const { deps } = fakeDeps({ scores: [90, 80, 70] });
  deps.judge.analyzeReferences = async () => ({ description: "Silo.", locationTypes: ["industrieel"], colors: [], placesQueries: ["silo"], locationGuesses: [] });
  const app = createApp({
    dataDir: dir,
    googleKey: "AIzaTestKey",
    hasAnthropicCredentials: false,
    geminiKey: "AIzaGemini",
    deps,
    envFile: path.join(dir, ".env"),
    claudeConfigFile: path.join(dir, "claude.json"),
    contactMaps: {
      placeDetails: async (id) => {
        contactCalls.push(`details:${id}`);
        return { name: "Silo NV", address: "Kanaalweg 1, Gent", phone: "+32 9 123 45 67", website: "https://silo.example", mapsUrl: "https://maps.google.com/?cid=1" };
      },
      nearbyPlaces: async () => {
        contactCalls.push("nearby");
        return [{ id: "near-1", name: "Buurman", location: GENT }];
      },
    },
    tunnel: {
      url: null,
      findBinary: async () => "/usr/bin/cloudflared",
      install: async () => "/usr/bin/cloudflared",
      start: async (p: number) => {
        tunnelStarted = p;
        return "https://test-link.trycloudflare.com";
      },
      stop: () => {},
    },
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  port = (app.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  close = () => new Promise((resolve) => app.close(() => resolve()));
});

after(async () => {
  await close();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

const post = (p: string, body?: unknown) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** Starts a search and waits until it is done. */
async function search(body: object): Promise<any> {
  const res = await post("/api/searches", body);
  const created = await res.json();
  assert.equal(res.status, 201, JSON.stringify(created));
  for (let i = 0; i < 100; i++) {
    const s = await fetch(`${base}/api/searches/${created.id}`).then((r) => r.json());
    if (s.status !== "running") return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("search did not finish");
}

/** A request that looks like it came through the internet link. */
function fromOutside(method: string, p: string, body?: object): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: { Host: "test-link.trycloudflare.com", "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test("reference photos: upload, read back, refuse non-JPEG", async () => {
  const bad = await post("/api/references", { image: Buffer.from("not a jpeg").toString("base64") });
  assert.equal(bad.status, 400);
  const { id } = await post("/api/references", { image: JPEG.toString("base64") }).then((r) => r.json());
  const res = await fetch(`${base}/api/references/${id}`);
  const back = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(back, JPEG);
});

test("a search by example photo and 'more like this'", async () => {
  const { id: refId } = await post("/api/references", { image: JPEG.toString("base64") }).then((r) => r.json());
  const s = await search({ mode: "similar", referenceIds: [refId], place: "Gent", radiusKm: 5, maxCandidates: 5 });
  assert.equal(s.status, "done", s.error);
  assert.equal(s.analysis.description, "Silo.");
  assert.ok(s.results.length > 0);

  const best = s.results[0];
  const more = await post(`/api/searches/${s.id}/results/${best.id}/more`, { radiusKm: 2 }).then((r) => r.json());
  const follow = await (async () => {
    for (let i = 0; i < 100; i++) {
      const f = await fetch(`${base}/api/searches/${more.id}`).then((r) => r.json());
      if (f.status !== "running") return f;
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  assert.equal(follow.request.mode, "similar");
  assert.equal(follow.request.radiusKm, 2);
  assert.deepEqual(follow.request.center, best.panoLocation);
  assert.equal(follow.request.referenceIds.length, 1);
  assert.notEqual(follow.request.referenceIds[0], refId, "the spot's own Street View image is the new example");
});

test("contact lookup: Google place first, else nearest business marked as nearby", async () => {
  const s = await search({ place: "Gent", radiusKm: 5, locationTypes: ["industrieel"], maxCandidates: 6 });
  const fromPlaces = s.results.find((r: ScoredLocation) => r.placeId);
  const fromGrid = s.results.find((r: ScoredLocation) => r.source === "grid");
  const a = await post(`/api/searches/${s.id}/results/${fromPlaces.id}/contact`).then((r) => r.json());
  assert.equal(a.contact.match, "exact");
  assert.equal(a.contact.phone, "+32 9 123 45 67");
  const b = await post(`/api/searches/${s.id}/results/${fromGrid.id}/contact`).then((r) => r.json());
  assert.equal(b.contact.match, "nearby");
  assert.deepEqual(contactCalls.slice(-3), [`details:${fromPlaces.placeId}`, "nearby", "details:near-1"]);
  const saved = await fetch(`${base}/api/searches/${s.id}`).then((r) => r.json());
  assert.equal(saved.results.find((r: ScoredLocation) => r.id === fromGrid.id).contact.name, "Silo NV");
});

test("OSM contact details need no Google call", async () => {
  const r = { placeId: undefined, osm: { operator: "Haven Gent", "contact:email": "info@haven.example" }, location: GENT } as unknown as ScoredLocation;
  const contact = await lookupContact(r, {
    placeDetails: async () => assert.fail("no Google call expected"),
    nearbyPlaces: async () => assert.fail("no Google call expected"),
  });
  assert.equal(contact?.name, "Haven Gent");
  assert.equal(contact?.website, "mailto:info@haven.example");
});

test("sharing: link, public page, votes, and nothing else reachable from outside", async () => {
  const s = await search({ place: "Gent", radiusKm: 5, locationTypes: ["industrieel"], maxCandidates: 5 });
  await fetch(`${base}/api/searches/${s.id}/results/${s.results[0].id}`, { method: "PATCH", body: JSON.stringify({ note: "Geheime notitie" }) });
  const ids = s.results.slice(0, 2).map((r: ScoredLocation) => r.id);
  const share = await post(`/api/searches/${s.id}/shares`, { title: "Shoot 14 juni", message: "Wat vinden jullie?", resultIds: ids }).then((r) => r.json());
  assert.match(share.token, /^[A-Za-z0-9_-]{22}$/);

  // The share page and its data work through the internet link...
  const page = await fromOutside("GET", `/s/${share.token}`);
  assert.equal(page.status, 200);
  assert.match(page.body, /share\.js/);
  const data = JSON.parse((await fromOutside("GET", `/api/public/shares/${share.token}`)).body);
  assert.equal(data.title, "Shoot 14 juni");
  assert.equal(data.results.length, 2);
  assert.ok(!JSON.stringify(data).includes("Geheime notitie"), "private notes stay private");
  assert.equal(data.results[0].contact, undefined);

  // ...votes too, one per name, changeable...
  const v1 = await fromOutside("POST", `/api/public/shares/${share.token}/votes`, { resultId: ids[0], vote: "up", name: "Lien", comment: "Top!" });
  assert.equal(v1.status, 200);
  await fromOutside("POST", `/api/public/shares/${share.token}/votes`, { resultId: ids[0], vote: "down", name: "lien", comment: "Toch niet" });
  await fromOutside("POST", `/api/public/shares/${share.token}/votes`, { resultId: ids[0], vote: "up", name: "Model Sam" });
  const noName = await fromOutside("POST", `/api/public/shares/${share.token}/votes`, { resultId: ids[0], vote: "up", name: " " });
  assert.equal(noName.status, 400);
  const otherSpot = await fromOutside("POST", `/api/public/shares/${share.token}/votes`, { resultId: s.results[3].id, vote: "up", name: "X" });
  assert.equal(otherSpot.status, 404, "only spots in the selection");
  const img = await fromOutside("GET", `/api/public/shares/${share.token}/image/${ids[1]}`);
  assert.equal(img.status, 200);

  // ...but the rest of the app does not answer.
  assert.equal((await fromOutside("GET", `/api/searches/${s.id}`)).status, 403);
  assert.equal((await fromOutside("GET", "/api/config")).status, 403);
  assert.equal((await fromOutside("POST", "/api/settings/google-key", { key: "x" })).status, 403);
  assert.equal((await fromOutside("GET", "/api/public/shares/AAAAAAAAAAAAAAAAAAAAAA")).status, 404);

  // The photographer sees the votes.
  const shares = await fetch(`${base}/api/searches/${s.id}/shares`).then((r) => r.json());
  const votes = shares[0].votes[ids[0]];
  assert.deepEqual(
    votes.map((v: { name: string; vote: string }) => `${v.name}:${v.vote}`),
    ["lien:down", "Model Sam:up"],
  );

  // A deleted link stops working.
  assert.equal((await fetch(`${base}/api/searches/${s.id}/shares/${share.token}`, { method: "DELETE" })).status, 200);
  assert.equal((await fromOutside("GET", `/api/public/shares/${share.token}`)).status, 404);
});

test("the internet link starts on the app's own port", async () => {
  const r = await post("/api/tunnel", { install: true }).then((r) => r.json());
  assert.equal(r.url, "https://test-link.trycloudflare.com");
  assert.equal(tunnelStarted, port);
});

test("images of earlier searches are fetched again when not in memory", async () => {
  const s = await search({ place: "Gent", radiusKm: 5, locationTypes: ["industrieel"], maxCandidates: 5 });
  const r = s.results[0];
  const res = await fetch(`${base}/api/searches/${s.id}/results/${r.id}/image/${r.headings.length - 1}`);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal((await fetch(`${base}/api/searches/${s.id}/results/${r.id}/image/99`)).status, 404);
});
