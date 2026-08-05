/**
 * Phase 7-local — unsigned pack journey smoke, no unsolicited Bumper egress,
 * config permission + secret non-exposure spot checks, Help/docs local honesty.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { mutateRawConfig, writeFileAtomic } from "../dist/config-store.js";

import { RENDERER_ROUTES } from "../dist/electron-nav.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appHtml = () => readFileSync(join(repoRoot, "assets", "app.html"), "utf8");
const appJs = () => readFileSync(join(repoRoot, "assets", "app.js"), "utf8");
const packagedApp = join(repoRoot, "release", "mac-arm64", "Bumper.app");
const packagedBin = join(packagedApp, "Contents", "MacOS", "Bumper");

function withTempEnv(fn) {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase7-"));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  const cfg = join(root, "bumper.config.json");
  const statePath = join(root, "state.json");
  writeFileSync(cfg, JSON.stringify({
    webPort: 0,
    defaultContext: "demo",
    gitConnections: {
      "client-a": { name: "Client A", provider: "github", host: "github.com", identity: "acme" },
    },
    contexts: {
      demo: {
        workspace,
        mode: "read-write",
        backends: [],
        repos: ["github.com/acme/app"],
        gitConnectionId: "client-a",
        room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked" },
      },
    },
  }));
  writeFileSync(statePath, JSON.stringify({ activeContext: "demo" }));
  const prevConfig = process.env.BUMPER_CONFIG;
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = cfg;
  process.env.BUMPER_STATE = statePath;
  return {
    root,
    cfg,
    statePath,
    workspace,
    async run(body) {
      try {
        return await body({ root, cfg, statePath, workspace });
      } finally {
        if (prevConfig === undefined) delete process.env.BUMPER_CONFIG;
        else process.env.BUMPER_CONFIG = prevConfig;
        if (prevState === undefined) delete process.env.BUMPER_STATE;
        else process.env.BUMPER_STATE = prevState;
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test("Phase 7: static assets expose 4-nav + create/setup/project overview routes", () => {
  const html = appHtml();
  const js = appJs();
  assert.deepEqual(RENDERER_ROUTES, ["projects", "events", "library", "settings"]);
  for (const route of RENDERER_ROUTES) {
    assert.match(html, new RegExp(`data-route="${route}"`));
  }
  assert.match(html, /id="route-create"/);
  assert.match(html, /id="route-setup"/);
  assert.match(html, /id="route-project"/);
  assert.match(html, /data-project-section="overview"/);
  assert.match(js, /#\/create/);
  assert.match(js, /#\/setup/);
  assert.match(js, /#\/projects\//);
  assert.match(js, /function renderProjectOverview/);
  assert.match(js, /function chooseInitialRoute/);
  assert.match(js, /needsSystemSetup/);
});

test("Phase 7: no unsolicited Bumper egress — update check is user-triggered only", () => {
  const js = appJs();
  // Explicit Settings → Check button only.
  assert.match(js, /settings-check-updates/);
  assert.match(js, /Explicit user-triggered fetch only/);
  assert.match(js, /api\.github\.com\/repos\/crostra\/bumper\/releases\/latest/);
  // Must not auto-fire on boot / refresh / interval.
  assert.doesNotMatch(js, /setInterval\([^)]*releases\/latest/);
  assert.doesNotMatch(js, /checkUpdates\s*\(\s*\)\s*;/);
  assert.doesNotMatch(js, /addEventListener\(\s*["']load["'][^)]*releases\/latest/);
  // Host process: platform.telemetry is hard-false; no phone-home hosts in src/.
  const appTs = readFileSync(join(repoRoot, "src", "app.ts"), "utf8");
  assert.match(appTs, /telemetry:\s*false/);
  // web.ts was deleted with the legacy `bumper web` surface (pre-release cleanup).
  for (const file of ["app.ts", "electron.ts", "cli.ts"]) {
    const src = readFileSync(join(repoRoot, "src", file), "utf8");
    assert.doesNotMatch(src, /api\.segment\.|sentry\.io|mixpanel|amplitude\.com|telemetry\.bumper/i);
  }
});

test("Phase 7: Help/docs stay local — Settings Updates points at docs/, not remote Help SSOT", () => {
  const js = appJs();
  assert.match(js, /Local docs in this repository|Local docs in the repository/);
  assert.match(js, />docs\/</);
  // Updates check is user-triggered only (no auto download claim as primary UI prose).
  assert.match(js, /settings\.help\.fetch|Check for updates/);
  assert.ok(existsSync(join(repoRoot, "docs", "ui-control-plane.md")));
  assert.ok(existsSync(join(repoRoot, "docs", "RELEASE_READINESS.md")));
  // Public docs SSOT move is Phase 7-external — must not claim docs/public yet.
  assert.equal(existsSync(join(repoRoot, "docs", "public")), false);
});

test("Phase 7: config atomic write is mode 0600; secrets absent from state/export", async () => {
  const env = withTempEnv();
  await env.run(async ({ root, cfg }) => {
    mutateRawConfig((raw) => {
      raw.defaultContext = "demo";
    }, cfg);
    const mode = statSync(cfg).mode & 0o777;
    assert.equal(mode, 0o600, `expected config mode 0600, got ${mode.toString(8)}`);

    const { config } = loadConfig();
    const handle = await startApp(config, () => loadConfig().config, join(repoRoot, "dist", "cli.js"));
    try {
      const state = await (await fetch(`${handle.url}/api/state`)).json();
      const blob = JSON.stringify(state);
      assert.equal(state.platform.telemetry, false);
      assert.equal(state.gitConnections[0].token, undefined);
      assert.equal("hasCredential" in state.gitConnections[0], false);
      // Git Connections are labels only — no credential field in public state.
      assert.match(blob, /"gitConnections"/);

      const exportBody = await (await fetch(`${handle.url}/api/events/export`)).text();
      assert.doesNotMatch(exportBody, /PHASE7_SECRET_TOKEN_XYZ/);

      const probe = join(root, "atomic-probe.txt");
      writeFileAtomic(probe, "ok\n");
      assert.equal(statSync(probe).mode & 0o777, 0o600);
    } finally {
      await handle.close();
    }
  });
});

test("Phase 7: HTTP journey smoke — 4-nav + create/setup/project overview surfaces", async () => {
  const env = withTempEnv();
  await env.run(async () => {
    const { config } = loadConfig();
    const handle = await startApp(config, () => loadConfig().config, join(repoRoot, "dist", "cli.js"));
    try {
      const html = await (await fetch(handle.url)).text();
      for (const route of RENDERER_ROUTES) {
        assert.match(html, new RegExp(`data-route="${route}"`));
      }
      assert.match(html, /id="route-create"/);
      assert.match(html, /id="create-project-form"/);
      assert.match(html, /id="route-setup"/);
      assert.match(html, /id="setup-steps"/);
      assert.match(html, /id="route-project"/);
      assert.match(html, /data-project-section="overview"/);

      const js = await (await fetch(`${handle.url}/app.js`)).text();
      assert.match(js, /#\/projects\//);
      assert.match(js, /#\/create/);
      assert.match(js, /#\/setup/);
      assert.match(js, /renderProjectOverview/);
      assert.match(js, /class="command-chip"/);

      const state = await (await fetch(`${handle.url}/api/state`)).json();
      assert.ok(state.contexts.demo);
      assert.equal(state.platform.telemetry, false);
      assert.match(JSON.stringify(Object.keys(state.contexts)), /demo/);
    } finally {
      await handle.close();
    }
  });
});

test("Phase 7: unsigned packaged .app bundle contains control-plane assets", { skip: !existsSync(packagedApp) }, () => {
  assert.ok(existsSync(packagedApp), `missing ${packagedApp} — run npm run app:pack`);
  assert.ok(existsSync(packagedBin), `missing binary ${packagedBin}`);
  const resources = join(packagedApp, "Contents", "Resources", "app");
  // electron-builder may nest under Resources/app or use asar-disabled flat layout
  const assetRoots = [
    resources,
    join(packagedApp, "Contents", "Resources"),
    join(packagedApp, "Contents", "Resources", "app.asar.unpacked"),
  ];
  const foundHtml = assetRoots.some((root) => existsSync(join(root, "assets", "app.html")));
  const foundJs = assetRoots.some((root) => existsSync(join(root, "assets", "app.js")));
  const foundLocales = assetRoots.some((root) =>
    existsSync(join(root, "assets", "locales", "en.json"))
    && existsSync(join(root, "assets", "locales", "ja.json")));
  const foundDist = assetRoots.some((root) => existsSync(join(root, "dist", "electron.js")));
  assert.ok(foundHtml, "packaged app.html missing");
  assert.ok(foundJs, "packaged app.js missing");
  assert.ok(foundLocales, "packaged locales missing");
  assert.ok(foundDist, "packaged dist/electron.js missing");

  // Ad-hoc signature from build-app.mjs (not Developer ID).
  const infoPlist = readFileSync(join(packagedApp, "Contents", "Info.plist"), "utf8");
  assert.match(infoPlist, /com\.crostra\.bumper|Bumper/);
});

test("Phase 7 L8: unsigned packaged Bumper.app boots and serves control plane", async (t) => {
  if (!existsSync(packagedBin)) {
    t.skip("packaged Bumper.app missing — run npm run app:pack first");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "bumper-phase7-pack-"));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  const userData = join(root, "electron-user-data");
  mkdirSync(userData);
  const port = 19000 + Math.floor(Math.random() * 1000);
  const cfg = join(root, "bumper.config.json");
  const statePath = join(root, "state.json");
  writeFileSync(cfg, JSON.stringify({
    webPort: port,
    defaultContext: "pack-demo",
    contexts: {
      "pack-demo": {
        workspace,
        mode: "read-write",
        backends: [],
        room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked" },
      },
    },
  }));
  writeFileSync(statePath, JSON.stringify({ activeContext: "pack-demo" }));

  const child = spawn(packagedBin, [`--user-data-dir=${userData}`], {
    env: {
      ...process.env,
      BUMPER_CONFIG: cfg,
      BUMPER_STATE: statePath,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });

  const deadline = Date.now() + 25_000;
  let ready = false;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      break;
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (res.ok) {
        const state = await res.json();
        assert.ok(state.contexts["pack-demo"]);
        assert.equal(state.platform.telemetry, false);
        const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
        assert.match(html, /data-route="projects"/);
        assert.match(html, /data-route="events"/);
        assert.match(html, /data-route="library"/);
        assert.match(html, /data-route="settings"/);
        assert.match(html, /id="route-create"/);
        assert.match(html, /id="route-setup"/);
        assert.match(html, /id="route-project"/);
        ready = true;
        break;
      }
    } catch (err) {
      lastErr = (err && err.message) || String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  t.after(() => {
    try {
      if (child.exitCode === null) child.kill("SIGTERM");
    } catch { /* ignore */ }
    setTimeout(() => {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
      } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true });
    }, 500);
  });

  assert.ok(
    ready,
    `packaged app did not serve control plane on :${port}\nexit=${child.exitCode}\nlastErr=${lastErr}\noutput:\n${output.slice(-2000)}`,
  );
});
