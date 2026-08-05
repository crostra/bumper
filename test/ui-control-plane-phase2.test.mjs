/**
 * Phase 2 Folders UI — matrix, Apply gate, templates, missing workspace recovery.
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
const css = () => readFileSync(join(process.cwd(), "assets", "app.css"), "utf8");

test("Folders UI is Finder-first with status, Apply, recovery — not nested Override", () => {
  const appJs = js();
  const appHtml = html();
  const appCss = css();
  assert.match(appJs, /function renderProjectFolders/);
  assert.match(appJs, /folders-pick-share/);
  assert.match(appJs, /Add folder/);
  assert.match(appJs, /Everything else in the project/);
  assert.match(appJs, /folders-table/);
  assert.doesNotMatch(appJs, /id="folders-whole-access"/);
  assert.doesNotMatch(appJs, /id="folders-share"/);
  assert.doesNotMatch(appJs, /folders-expert/);
  assert.doesNotMatch(appJs, /folders-template/);
  assert.match(appJs, /\/api\/folders\/apply/);
  assert.match(appJs, /Project folder not found/);
  assert.match(appJs, /folders-locate/);
  assert.match(appJs, /folders-remove-project/);
  assert.match(appJs, /Stop running sessions before Apply/);
  assert.doesNotMatch(appJs, /data-value="override"/);
  assert.doesNotMatch(appJs, /Apply to descendants/);
  assert.doesNotMatch(appJs, /Hidden-while-mounted/);
  assert.match(appHtml, /Standard development/);
  assert.match(appHtml, /Offline edit/);
  assert.match(appHtml, /Offline review/);
  assert.match(appCss, /\.folders-table/);
  assert.match(appCss, /\.access-pills/);
  assert.match(appCss, /\.folders-board/);
});

test("Library hides Permission templates while Create keeps the three presets", () => {
  const appJs = js();
  const appHtml = html();
  assert.match(appJs, /function renderLibrary/);
  assert.doesNotMatch(appJs, /<b>Permission templates<\/b>/);
  assert.doesNotMatch(appJs, /delete-permission-setup/);
  assert.match(appHtml, /Standard development/);
  assert.match(appHtml, /Offline edit/);
  assert.match(appHtml, /Offline review/);
});

test("API: folders preview/apply + built-in template apply with session gate", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bumper-folders-api-"));
  const workspace = join(dir, "ws");
  mkdirSync(workspace);
  const configPath = join(dir, "bumper.config.json");
  const statePath = join(dir, "state.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      webPort: 0,
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
            shareSubpaths: [],
            shareEntries: [],
            doors: [],
          },
        },
      },
      defaultContext: "demo",
    }),
  );
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = statePath;
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(process.cwd(), "dist", "cli.js"));
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(dir, { recursive: true, force: true });
  });

  const stateRes = await fetch(`${handle.url}/api/state`);
  const state = await stateRes.json();
  assert.ok(state.permissionSetups["Standard development"]?.builtin);
  assert.ok(state.permissionSetups["Offline review"]?.immutable);
  assert.equal(state.folderCapabilities.nestedOverride, false);
  assert.equal(state.contexts.demo.folders.workspace.status, "ok");

  const previewRes = await fetch(`${handle.url}/api/folders/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "demo",
      draft: {
        editor: "simple",
        workspaceAccess: "read-only",
        workspaceShare: "whole",
        entries: [],
        extraReadPaths: [],
        extraWritePaths: [],
      },
    }),
  });
  const preview = await previewRes.json();
  assert.equal(previewRes.status, 200);
  assert.ok(preview.diff.some((item) => item.field === "Shared folders"));
  assert.match(preview.diff.find((item) => item.field === "Shared folders").after, /Look only|project folder/);
  assert.ok(preview.matrix.some((row) => row.displayPath === "/workspace" && row.write === false));

  const applyRes = await fetch(`${handle.url}/api/folders/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "demo",
      draft: {
        editor: "advanced",
        workspaceAccess: "read-write",
        workspaceShare: "selected",
        entries: [{ path: "src", access: "read-only" }],
        extraReadPaths: [],
        extraWritePaths: [],
      },
    }),
  });
  assert.equal(applyRes.status, 200, await applyRes.text());
  const cfg = loadConfig().config;
  assert.equal(cfg.contexts.demo.room.workspaceShare, "selected");
  assert.deepEqual(cfg.contexts.demo.room.shareEntries, [{ path: "src", access: "read-only" }]);

  const templateRes = await fetch(`${handle.url}/api/permission-setups/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Offline review", project: "demo" }),
  });
  assert.equal(templateRes.status, 200);
  const after = loadConfig().config;
  assert.equal(after.contexts.demo.mode, "read-only");
  assert.equal(after.contexts.demo.room.egress, "blocked");

  const overwrite = await fetch(`${handle.url}/api/permission-setups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Standard development", fromProject: "demo" }),
  });
  assert.equal(overwrite.status, 400);

  const delBuiltin = await fetch(`${handle.url}/api/permission-setups`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Offline edit" }),
  });
  assert.equal(delBuiltin.status, 400);
});
