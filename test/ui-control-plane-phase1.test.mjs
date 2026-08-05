/**
 * Phase 1 control-plane shell: 4-nav, Project full pages, First Setup, no Home/Launch primary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";
import { RENDERER_ROUTES, ELECTRON_NAV } from "../dist/electron-nav.js";

const html = () => readFileSync(join(process.cwd(), "assets", "app.html"), "utf8");
const js = () => readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");

function indexOfOrThrow(source, needle, label = needle) {
  const idx = source.indexOf(needle);
  assert.ok(idx >= 0, `expected to find: ${label}`);
  return idx;
}

test("top-level nav is exactly Projects / Events / Library / Settings", () => {
  const appHtml = html();
  const navSlice = appHtml.slice(
    appHtml.indexOf('aria-label="Main navigation"'),
    appHtml.indexOf("</nav>"),
  );
  assert.deepEqual(RENDERER_ROUTES, ["projects", "events", "library", "settings"]);
  for (const route of RENDERER_ROUTES) {
    assert.match(navSlice, new RegExp(`data-route="${route}"`));
  }
  for (const banned of ["home", "connections", "verification", "activity", "blocked", "sessions", "global"]) {
    assert.doesNotMatch(navSlice, new RegExp(`data-route="${banned}"`));
    assert.doesNotMatch(appHtml, new RegExp(`data-route="${banned}"`));
  }
  const projects = indexOfOrThrow(navSlice, 'data-route="projects"');
  const events = indexOfOrThrow(navSlice, 'data-route="events"');
  const library = indexOfOrThrow(navSlice, 'data-route="library"');
  const settings = indexOfOrThrow(navSlice, 'data-route="settings"');
  assert.ok(projects < events && events < library && library < settings);
});

test("Project full-page sections exist; modal editor and Home launch are gone", () => {
  const appHtml = html();
  assert.match(appHtml, /id="route-project"/);
  assert.match(appHtml, /data-project-section="overview"/);
  assert.match(appHtml, /data-project-section="folders"/);
  assert.match(appHtml, /data-project-section="network"/);
  assert.match(appHtml, /data-project-section="ai"/);
  assert.match(appHtml, /data-project-section="git"/);
  // Sessions/diagnostics tab removed 2026-07-26: it duplicated Overview's live proof
  // (both called /api/room/ai-proof). Project sections are Overview..MCP only.
  assert.doesNotMatch(appHtml, /data-project-section="advanced"/);
  assert.match(appHtml, /data-project-section="connections"[^>]*>\s*Connections\s*</);
  assert.match(appHtml, /id="route-create"/);
  assert.match(appHtml, /id="route-setup"/);
  assert.match(appHtml, /Set up Bumper|data-i18n="setup\.title"/i);
  assert.doesNotMatch(appHtml, /id="route-home"/);
  assert.doesNotMatch(appHtml, /id="project-dialog"/);
  assert.doesNotMatch(appHtml, /id="launch-button"/);
  assert.doesNotMatch(appHtml, /data-dialog-tab="commands"/);
  assert.doesNotMatch(appHtml, /id="route-global"/);
  assert.doesNotMatch(appHtml, /id="mcp-advanced"/);
});

test("app.js chooses last Project Overview or Projects; CLI copy is primary run path", () => {
  const appJs = js();
  assert.match(appJs, /function chooseInitialRoute/);
  assert.match(appJs, /bumper\.lastProject/);
  assert.match(appJs, /function needsSystemSetup/);
  assert.match(appJs, /function openProjectPage/);
  assert.match(appJs, /function renderProjectOverview/);
  assert.match(appJs, /class="command-chip"/);
  assert.match(appJs, /function aiLaunchCommand\(/);
  // The "run from a terminal" copy moved to AI tools with the command it launches.
  assert.match(appJs, /project\.ai\.desc_terminal/);
  assert.doesNotMatch(appJs, /Launch protected/i);
  assert.doesNotMatch(appJs, /id="launch-button"/);
  assert.doesNotMatch(appJs, /function renderHome\(/);
  assert.doesNotMatch(appJs, /function renderGlobal\(/);
  assert.doesNotMatch(appJs, /function openProject\(/);
});

test("ELECTRON_NAV opens Projects — not Launch protected / home", () => {
  assert.equal(ELECTRON_NAV.openBumper, "projects");
  assert.equal(ELECTRON_NAV.activate, "projects");
  assert.equal(ELECTRON_NAV.secondInstance, "projects");
  assert.equal(ELECTRON_NAV.launchProtected, undefined);
  const source = readFileSync(join(process.cwd(), "src", "electron.ts"), "utf8");
  assert.match(source, /Open Projects/);
  assert.doesNotMatch(source, /Launch [Pp]rotected/);
  assert.doesNotMatch(source, /ELECTRON_NAV\.launchProtected/);
});

test("served HTML exposes new nav routes and create/setup surfaces", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-ui-phase1-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0, defaultContext: "Safe", backends: {},
    contexts: { Safe: { description: "test", mode: "read-write", workspace, backends: [], writePaths: [], readPaths: [], repos: [], allowedHosts: [] } },
  }));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = statePath;
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(process.cwd(), "dist", "cli.js"));
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG; else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE; else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  const appHtml = await (await fetch(handle.url)).text();
  assert.match(appHtml, /data-route="projects"/);
  assert.match(appHtml, /data-route="events"/);
  assert.match(appHtml, /data-route="library"/);
  assert.match(appHtml, /data-route="settings"/);
  assert.match(appHtml, /id="route-project"/);
  assert.match(appHtml, /id="create-project-form"/);
  assert.match(appHtml, /id="setup-steps"/);
  assert.doesNotMatch(appHtml, /data-route="home"/);
  assert.doesNotMatch(appHtml, /id="launch-button"/);

  const appJs = await (await fetch(`${handle.url}/app.js`)).text();
  assert.match(appJs, /#\/projects\//);
  assert.match(appJs, /renderProjectOverview/);
  assert.match(appJs, /function aiLaunchCommand\(/);
});
