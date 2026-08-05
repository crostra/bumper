import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";

const asset = (path) => readFileSync(join(process.cwd(), "assets", path), "utf8");

test("owner-review cleanup removes fossil controls but keeps their live internals", () => {
  const html = asset("app.html");
  const js = asset("app.js");

  assert.doesNotMatch(html, /id="project-needs-setup"/);
  assert.doesNotMatch(html, /id="project-use-default"/);
  assert.doesNotMatch(js, /active-badge/);
  assert.match(js, /function projectNeedsSetup/);

  assert.match(html, /id="rename-project-dialog"/);
  assert.match(js, /function openRenameProjectDialog/);
  assert.match(js, /function renameSelectedProject/);
  assert.doesNotMatch(js, /window\.prompt/);

  assert.doesNotMatch(js, /id="overview-agent"/);
  assert.doesNotMatch(js, /notEnforcedBlock/);
  assert.match(js, /Open · unfiltered/);
  assert.match(js, /Off · no network/);
  assert.match(js, /id="run-prove-it"[\s\S]+id="prove-it-details"/);
  assert.match(js, /details\.hidden = true/);
  assert.match(html, />Limits<\/h2>/);
});

test("Library home contains only reusable GitHub and MCP resources", () => {
  const js = asset("app.js");
  const start = js.indexOf("function renderLibrary()");
  const end = js.indexOf("function openLibraryMcpAddPicker()", start);
  const home = js.slice(start, end);
  assert.match(home, /GitHub access/);
  assert.match(home, /library\.mcpConnections/);
  assert.doesNotMatch(home, /Permission templates/);
  assert.doesNotMatch(home, /This Mac Git identities/);

  const html = asset("app.html");
  assert.match(html, /Standard development/);
  assert.match(html, /Offline edit/);
  assert.match(html, /Offline review/);
});

test("approval, Events, and Settings copy match the cleaned interaction model", () => {
  const js = asset("app.js");
  const en = asset("locales/en.json");
  const ja = asset("locales/ja.json");

  assert.match(en, /"project\.ai\.approval_off": "Skipped"/);
  assert.match(ja, /"project\.ai\.approval_off": "スキップ中"/);
  assert.doesNotMatch(en, /"events\.expand"/);
  assert.doesNotMatch(en, /"events\.group\.count"/);
  assert.doesNotMatch(ja, /"events\.group\.count"/);
  assert.doesNotMatch(js, /toggle-event-raw/);
  assert.doesNotMatch(js, /events\.group\.count/);
  assert.doesNotMatch(js, /event-count/);

  assert.doesNotMatch(js, /data-section="overview">Open Project<\/button>/);
  assert.match(js, /class="event-context"/);
  assert.match(js, /function paintEventGroups/);

  assert.doesNotMatch(js, /protection-chip|sidebar-protection|Protection ready/);
  const html = asset("app.html");
  assert.doesNotMatch(html, /protection-chip|sidebar-protection/);

  assert.match(js, /function settingsLocationRow/);
  assert.match(js, /setting-location-copy/);
  assert.match(js, /setting-location-reveal/);
  assert.doesNotMatch(js, /Hidden until forced gateway proof/);
});

test("Mac app capability reveals only server-approved Settings locations", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bumper-ui-locations-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const configPath = join(dir, "config.json");
  const statePath = join(dir, "state.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    defaultContext: "demo",
    contexts: {
      demo: {
        workspace,
        mode: "read-write",
        inheritMode: false,
        backends: [],
        room: {
          enabled: true,
          image: "docker.io/library/alpine:3.20",
          egress: "blocked",
          workspaceShare: "whole",
          shareEntries: [],
          doors: [],
        },
      },
    },
  }));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = statePath;
  const revealed = [];
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig(configPath).config, join(process.cwd(), "dist", "cli.js"), {
    revealPath: (path) => revealed.push(path),
    gitSessionMonitoring: false,
  });
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(dir, { recursive: true, force: true });
  });

  const state = await (await fetch(`${handle.url}/api/state`)).json();
  assert.equal(state.capabilities.revealLocations, true);
  assert.equal(state.configPath, configPath);
  assert.equal(state.stateDir, dir);
  assert.equal(state.eventsPath, join(dir, "log", "events.jsonl"));

  const reveal = await fetch(`${handle.url}/api/reveal-location`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: "events" }),
  });
  assert.equal(reveal.status, 200, await reveal.text());
  assert.deepEqual(revealed, [dir]);

  const refused = await fetch(`${handle.url}/api/reveal-location`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: "/etc/passwd" }),
  });
  assert.equal(refused.status, 400);
});
