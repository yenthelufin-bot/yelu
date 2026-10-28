import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkNode, claudeConfigPath, linkClaudeDesktop, setEnvValue } from "../setup.mjs";

test("Node version check", () => {
  assert.equal(checkNode("22.18.0"), true);
  assert.equal(checkNode("24.1.0"), true);
  assert.equal(checkNode("22.17.1"), false);
  assert.equal(checkNode("20.11.0"), false);
});

test("Claude desktop config location per system", () => {
  assert.equal(claudeConfigPath("darwin", "/Users/yen", {}), "/Users/yen/Library/Application Support/Claude/claude_desktop_config.json");
  assert.match(claudeConfigPath("win32", "C:\\Users\\yen", { APPDATA: "C:\\Users\\yen\\AppData\\Roaming" }), /Roaming.Claude.claude_desktop_config\.json$/);
  assert.equal(claudeConfigPath("linux", "/home/yen", {}), "/home/yen/.config/Claude/claude_desktop_config.json");
  // An empty variable counts as unset.
  assert.equal(claudeConfigPath("linux", "/home/yen", { XDG_CONFIG_HOME: "" }), "/home/yen/.config/Claude/claude_desktop_config.json");
});

test("linking keeps the other settings and servers", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "claude-cfg-"));
  const file = path.join(dir, "Claude", "claude_desktop_config.json");
  assert.equal(linkClaudeDesktop(file, "/usr/bin/node", "/x/scout/src/mcp.ts"), "created");
  writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" }, "location-scout": { command: "old" } } }));
  assert.equal(linkClaudeDesktop(file, "/usr/bin/node", "/x/scout/src/mcp.ts"), "updated");
  const config = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(config.theme, "dark");
  assert.deepEqual(config.mcpServers.other, { command: "x" });
  assert.deepEqual(config.mcpServers["location-scout"], { command: "/usr/bin/node", args: ["/x/scout/src/mcp.ts"] });
  assert.equal(JSON.parse(readFileSync(`${file}.backup`, "utf8")).mcpServers["location-scout"].command, "old");

  writeFileSync(file, "{ kapot");
  assert.throws(() => linkClaudeDesktop(file, "n", "m"), /geen geldige JSON/);
});

test(".env values are set without touching other lines", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "env-")), ".env");
  writeFileSync(file, "# uitleg\nGOOGLE_MAPS_API_KEY=\n# PORT=4173\n");
  setEnvValue(file, "GOOGLE_MAPS_API_KEY", "abc");
  setEnvValue(file, "PORT", "5000");
  assert.equal(readFileSync(file, "utf8"), "# uitleg\nGOOGLE_MAPS_API_KEY=abc\nPORT=5000\n");
});
