import assert from "node:assert/strict";
import { test } from "node:test";
import { destination } from "../src/geo.ts";
import { GoogleApiError } from "../src/google.ts";
import { estimateUsage, headingsFor, interleave, isFatal, runSearch, type SearchEvent } from "../src/pipeline.ts";
import { fakeDeps, GENT, request, verdict } from "./helpers.ts";

const run = async (deps: Parameters<typeof runSearch>[1], req = request(), signal = new AbortController().signal) => {
  const events: SearchEvent[] = [];
  const search = await runSearch(req, deps, (e) => events.push(e), signal);
  return { search, events };
};

test("a search analyses up to maxCandidates spots and ranks them", async () => {
  const { deps, calls } = fakeDeps({ scores: [55, 90, 70] });
  const { search, events } = await run(deps, request({ maxCandidates: 6 }));
  assert.equal(search.status, "done", search.error ?? "");
  assert.equal(search.analysed, 6);
  assert.equal(calls.assess, 6);
  assert.equal(search.results.length, 6);
  assert.deepEqual(
    search.results.map((r) => r.score),
    [...search.results.map((r) => r.score)].sort((a, b) => b - a),
  );
  assert.ok(search.results.every((r) => r.lightAdvice && r.rating === null && r.note === ""));
  assert.equal(search.cost.streetViewImages, calls.images);
  assert.ok(search.cost.estimatedUsd > 0, "Claude API tokens are priced");
  assert.equal(events.at(-1)?.type, "done");
  // All three sources contribute candidates.
  const sources = new Set(search.results.map((r) => r.source));
  assert.deepEqual([...sources].sort(), ["grid", "osm", "places"]);
});

test("named spots are photographed towards the spot, sampled points all around", () => {
  const spot = destination(GENT, 90, 60);
  const toward = headingsFor({ location: spot, source: "places", name: "x", detail: "" }, GENT);
  assert.equal(toward.length, 3);
  assert.ok(Math.abs(toward[0] - 90) < 1);
  assert.deepEqual(headingsFor({ location: spot, source: "grid", name: "x", detail: "" }, GENT), [0, 90, 180, 270]);
});

test("unusable views and refusals are skipped, not ranked", async () => {
  const { deps } = fakeDeps();
  let n = 0;
  deps.judge.assess = async () => {
    n++;
    if (n === 1) return verdict(90, { usable: false });
    if (n === 2) return { assessment: null, skippedReason: "geweigerd door het model", inputTokens: 10, outputTokens: 0 };
    return verdict(75);
  };
  const { search, events } = await run(deps, request({ maxCandidates: 5 }));
  assert.equal(search.results.length, 3);
  const skipped = events.filter((e) => e.type === "skipped");
  assert.equal(skipped.length, 2);
});

test("old panoramas are filtered out by minPanoYear", async () => {
  const { deps } = fakeDeps();
  const meta = deps.maps.streetViewMeta;
  let i = 0;
  deps.maps.streetViewMeta = async (loc, r) => {
    const m = await meta(loc, r);
    return m && { ...m, date: i++ % 2 ? "2012-04" : "2024-05" };
  };
  const { search } = await run(deps, request({ minPanoYear: 2020, maxCandidates: 5 }));
  assert.ok(search.results.length > 0);
  assert.ok(search.results.every((r) => r.panoDate === "2024-05"));
});

test("a bad Google key stops the search instead of skipping every spot", async () => {
  const { deps, calls } = fakeDeps();
  deps.maps.streetViewImage = async () => {
    throw new GoogleApiError("Street View", "403", "The provided API key is invalid.");
  };
  const { search } = await run(deps);
  assert.equal(search.status, "error");
  assert.match(search.error ?? "", /403/);
  assert.ok(calls.assess === 0);
});

test("an Anthropic authentication error stops the search", async () => {
  const { deps } = fakeDeps();
  deps.judge.assess = async () => {
    throw Object.assign(new Error("invalid x-api-key"), { status: 401 });
  };
  const { search } = await run(deps);
  assert.equal(search.status, "error");
});

test("a failing source does not stop the other sources", async () => {
  const { deps } = fakeDeps();
  deps.overpass = async () => {
    throw new Error("Overpass: 504 Gateway Timeout");
  };
  const { search, events } = await run(deps);
  assert.equal(search.status, "done");
  assert.ok(events.some((e) => e.type === "status" && e.message.includes("OpenStreetMap niet beschikbaar")));
});

test("cancelling stops the search early", async () => {
  const { deps, calls } = fakeDeps();
  const controller = new AbortController();
  const assess = deps.judge.assess;
  deps.judge.assess = async (...args) => {
    controller.abort();
    return assess(...args);
  };
  const { search } = await run(deps, request({ maxCandidates: 30 }), controller.signal);
  assert.equal(search.status, "cancelled");
  assert.ok(calls.assess < 30);
});

test("helpers", () => {
  assert.deepEqual(interleave([["1", "2", "3"], ["a"], ["x", "y"]]), ["1", "a", "x", "2", "y", "3"]);
  assert.ok(isFatal(Object.assign(new Error("x"), { status: 401 })));
  assert.ok(isFatal(new GoogleApiError("Geocoding", "REQUEST_DENIED")));
  assert.ok(!isFatal(new Error("Street View: 500")));
  assert.deepEqual(estimateUsage(request({ maxCandidates: 40, locationTypes: ["industrieel", "water"] })), {
    streetViewImages: 160,
    placesRequests: 6,
  });
});
