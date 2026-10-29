import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { buildBrief, LocationJudge, MODEL } from "../src/vision.ts";
import { request } from "./helpers.ts";

function fakeClient(response: object) {
  const sent: any[] = [];
  const client = {
    beta: {
      messages: {
        create: async (body: unknown) => {
          sent.push(body);
          return {
            stop_reason: "end_turn",
            usage: { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
            ...response,
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, sent };
}

const answer = {
  usable: true,
  meets_brief: true,
  score: 104,
  type_match: "industrieel",
  color_score: 72,
  palette: [
    { hex: "#8c5a3c", name: "roest" },
    { hex: "not-a-colour", name: "kapot" },
  ],
  best_view_index: 7,
  summary: "Oude graansilo aan het kanaal.",
  strengths: ["hoog en grafisch"],
  concerns: ["hek"],
  tags: ["silo", "beton"],
};

const views = [
  { heading: 10, jpeg: Buffer.from("a") },
  { heading: 100, jpeg: Buffer.from("b") },
];

test("the request sends every view as an image with the brief cached in the system prompt", async () => {
  const { client, sent } = fakeClient({ content: [{ type: "text", text: JSON.stringify(answer) }] });
  await new LocationJudge(client).assess("BRIEF", views, "Silo (OSM)");
  const body = sent[0];
  assert.equal(body.model, MODEL);
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.system.at(-1).cache_control.type, "ephemeral");
  assert.match(body.system.at(-1).text, /BRIEF/);
  const images = body.messages[0].content.filter((b: any) => b.type === "image");
  assert.equal(images.length, 2);
  assert.equal(images[0].source.media_type, "image/jpeg");
  assert.equal(images[0].source.data, Buffer.from("a").toString("base64"));
});

test("the answer is validated and clamped", async () => {
  const { client } = fakeClient({ content: [{ type: "text", text: JSON.stringify(answer) }] });
  const result = await new LocationJudge(client).assess("BRIEF", views, "Silo");
  const a = result.assessment!;
  assert.equal(a.score, 100);
  assert.equal(a.colorScore, 72);
  assert.equal(a.bestViewIndex, 1);
  assert.deepEqual(a.palette, [{ hex: "#8c5a3c", name: "roest" }]);
  assert.equal(result.inputTokens, 1500);
});

test("refusals and broken answers are reported, not thrown", async () => {
  const refused = await new LocationJudge(fakeClient({ stop_reason: "refusal", content: [] }).client).assess("B", views, "x");
  assert.equal(refused.assessment, null);
  assert.match(refused.skippedReason!, /geweigerd/);
  const broken = await new LocationJudge(fakeClient({ content: [{ type: "text", text: "{not json" }] }).client).assess("B", views, "x");
  assert.equal(broken.assessment, null);
});

test("the brief lists the chosen types, colours and wishes", () => {
  const brief = buildBrief(
    request({
      locationTypes: ["industrieel", "water"],
      colorPresets: ["koel"],
      customColors: ["#112233"],
      extraFilters: ["weinig_mensen"],
      description: "silo aan het water",
      shootType: "mode",
    }),
  );
  assert.match(brief, /industrieel:/);
  assert.match(brief, /water:/);
  assert.match(brief, /cool tones/);
  assert.match(brief, /#112233/);
  assert.match(brief, /few or no people/);
  assert.match(brief, /silo aan het water/);
  assert.match(brief, /mode/);
  assert.match(buildBrief(request()), /color_score null/);
});
