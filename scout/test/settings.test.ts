import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../src/server.ts";

const GOOD_KEY = "AIzaSyTestKey_1234567890abcdef";
let base = "";
let port = 0;
let dir = "";
let envFile = "";
let claudeConfigFile = "";
let close: () => Promise<void>;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "scout-settings-"));
  envFile = path.join(dir, ".env");
  claudeConfigFile = path.join(dir, "Claude", "claude_desktop_config.json");
  await writeFile(envFile, "# uitleg\nGOOGLE_MAPS_API_KEY=\n");
  const app = createApp({
    dataDir: dir,
    googleKey: undefined,
    hasAnthropicCredentials: false,
    envFile,
    claudeConfigFile,
    checkGoogleKey: async (key) => (key === GOOD_KEY ? [] : ["Street View Static API: REQUEST_DENIED"]),
    checkGemini: async (key, model) => (key === GOOD_KEY && model === "gemini-3.5-flash-lite" ? null : "De Gemini-sleutel is ongeldig."),
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  port = (app.address() as AddressInfo).port;
  base = `http://localhost:${port}`;
  close = () => new Promise((resolve) => app.close(() => resolve()));
});

after(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

const post = (p: string, body?: unknown) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("a fresh install reports what still needs setting up", async () => {
  const config = await fetch(`${base}/api/config`).then((r) => r.json());
  assert.equal(config.hasGoogleKey, false);
  assert.equal(config.claudeLinked, false);
  assert.equal(config.engine, "claude-app");
});

test("a rejected key is not saved", async () => {
  const r = await post("/api/settings/google-key", { key: "AIzaSyWrongKey_000000000000000" }).then((r) => r.json());
  assert.equal(r.saved, false);
  assert.match(r.problems[0], /REQUEST_DENIED/);
  assert.match(await readFile(envFile, "utf8"), /^GOOGLE_MAPS_API_KEY=$/m);
});

test("a pasted key can never add other settings to .env", async () => {
  const res = await post("/api/settings/google-key", { key: "abc\nANTHROPIC_API_KEY=x" }).then((r) => r.json());
  assert.equal(res.saved, false);
  assert.doesNotMatch(await readFile(envFile, "utf8"), /ANTHROPIC/);
  assert.equal((await post("/api/settings/google-key", { key: 'aaaa"bbbbbbbbbbbbbb' })).status, 400);
  assert.equal((await post("/api/settings/google-key", { key: "   " })).status, 400);
});

test("a working key is saved and used right away", async () => {
  const r = await post("/api/settings/google-key", { key: `  ${GOOD_KEY}  ` }).then((r) => r.json());
  assert.equal(r.saved, true);
  assert.equal(await readFile(envFile, "utf8"), `# uitleg\nGOOGLE_MAPS_API_KEY=${GOOD_KEY}\n`);
  const config = await fetch(`${base}/api/config`).then((r) => r.json());
  assert.equal(config.hasGoogleKey, true);
  assert.equal(config.embedKey, GOOD_KEY);
});

test("linking the Claude app writes its config", async () => {
  const r = await post("/api/settings/link-claude").then((r) => r.json());
  assert.equal(r.result, "created");
  const cfg = JSON.parse(await readFile(claudeConfigFile, "utf8"));
  assert.equal(cfg.mcpServers["location-scout"].command, process.execPath);
  assert.match(cfg.mcpServers["location-scout"].args[0], /scout[\\/]src[\\/]mcp\.ts$/);
  assert.equal((await fetch(`${base}/api/config`).then((r) => r.json())).claudeLinked, true);
});

test("other websites cannot use the API", async () => {
  const fromElsewhere = await fetch(`${base}/api/settings/link-claude`, { method: "POST", headers: { Origin: "https://evil.example" } });
  assert.equal(fromElsewhere.status, 403);

  // DNS rebinding: a request that reaches us under another host name.
  const status = await new Promise<number>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: "/api/config", headers: { Host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on("error", reject);
  });
  assert.equal(status, 403);

  // The page itself still loads for any host; only the API is guarded.
  const sameOrigin = await fetch(`${base}/api/settings/link-claude`, { method: "POST", headers: { Origin: base } });
  assert.equal(sameOrigin.status, 200);
});

test("a working Gemini key switches searching to the browser", async () => {
  const bad = await post("/api/settings/gemini", { key: "AIzaSyWrongKey_000000000000000", model: "gemini-3.5-flash-lite" }).then((r) => r.json());
  assert.equal(bad.saved, false);
  assert.doesNotMatch(await readFile(envFile, "utf8"), /GEMINI_API_KEY/);

  const good = await post("/api/settings/gemini", { key: GOOD_KEY, model: "gemini-3.5-flash-lite" }).then((r) => r.json());
  assert.equal(good.saved, true);
  const env = await readFile(envFile, "utf8");
  assert.match(env, new RegExp(`^GEMINI_API_KEY=${GOOD_KEY}$`, "m"));
  assert.match(env, /^GEMINI_MODEL=gemini-3.5-flash-lite$/m);
  const config = await fetch(`${base}/api/config`).then((r) => r.json());
  assert.equal(config.engine, "gemini");
  assert.equal(config.hasGeminiKey, true);
  assert.equal(config.ready, true);

  const badModel = await post("/api/settings/gemini", { key: GOOD_KEY, model: "../etc" });
  assert.equal(badModel.status, 400);
});
