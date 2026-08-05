/**
 * Phase 1 product-surface regressions (updated for control-plane IA):
 * - Access first-class on /api/state
 * - 4-nav shell; Sessions not a top-level route
 * - Project full pages; Access honesty retained
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";

const html = () => readFileSync(join(process.cwd(), "assets", "app.html"), "utf8");
const js = () => readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");

function indexOfOrThrow(source, needle, label = needle) {
  const idx = source.indexOf(needle);
  assert.ok(idx >= 0, `expected to find: ${label}`);
  return idx;
}

test("Sessions is not a top-level nav route (Advanced lives on Project page)", () => {
  const appHtml = html();
  const navSlice = appHtml.slice(
    appHtml.indexOf('aria-label="Main navigation"'),
    appHtml.indexOf("</nav>"),
  );
  assert.match(navSlice, /data-route="projects"/);
  assert.match(navSlice, /data-route="events"/);
  assert.match(navSlice, /data-route="library"/);
  assert.match(navSlice, /data-route="settings"/);
  assert.doesNotMatch(navSlice, /data-route="sessions"/);
  assert.doesNotMatch(appHtml, /data-route="sessions"/);
  assert.doesNotMatch(appHtml, /data-route="tools"/);
  assert.doesNotMatch(appHtml, /data-route="home"/);
  // Sessions/diagnostics tab removed 2026-07-26: it duplicated Overview's live proof
  // (both called /api/room/ai-proof). Project sections are Overview..MCP only.
  assert.doesNotMatch(appHtml, /data-project-section="advanced"/);
  assert.match(appHtml, /data-project-section="connections"[^>]*>\s*Connections\s*</);
});

test("AI tools live on Project full page (fact rows), not top-level nav", () => {
  const appHtml = html();
  const appJs = js();
  assert.match(appHtml, /data-project-section="ai"/);
  assert.match(appHtml, /id="project-section-ai"/);
  assert.match(appJs, /function renderProjectAi/);
  assert.match(appJs, /ai-fact-row|project\.ai\.desc_terminal/);
  assert.match(appJs, /loginProfiles/);
  assert.doesNotMatch(appHtml, /data-route="tools"/);
});

test("Project composition IA: create from folder; Access first-class copy", () => {
  const appHtml = html();
  assert.match(appHtml, /New Project|data-i18n="create\.title"/i);
  assert.match(appHtml, /id="create-project-form"/);
  assert.match(appHtml, /id="create-boundary-preview"/);
  assert.match(appHtml, /Standard/);
  assert.match(appHtml, /Create Project/i);

  const appJs = js();
  // Folders UI leads with "Project folder" (Access root is the same binding).
  assert.match(appJs, /Project folder/);
  assert.match(appJs, /\/api\/access\/workspace/);
  assert.match(appJs, /function accessSummary\(/);
  assert.match(appJs, /bindWorkspaceAccess/);
  assert.match(appJs, /\/api\/access\/workspace/);
  assert.match(appJs, /project\.access\?\.roots/);
  // Empty folder copy points at Project → Folders (CLI bumper access set is CLI-only).
  assert.match(appJs, /No folder yet — open this Project and choose one under Folders/);
});

test("Sandbox / Broker honesty retained after control-plane shell move", () => {
  const appHtml = html();
  const appJs = js();
  assert.match(appJs, /Hidden until end-to-end Hub proof|MCP integrations/i);
  // Product UI uses plain language; threat-model keeps VM/Broker vocabulary.
  assert.match(appJs, /Checked on this Mac|Controlled per Session/);
  assert.match(appJs, /Isolated|Real Sandbox|Allowed sites only/);
  assert.match(appJs, /function aiLaunchCommand\(/);
  assert.doesNotMatch(appJs, /Launch protected/i);
  indexOfOrThrow(appHtml, 'data-project-section="git"');
});

test("API state exposes Access roots on each project", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-access-api-"));
  const workspace = join(root, "workspace");
  const extra = join(root, "extra");
  mkdirSync(workspace);
  mkdirSync(extra);
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    defaultContext: "Demo",
    backends: {},
    contexts: {
      Demo: {
        description: "access test",
        workspace,
        mode: "read-write",
        backends: [],
        writePaths: [],
        readPaths: [extra],
        repos: [],
        allowedHosts: [],
        room: {
          enabled: true,
          image: "docker.io/library/alpine:3.20",
          egress: "blocked",
          doors: [],
        },
      },
    },
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

  const state = await (await fetch(`${handle.url}/api/state`)).json();
  assert.ok(state.contexts.Demo.access);
  assert.equal(state.contexts.Demo.access.workspace, workspace);
  assert.ok(state.contexts.Demo.access.rootCount >= 2);
  assert.ok(Array.isArray(state.contexts.Demo.access.roots));
  assert.ok(state.contexts.Demo.access.roots.some((r) => r.role === "workspace"));
  assert.ok(state.contexts.Demo.access.roots.some((r) => r.role === "read"));
});
