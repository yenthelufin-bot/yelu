// Plain JavaScript on purpose: it must start on an older Node to tell you to upgrade.
// One-time setup on your own computer: `npm run setup` in this folder.
// Installs the dependencies, stores the Google key in .env, checks it, and
// links Location Scout to the Claude desktop app.

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, ".env");

const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const step = (msg) => console.log(`\n${msg}`);

export function checkNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 18);
}

/** Where the Claude desktop app keeps its config on this system. */
export function claudeConfigPath(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

/** Adds or updates the location-scout entry, keeping everything else in the config. */
export function linkClaudeDesktop(configFile, nodePath, mcpScript) {
  let config = {};
  const exists = existsSync(configFile);
  if (exists) {
    const raw = readFileSync(configFile, "utf8");
    try {
      config = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`${configFile} is geen geldige JSON. Herstel of verwijder het bestand en probeer opnieuw.`);
    }
    copyFileSync(configFile, `${configFile}.backup`);
  }
  config.mcpServers = { ...config.mcpServers, "location-scout": { command: nodePath, args: [mcpScript] } };
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
  return exists ? "updated" : "created";
}

/** Sets one KEY=value line in a .env file, keeping the other lines. */
export function setEnvValue(file, key, value) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const line = `${key}=${value}`;
  const i = lines.findIndex((l) => l.startsWith(`${key}=`) || l.startsWith(`# ${key}=`));
  if (i >= 0) lines[i] = line;
  else lines.push(line);
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
}

function currentKey() {
  if (!existsSync(ENV_FILE)) return "";
  return readFileSync(ENV_FILE, "utf8").match(/^GOOGLE_MAPS_API_KEY=(.+)$/m)?.[1]?.trim() ?? "";
}

export const MCP_SCRIPT = path.join(ROOT, "src", "mcp.ts");

/**
 * Tidies a pasted key: invisible characters, surrounding quotes and a
 * leading "NAME=" are copy-paste leftovers, never part of a key.
 */
export function cleanKey(raw) {
  let key = String(raw ?? "").replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, "");
  key = key.replace(/^[A-Z_]*KEY[A-Z_]*=/, "");
  key = key.replace(/^["'`]+|["'`]+$/g, "");
  return key;
}

/**
 * Google key formats change (AI Studio keys no longer all look like Maps
 * keys), so only refuse what can't be a key or would break the .env file:
 * spaces, quotes, "#" and backslashes. Google itself judges the rest.
 */
export function looksLikeGoogleKey(key) {
  return /^[\x21-\x7E]{10,300}$/.test(key) && !/["'`#\\]/.test(key);
}

/** Whether the Claude desktop app's config already starts Location Scout. */
export function isClaudeLinked(configFile = claudeConfigPath()) {
  try {
    return Boolean(JSON.parse(readFileSync(configFile, "utf8")).mcpServers?.["location-scout"]);
  } catch {
    return false;
  }
}

/**
 * Checks the key with a cheap call to the two APIs every search needs, so a
 * missing API shows up now and not mid-search. Street View metadata is free;
 * the geocode counts as one of the 10,000 free geocodes a month.
 */
export async function checkKey(key, fetchFn = fetch) {
  const problems = [];
  const call = (url) =>
    fetchFn(`${url}&key=${encodeURIComponent(key)}`)
      .then((r) => r.json())
      .catch((e) => ({ status: "NETWORK", error_message: e.message }));
  const checks = [
    ["Street View Static API", "https://maps.googleapis.com/maps/api/streetview/metadata?location=51.0543,3.7174", ["OK", "ZERO_RESULTS"]],
    ["Geocoding API", "https://maps.googleapis.com/maps/api/geocode/json?address=Gent", ["OK"]],
  ];
  for (const [api, url, good] of checks) {
    const body = await call(url);
    if (!good.includes(body.status)) problems.push(`${api}: ${body.status}${body.error_message ? ` (${body.error_message})` : ""}`);
  }
  return problems;
}

async function main() {
  console.log("Location Scout instellen\n========================");

  step("1. Node.js");
  if (!checkNode()) {
    warn(`Je hebt Node ${process.versions.node}; nodig is 22.18 of nieuwer. Installeer de LTS-versie van https://nodejs.org en start opnieuw.`);
    process.exit(1);
  }
  ok(`Node ${process.versions.node}`);

  step("2. Onderdelen installeren");
  execSync("npm install --no-audit --no-fund", { cwd: ROOT, stdio: "inherit" });
  ok("geïnstalleerd");

  step("3. Google-sleutel");
  let key = currentKey();
  // Reading lines from an iterator also works when the answers are piped in.
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question) => {
    process.stdout.write(question);
    const { value } = await lines.next();
    return value ?? "";
  };
  if (key) {
    const answer = await ask(`  Er staat al een sleutel in .env (…${key.slice(-4)}). Vervangen? (j/N) `);
    if (/^j/i.test(answer.trim())) key = "";
  }
  if (!key) {
    console.log("  Maak de sleutel aan zoals beschreven in README.md (stap 3), en plak hem hier.");
    key = cleanKey(await ask("  GOOGLE_MAPS_API_KEY: "));
  }
  rl.close();
  if (key && !looksLikeGoogleKey(key)) {
    warn("Die sleutel bevat spaties, aanhalingstekens, # of \\, en dat kan niet. Niets opgeslagen.");
    key = "";
  }
  if (!key) {
    warn("Geen sleutel ingevuld. Je kunt hem later in scout/.env zetten en `npm run setup` opnieuw draaien.");
  } else {
    setEnvValue(ENV_FILE, "GOOGLE_MAPS_API_KEY", key);
    ok("opgeslagen in scout/.env");
    const problems = await checkKey(key);
    if (problems.length) {
      warn("De sleutel werkt nog niet:");
      for (const p of problems) warn(`  ${p}`);
      warn("Controleer of de vier API's aan staan en de facturatie gekoppeld is. Een nieuwe sleutel werkt soms pas na enkele minuten.");
    } else {
      ok("sleutel werkt");
    }
  }

  step("4. Koppelen aan de Claude desktop-app");
  const configFile = claudeConfigPath();
  try {
    const result = linkClaudeDesktop(configFile, process.execPath, MCP_SCRIPT);
    ok(`${result === "created" ? "aangemaakt" : "bijgewerkt"}: ${configFile}${result === "updated" ? " (oude versie bewaard als .backup)" : ""}`);
  } catch (err) {
    warn(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  console.log(`
Klaar! Sluit de Claude desktop-app volledig af en open ze opnieuw.
Typ dan bijvoorbeeld:
  "Zoek industriële locaties aan het water rond Gent, 10 km, in roesttinten."
De resultatenpagina staat op http://localhost:4173 zolang de Claude-app open is.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === "--check-node") {
  // Used by the start files before anything else runs.
  if (!checkNode()) {
    console.error(`Je hebt Node ${process.versions.node}; Location Scout heeft 22.18 of nieuwer nodig. Installeer de LTS-versie van https://nodejs.org.`);
    process.exit(1);
  }
} else if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`\nInstellen mislukt: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
