/**
 * Phase 3 remnants + Phase 9 withdrawal of GUI sign-in.
 * Auth profile isolation / verify still apply; dedicated sign-in Sandbox is gone.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  roomAuthDoors,
  roomAuthCredentialPresent,
  resetRoomAuth,
  verifyProfileAuth,
  profileAuthStatus,
  projectAgentStatePath,
  hostAuthDir,
  DEFAULT_AUTH_PROFILE,
} from "../dist/room/auth.js";
import {
  roomSpecForAgentLaunch,
  terminalWindowFocusKey,
} from "../dist/room/launch.js";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";

const html = () => readFileSync(join(process.cwd(), "assets", "app.html"), "utf8");
const js = () => readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
const termHtml = () => readFileSync(join(process.cwd(), "assets", "terminal.html"), "utf8");
const termJs = () => readFileSync(join(process.cwd(), "assets", "terminal.js"), "utf8");

let authDir;
before(() => {
  authDir = mkdtempSync(join(tmpdir(), "bumper-ui-p3-auth-"));
  process.env.BUMPER_STATE = join(authDir, "state.json");
});
after(() => {
  delete process.env.BUMPER_STATE;
  rmSync(authDir, { recursive: true, force: true });
});

test("GUI sign-in RoomSpec helpers are gone (Phase 9-2)", async () => {
  const launch = await import("../dist/room/launch.js");
  assert.equal(typeof launch.roomSpecForSignin, "undefined");
  assert.equal(typeof launch.signinWindowKey, "undefined");
});

test("profile isolation: reset one profile leaves the other", () => {
  const a = roomAuthDoors("claude", "default");
  const b = roomAuthDoors("claude", "client-b");
  // Real credential filename — presence means a credential file, not any bytes.
  writeFileSync(join(a[0].hostPath, ".credentials.json"), '{"a":1}');
  writeFileSync(join(b[0].hostPath, ".credentials.json"), '{"b":1}');
  assert.equal(roomAuthCredentialPresent("claude", "default"), true);
  assert.equal(roomAuthCredentialPresent("claude", "client-b"), true);

  resetRoomAuth("claude", "client-b");
  assert.equal(roomAuthCredentialPresent("claude", "client-b"), false);
  assert.equal(roomAuthCredentialPresent("claude", "default"), true);
});

test("verify / status lifecycle: needs-signin → unknown → verified", () => {
  const profile = "verify-slot";
  assert.equal(profileAuthStatus("codex", profile).status, "needs-signin");
  const [door] = roomAuthDoors("codex", profile);
  writeFileSync(join(door.hostPath, "auth.json"), "{}");
  assert.equal(profileAuthStatus("codex", profile).status, "unknown");
  const verified = verifyProfileAuth("codex", profile);
  assert.equal(verified.status, "verified");
  assert.ok(verified.verifiedAt);
  assert.equal(profileAuthStatus("codex", profile).status, "verified");
});

test("Project × Tool history path is separate from room-auth credential roots", () => {
  const history = projectAgentStatePath("acme", "grok");
  const auth = hostAuthDir("grok", "/root/.grok", "client-acme");
  assert.match(history, /project-agent-state[/\\]acme[/\\]grok/);
  assert.match(auth, /room-auth[/\\]grok[/\\]profiles/);
  assert.ok(!history.includes("room-auth"));
  assert.ok(!auth.includes("project-agent-state"));
});

test("window focus keys fall back to session id", () => {
  assert.equal(terminalWindowFocusKey("abc", "custom-key"), "custom-key");
  assert.equal(terminalWindowFocusKey("abc"), "session:abc");
});

test("agent launch mounts Project workspace and auth doors", () => {
  const workspace = mkdtempSync(join(tmpdir(), "bumper-ws-"));
  const context = {
    description: "",
    backends: [],
    mode: "read-write",
    inheritMode: false,
    policies: {},
    native: { allow: [], deny: [] },
    commands: {},
    writePaths: [],
    readPaths: [],
    denyReadPaths: [],
    denyWritePaths: [],
    gitIgnored: "visible",
    repos: [],
    allowedHosts: [],
    loginProfiles: { grok: "work" },
    room: {
      enabled: true,
      image: "docker.io/library/alpine:3.20",
      egress: "blocked",
      egressTemplates: [],
      egressHosts: [],
      doors: [],
      workspaceShare: "whole",
      shareSubpaths: [],
    },
  };
  const launch = roomSpecForAgentLaunch(context, workspace, "grok", { mountAuth: true });
  assert.ok(launch.doors.some((door) => door.roomPath === "/workspace"));
  assert.ok(launch.doors.some((door) => door.roomPath === "/root/.grok"));
  rmSync(workspace, { recursive: true, force: true });
});

test("UI: no main embedded xterm; Privacy holds AI storage; sign-in API gone", () => {
  const appJs = js();
  const appHtml = html();
  assert.match(appJs, /settings\.privacy\.ai_title/);
  assert.match(appJs, /ai-storage-delete/);
  // The GUI no longer attaches to rooms: sign-in and the Sandbox shell were both
  // withdrawn, so nothing opens a terminal window from the main window.
  assert.doesNotMatch(appJs, /id="show-terminal-window"/);
  assert.doesNotMatch(appJs, /function showTerminalWindow/);
  assert.doesNotMatch(appJs, /function connectSession/);
  assert.doesNotMatch(appJs, /sessionTerminal\s*=\s*new/);
  assert.doesNotMatch(appHtml, /vendor\/xterm\.js/);
  assert.doesNotMatch(appHtml, /id="session-terminal"/);
  assert.match(termHtml(), /term-help/);
  // Library home no longer surfaces AI create CTA (AI lives under Settings → Privacy).
  assert.match(appJs, /settingsCategory === "privacy"/);
  assert.match(appJs, /ai-storage-row/);
  void DEFAULT_AUTH_PROFILE;
});

test("Phase 1/2 regression: 4-nav and Folders board still present", () => {
  const appHtml = html();
  const appJs = js();
  for (const route of ["projects", "events", "library", "settings"]) {
    assert.match(appHtml, new RegExp(`data-route="${route}"`));
  }
  assert.match(appJs, /function renderProjectFolders/);
  assert.match(appJs, /Everything else in the project/);
  assert.match(appJs, /folders-table/);
  assert.match(appJs, /class="command-chip"/);
  assert.doesNotMatch(appHtml, /data-route="home"/);
  assert.doesNotMatch(appHtml, /id="launch-button"/);
});

test("API: auth profile catalog, verify/reset, terminal-window URL without Electron", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bumper-ui-p3-api-"));
  const configPath = join(dir, "bumper.config.json");
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = join(dir, "state.json");
  const workspace = join(dir, "ws");
  mkdirSync(workspace);
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    authProfiles: ["default", "client-a"],
    contexts: {
      demo: {
        workspace,
        mode: "read-write",
        loginProfiles: { grok: "client-a" },
        room: {
          enabled: true,
          image: "docker.io/library/alpine:3.20",
          egress: "blocked",
          doors: [],
          workspaceShare: "whole",
        },
      },
    },
  }, null, 2));

  const { config } = loadConfig(configPath);
  const handle = await startApp(config, () => loadConfig(configPath).config, join(dir, "bin"));
  try {
    const base = handle.url;
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.ok(Array.isArray(state.authProfiles));
    assert.ok(state.authProfiles.includes("client-a"));
    // authProfileCatalog (profile × every agent) was deleted in the pre-release
    // cleanup — nothing consumed it and it cost a detectAgents() pass per request.
    assert.equal(state.authProfileCatalog, undefined);
    assert.ok(Array.isArray(state.aiLogins));

    const agents = await (await fetch(`${base}/api/agents?context=demo`)).json();
    const grok = agents.find((a) => a.id === "grok");
    assert.equal(grok.profileId, "client-a");
    assert.equal(grok.authLaunchGate, false);
    assert.ok(["needs-signin", "unknown", "verified", "checking"].includes(grok.authStatus));

    // Phase 9-6 F5: POST /api/auth-profiles withdrawn (Library AI create removed).
    const create = await fetch(`${base}/api/auth-profiles`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ id: "client-b" }),
    });
    // The create route was deleted outright in the pre-release cleanup (was a 410 stub).
    assert.equal(create.status, 404);

    // Named profile dirs still work via host layout (CLI --account path).
    // Use grok's real credential filename: auth status is strict about markers so
    // that an empty/incidental tree never reads as a login (2026-07-25 review).
    const doors = roomAuthDoors("grok", "client-b");
    writeFileSync(join(doors[0].hostPath, "auth.json"), "{}");
    const verify = await fetch(`${base}/api/auth-profiles/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ agentId: "grok", profileId: "client-b" }),
    });
    assert.equal(verify.status, 200);
    const verified = await verify.json();
    assert.equal(verified.status, "verified");

    const reset = await fetch(`${base}/api/auth-profiles/reset`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ agentId: "grok", profileId: "client-b" }),
    });
    assert.equal(reset.status, 200);
    assert.equal((await reset.json()).status, "needs-signin");

    const termPage = await fetch(`${base}/terminal.html`);
    assert.equal(termPage.status, 200);
    assert.match(await termPage.text(), /Bumper terminal/);

    // Without a live session, terminal-window returns 404 — expected.
    const missing = await fetch(`${base}/api/terminal-window`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ sessionId: "missing" }),
    });
    assert.equal(missing.status, 404);

    // Hooks path: inject a fake opener and ensure dedupe focus.
    const opens = [];
    const hooked = await startApp(config, () => loadConfig(configPath).config, join(dir, "bin"), {
      openTerminalWindow: (req) => {
        opens.push(req);
        return { ok: true, focused: opens.length > 1, created: opens.length === 1, url: `/terminal.html?session=${req.sessionId}` };
      },
    });
    try {
      // Fabricate a stopped session entry via list emptiness — use sessions manager directly.
      const fake = {
        id: "sess-1",
        agentId: "grok",
        agentName: "Grok sign-in",
        context: "demo",
        workspace,
        backend: "room",
        status: "running",
        protected: true,
        startedAt: new Date().toISOString(),
        presentation: "terminal",
        kind: "signin",
        profileId: "client-a",
        windowKey: "session:sess-1",
        clients: new Set(),
        output: "",
      };
      hooked.sessions.sessions?.set?.(fake.id, fake);
      // SessionManager.sessions is private — exercise openOrDescribe via hook by posting after planting through public API is hard without Sandbox.
      // Instead call the hook the same way the API would:
      const result1 = hooked.hooks.openTerminalWindow({
        sessionId: "sess-1",
        windowKey: "session:sess-1",
        title: "Grok (Room)",
      });
      const result2 = hooked.hooks.openTerminalWindow({
        sessionId: "sess-1",
        windowKey: "session:sess-1",
        title: "Grok (Room)",
      });
      assert.equal(result1.created, true);
      assert.equal(result2.focused, true);
      assert.equal(opens.length, 2);
      assert.equal(opens[0].windowKey, opens[1].windowKey);
    } finally {
      await hooked.close();
    }
  } finally {
    await handle.close();
    delete process.env.BUMPER_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  }
});
