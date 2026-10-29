import assert from "node:assert/strict";
import { test } from "node:test";
import { destination } from "../src/geo.ts";
import { GoogleApiError } from "../src/google.ts";
import { assessLimit, estimateUsage, headingsFor, interleave, isFatal, runSearch, type SearchEvent } from "../src/pipeline.ts";
import { fakeDeps, GENT, request, verdict } from "./helpers.ts";

const run = async (deps: Parameters<typeof runSearch>[1], req = request(), signal = new AbortController().signal) => {
  const events: SearchEvent[] = [];
  const search = await runSearch(req, deps, (e) => events.push(e), signal);
  return { search, events };
};

test("a search keeps looking until it has the number of matching spots asked for", async () => {
  // Every third spot scores 55, below the minimum of 60: those don't count and aren't shown.
  const { deps, calls } = fakeDeps({ scores: [55, 90, 70] });
  const { search, events } = await run(deps, request({ maxCandidates: 6, minScore: 60 }));
  assert.equal(search.status, "done", search.error ?? "");
  assert.equal(search.results.length, 6);
  assert.ok(search.results.every((r) => r.score >= 60));
  assert.ok(calls.assess > 6, "looked further than 6 spots to find 6 good ones");
  assert.equal(search.analysed, calls.assess);
  assert.equal(search.shortfall, undefined);
  assert.deepEqual(
    search.results.map((r) => r.score),
    [...search.results.map((r) => r.score)].sort((a, b) => b - a),
  );
  assert.ok(search.results.every((r) => r.lightAdvice && r.rating === null && r.note === ""));
  assert.equal(search.cost.streetViewImages, calls.images);
  assert.ok(search.cost.estimatedUsd > 0, "Claude API tokens are priced");
  assert.equal(events.at(-1)?.type, "done");
  // All three sources contribute candidates.
  const found = events.find((e) => e.type === "candidates");
  assert.ok(found?.type === "candidates" && found.bySource.places > 0 && found.bySource.osm > 0 && found.bySource.grid > 0);
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
  assert.equal(search.results.length, 5);
  // Only a technical problem is reported; an unusable view is just passed over.
  const skipped = events.filter((e) => e.type === "skipped");
  assert.equal(skipped.length, 1);
});

test("a spot that goes against the wishes is never shown, however high its score", async () => {
  const { deps } = fakeDeps();
  let n = 0;
  deps.judge.assess = async () => (++n % 2 ? verdict(88, { meetsBrief: false, summary: "Tankstation langs de snelweg." }) : verdict(75));
  const { search, events } = await run(deps, request({ maxCandidates: 5 }));
  assert.equal(search.results.length, 5);
  assert.ok(search.results.every((r) => r.score === 75));
  assert.ok(!events.some((e) => e.type === "result" && e.result.summary.includes("Tankstation")));
});

test("when the zone has too few matching spots, the search says so instead of padding the list", async () => {
  const { deps, calls } = fakeDeps();
  let n = 0;
  deps.judge.assess = async () => (++n <= 2 ? verdict(80) : verdict(20, { meetsBrief: false }));
  const { search } = await run(deps, request({ maxCandidates: 5 }));
  assert.equal(search.status, "done");
  assert.equal(search.results.length, 2);
  assert.match(search.shortfall ?? "", /Meer plekken die aan je wensen voldoen/);
  assert.ok(calls.assess <= assessLimit(request({ maxCandidates: 5 })));
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
    streetViewImages: 640,
    placesRequests: 6,
    assessments: 160,
  });
});

test("reference photos steer the search and reach the judge", async () => {
  const { deps } = fakeDeps();
  const seenRefs: number[] = [];
  const assess = deps.judge.assess;
  deps.judge.assess = async (brief, views, context, refs) => {
    seenRefs.push(refs?.length ?? 0);
    assert.match(brief, /REFERENCE PHOTOS/);
    return assess(brief, views, context, refs);
  };
  deps.judge.analyzeReferences = async (refs, mode) => {
    assert.equal(refs.length, 2);
    assert.equal(mode, "similar");
    return { description: "Graansilo aan een kanaal.", locationTypes: ["industrieel", "water", "onbestaand"], colors: ["#8c5a3c", "fout"], placesQueries: ["graansilo"], locationGuesses: [] };
  };
  const queries: string[] = [];
  const searchText = deps.maps.searchText;
  deps.maps.searchText = async (q, c, r) => {
    queries.push(q);
    return searchText(q, c, r);
  };
  deps.loadReference = async (id) => Buffer.from(`ref-${id}`);
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const { search } = await run(deps, request({ mode: "similar", referenceIds: ids, locationTypes: [], maxCandidates: 5 }));
  assert.equal(search.status, "done", search.error ?? "");
  assert.ok(seenRefs.length > 0 && seenRefs.every((n) => n === 2));
  assert.equal(search.analysis?.description, "Graansilo aan een kanaal.");
  assert.equal(queries[0], "graansilo", "the photo's own searches go first");
  assert.ok(queries.includes("industrieterrein"), "types picked from the photo are searched too");
});

test("exact mode without a region searches around the best guess", async () => {
  const { deps } = fakeDeps();
  const geocoded: string[] = [];
  const geocode = deps.maps.geocode;
  deps.maps.geocode = async (q) => {
    geocoded.push(q);
    return geocode(q);
  };
  deps.loadReference = async () => Buffer.from("ref");
  deps.judge.analyzeReferences = async () => ({
    description: "Stenen brug met een kapel.",
    locationTypes: [],
    colors: [],
    placesQueries: [],
    locationGuesses: [
      { query: "Sint-Michielsbrug Gent", confidence: 80, why: "torens op de achtergrond" },
      { query: "Grasbrug Gent", confidence: 30, why: "kade" },
    ],
  });
  const { search } = await run(
    deps,
    request({ mode: "exact", place: "", referenceIds: ["11111111-1111-4111-8111-111111111111"], locationTypes: [], maxCandidates: 5 }),
  );
  assert.equal(search.status, "done", search.error ?? "");
  assert.deepEqual(geocoded, ["Sint-Michielsbrug Gent"]);

  deps.judge.analyzeReferences = async () => ({ description: "", locationTypes: [], colors: [], placesQueries: [], locationGuesses: [] });
  const nothing = await run(deps, request({ mode: "exact", place: "", referenceIds: ["11111111-1111-4111-8111-111111111111"], locationTypes: [] }));
  assert.equal(nothing.search.status, "error");
  assert.match(nothing.search.error ?? "", /regio/);
});

test("OpenStreetMap's access tag overrides the guess; Places ids are kept", async () => {
  const { deps } = fakeDeps({ places: 2, osm: 3 });
  const overpass = deps.overpass;
  deps.overpass = async (...args) => (await overpass(...args)).map((f) => ({ ...f, tags: { access: "private", operator: "Silo NV", phone: "+32 9 000 00 00", building: "silo" } }));
  const { search } = await run(deps, request({ maxCandidates: 10 }));
  const osm = search.results.filter((r) => r.source === "osm");
  assert.ok(osm.length > 0);
  assert.ok(osm.every((r) => r.access === "privé" && /OpenStreetMap/.test(r.accessNotes) && r.osm?.operator === "Silo NV"));
  assert.ok(osm.every((r) => r.osm?.building === undefined), "only access and contact tags are kept");
  assert.ok(search.results.filter((r) => r.source === "places").every((r) => r.placeId));
  assert.ok(search.results.filter((r) => r.source === "grid").every((r) => r.access === "publiek"));
});

test("searches around a fixed centre skip geocoding", async () => {
  const { deps, calls } = fakeDeps();
  let geocoded = false;
  deps.maps.geocode = async () => {
    geocoded = true;
    throw new Error("should not geocode");
  };
  const { search } = await run(deps, request({ place: "rond Silo 1", center: { lat: 51.06, lng: 3.72 }, maxCandidates: 5 }));
  assert.equal(search.status, "done", search.error ?? "");
  assert.equal(geocoded, false);
  assert.deepEqual(search.center, { lat: 51.06, lng: 3.72 });
  assert.ok(calls.assess > 0);
});
