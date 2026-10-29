import assert from "node:assert/strict";
import { test } from "node:test";
import { GeminiError, GeminiJudge, isDailyQuota, retryDelaySeconds } from "../src/gemini.ts";
import { isFatal } from "../src/pipeline.ts";

const answer = {
  usable: true,
  score: 81,
  type_match: "industrieel",
  color_score: null,
  palette: [{ hex: "#5a3e2b", name: "roest" }],
  best_view_index: 2,
  summary: "Loods met roestige gevel.",
  strengths: ["textuur"],
  concerns: [],
  tags: ["loods"],
};

const ok = (text: string, finishReason = "STOP") =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason }] }), { status: 200 });
const error = (status: number, error: object) => new Response(JSON.stringify({ error }), { status });

function judge(responses: (Response | (() => Response))[], opts: { minIntervalMs?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof fetch;
  const j = new GeminiJudge({ apiKey: "AIzaTestKey", model: "gemini-test", fetchFn, sleep: async (ms) => void sleeps.push(ms), minIntervalMs: opts.minIntervalMs ?? 0 });
  return { j, calls, sleeps };
}

const views = [0, 90, 180].map((heading) => ({ heading, jpeg: Buffer.from(`img${heading}`) }));

test("sends the views as images with a JSON schema, and reads the answer", async () => {
  const { j, calls } = judge([ok(JSON.stringify(answer))]);
  const r = await j.assess("BRIEF", views, "Loods");
  assert.equal(r.assessment?.score, 81);
  assert.equal(r.assessment?.bestViewIndex, 2);
  assert.equal(r.inputTokens, 0, "free tier is not priced");
  assert.match(calls[0].url, /models\/gemini-test:generateContent$/);
  assert.equal((calls[0].init.headers as Record<string, string>)["x-goog-api-key"], "AIzaTestKey");
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.responseSchema.type, "OBJECT");
  assert.match(body.systemInstruction.parts[0].text, /BRIEF/);
  const images = body.contents[0].parts.filter((p: any) => p.inlineData);
  assert.equal(images.length, 3);
  assert.equal(images[0].inlineData.data, Buffer.from("img0").toString("base64"));
});

test("a JSON answer wrapped in a code fence is still read", async () => {
  const { j } = judge([ok("```json\n" + JSON.stringify(answer) + "\n```")]);
  assert.equal((await j.assess("B", views, "x")).assessment?.score, 81);
});

test("waits as long as Google asks on a per-minute limit, then continues", async () => {
  const { j, sleeps, calls } = judge([
    error(429, { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }] }),
    ok(JSON.stringify(answer)),
  ]);
  const r = await j.assess("B", views, "x");
  assert.equal(r.assessment?.score, 81);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [38_000]);
});

test("the daily limit stops the whole search", async () => {
  const daily = {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "You exceeded your current quota",
    details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }],
  };
  assert.equal(isDailyQuota({ error: daily }), true);
  const { j } = judge([error(429, daily)]);
  await assert.rejects(j.assess("B", views, "x"), (err) => err instanceof GeminiError && isFatal(err) && /daglimiet/.test(err.message));
});

test("an unknown model or bad key is fatal, a one-off server error is retried", async () => {
  await assert.rejects(judge([error(404, { code: 404, message: "models/x is not found" })]).j.assess("B", views, "x"), (err) => isFatal(err) && /model/.test((err as Error).message));
  await assert.rejects(
    judge([error(400, { code: 400, message: "API key not valid. Please pass a valid API key." })]).j.assess("B", views, "x"),
    (err) => isFatal(err),
  );
  const { j, calls } = judge([error(503, { code: 503, message: "overloaded" }), ok(JSON.stringify(answer))]);
  assert.equal((await j.assess("B", views, "x")).assessment?.score, 81);
  assert.equal(calls.length, 2);
});

test("falls back to plain JSON mode when the schema is refused", async () => {
  const { j, calls } = judge([error(400, { code: 400, message: "Invalid JSON payload: unknown field in response_schema" }), ok(JSON.stringify(answer))]);
  assert.equal((await j.assess("B", views, "x")).assessment?.score, 81);
  assert.equal(JSON.parse(calls[1].init.body as string).generationConfig.responseSchema, undefined);
});

test("safety blocks and cut-off answers become skipped spots", async () => {
  assert.match((await judge([ok("", "SAFETY")]).j.assess("B", views, "x")).skippedReason!, /geweigerd/);
  assert.match((await judge([ok("{", "MAX_TOKENS")]).j.assess("B", views, "x")).skippedReason!, /afgebroken/);
  const blocked = new Response(JSON.stringify({ promptFeedback: { blockReason: "OTHER" } }), { status: 200 });
  assert.match((await judge([blocked]).j.assess("B", views, "x")).skippedReason!, /geweigerd/);
});

test("calls never overlap and are spaced out", async () => {
  let active = 0;
  let maxActive = 0;
  const slow = () => {
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise<Response>((resolve) =>
      setTimeout(() => {
        active--;
        resolve(ok(JSON.stringify(answer)));
      }, 10),
    );
  };
  const fetchFn = (async () => slow()) as unknown as typeof fetch;
  const j = new GeminiJudge({ apiKey: "k", fetchFn, minIntervalMs: 0 });
  await Promise.all([j.assess("B", views, "a"), j.assess("B", views, "b"), j.assess("B", views, "c")]);
  assert.equal(maxActive, 1);
});

test("the key test reports problems instead of throwing", async () => {
  assert.equal(await judge([ok("OK")]).j.test(), null);
  assert.match((await judge([error(400, { code: 400, message: "API key not valid." })]).j.test())!, /ongeldig/);
});

test("retry delay parsing", () => {
  assert.equal(retryDelaySeconds({ error: { details: [{ retryDelay: "12.5s" }] } }), 12.5);
  assert.equal(retryDelaySeconds({ error: {} }), null);
});
