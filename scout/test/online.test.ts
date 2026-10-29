import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { PasswordAuth } from "../src/auth.ts";
import { createApp } from "../src/server.ts";
import { fakeDeps } from "./helpers.ts";

const PASSWORD = "lange-test-wachtwoord";
let base = "";
let dataDir = "";
let close: () => Promise<void>;

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "scout-online-"));
  const { deps } = fakeDeps();
  const app = createApp({ dataDir, googleKey: "main-key", hasAnthropicCredentials: false, deps, password: PASSWORD });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => app.close(() => resolve()));
});

after(async () => {
  await close();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

const login = (password: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/login`, { method: "POST", headers: { Origin: base, ...headers }, body: JSON.stringify({ password }) });

test("without logging in: the login page and no API", async () => {
  const html = await fetch(`${base}/`).then((r) => r.text());
  assert.match(html, /login-form/);
  assert.match(await fetch(`${base}/print.html`).then((r) => r.text()), /login-form/);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
  assert.equal((await fetch(`${base}/api/config`)).status, 401);
  assert.equal((await fetch(`${base}/api/searches`)).status, 401);
});

test("logging in gives a session for the app and the API", async () => {
  assert.equal((await login("fout")).status, 401);
  const res = await login(PASSWORD, { "X-Forwarded-Proto": "https" });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  const session = cookie.split(";")[0];

  const html = await fetch(`${base}/`, { headers: { Cookie: session } }).then((r) => r.text());
  assert.doesNotMatch(html, /login-form/);
  const config = await fetch(`${base}/api/config`, { headers: { Cookie: session } }).then((r) => r.json());
  assert.equal(config.online, true);
  // The main key never reaches the browser online.
  assert.equal(config.embedKey, null);

  // A forged or expired session does not work.
  const forged = session.replace(/\.[^.]+$/, ".abc");
  assert.equal((await fetch(`${base}/api/config`, { headers: { Cookie: forged } })).status, 401);
});

test("online the keys and the internet link can't be changed from the browser", async () => {
  const session = (await login(PASSWORD)).headers.get("set-cookie")!.split(";")[0];
  const headers = { Cookie: session, Origin: base };
  const key = await fetch(`${base}/api/settings/google-key`, { method: "POST", headers, body: JSON.stringify({ key: "AIzaNew" }) });
  assert.equal(key.status, 403);
  assert.equal((await fetch(`${base}/api/tunnel`, { method: "POST", headers, body: "{}" })).status, 403);
  // A write from another website is refused even with the cookie.
  const search = await fetch(`${base}/api/searches`, { method: "POST", headers: { Cookie: session, Origin: "https://evil.example" }, body: "{}" });
  assert.equal(search.status, 403);
});

test("too many wrong passwords block the address for a while", () => {
  let now = 0;
  const auth = new PasswordAuth(PASSWORD, () => now);
  for (let i = 0; i < 10; i++) assert.equal(auth.login("fout", "1.2.3.4"), null);
  assert.equal(auth.isBlocked("1.2.3.4"), true);
  assert.equal(auth.isBlocked("5.6.7.8"), false);
  now += 16 * 60_000;
  assert.equal(auth.isBlocked("1.2.3.4"), false);
});

test("a short password is refused at startup", () => {
  assert.throws(() => new PasswordAuth("kort"), /minstens 10 tekens/);
});
