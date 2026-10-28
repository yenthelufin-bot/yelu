import assert from "node:assert/strict";
import { test } from "node:test";
import { bearingDeg, dedupeByDistance, destination, distanceM, spreadPoints } from "../src/geo.ts";
import { compassName, lightAdvice } from "../src/light.ts";
import { GENT } from "./helpers.ts";

test("distance between Gent and Brussel is about 50 km", () => {
  const brussel = { lat: 50.8467, lng: 4.3525 };
  const d = distanceM(GENT, brussel);
  assert.ok(d > 48_000 && d < 52_000, `got ${d}`);
});

test("destination and bearing are each other's inverse", () => {
  for (const bearing of [0, 45, 90, 180, 270, 359]) {
    const p = destination(GENT, bearing, 2_000);
    assert.ok(Math.abs(distanceM(GENT, p) - 2_000) < 1);
    const back = bearingDeg(GENT, p);
    const diff = Math.min(Math.abs(back - bearing), 360 - Math.abs(back - bearing));
    assert.ok(diff < 0.1, `bearing ${bearing} came back as ${back}`);
  }
});

test("spreadPoints stays inside the radius and covers it", () => {
  const points = spreadPoints(GENT, 10_000, 200);
  assert.equal(points.length, 200);
  const distances = points.map((p) => distanceM(GENT, p));
  assert.ok(Math.max(...distances) <= 10_001);
  // Points reach the outer ring too, not only the centre.
  assert.ok(distances.filter((d) => d > 8_000).length > 20);
});

test("dedupeByDistance keeps the first of each cluster", () => {
  const items = [
    { id: "a", location: GENT },
    { id: "b", location: destination(GENT, 0, 50) },
    { id: "c", location: destination(GENT, 0, 500) },
  ];
  assert.deepEqual(
    dedupeByDistance(items, 100).map((i) => i.id),
    ["a", "c"],
  );
});

test("light advice depends on which way the camera looks", () => {
  assert.equal(compassName(268), "westen");
  assert.match(lightAdvice(270), /Ochtendzon/);
  assert.match(lightAdvice(90), /Avondzon/);
  assert.match(lightAdvice(180), /tegenlicht/);
  assert.match(lightAdvice(0), /vol licht/);
});
