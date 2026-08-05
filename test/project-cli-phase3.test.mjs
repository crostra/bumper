/**
 * Phase 3: reusable setups — permission snapshot/apply, AI login profiles,
 * MCP set apply with Sandbox honesty labels, GUI compose surfaces.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_AUTH_PROFILE,
  hostAuthDir,
  roomAuthDoors,
  roomAuthCredentialPresent,
  normalizeAuthProfileId,
} from "../dist/room/auth.js";
import { roomSpecForAgentLaunch, profileIdForAgent, roomLaunchAuthDoors } from "../dist/room/launch.js";
import {
  snapshotPermissionSetup,
  applyPermissionSetup,
  projectAuthProfileId,
  listAuthProfileIds,
} from "../dist/setups.js";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";
import { ConfigSchema } from "../dist/types.js";

const html = () => readFileSync(join(process.cwd(), "assets", "app.html"), "utf8");
const js = () => readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");

function blankContext(overrides = {}) {
  return {
    description: "",
    backends: [],
    mode: "read-write",
    inheritMode: false,
    policies: {},
    native: { allow: [], deny: [] },
    commands: { gitRemoteWrite: "block" },
    writePaths: ["/tmp/a-write"],
    readPaths: ["/tmp/a-read"],
    denyReadPaths: [],
    denyWritePaths: [],
    gitIgnored: "visible",
    repos: ["github.com/acme"],
    allowedHosts: [],
    loginProfiles: {},
    room: {
      enabled: true,
      image: "docker.io/library/alpine:3.20",
      egress: "blocked",
      egressTemplates: [],
      egressHosts: [],
      doors: [{ hostPath: "/tmp/shared", roomPath: "/shared/tmp", access: "read-only" }],
      workspaceShare: "whole",
      shareSubpaths: [],
    },
    ...overrides,
  };
}

// --- Permission setup pure logic ---

test("permission setup snapshot omits workspace and captures boundary fields", () => {
  const project = blankContext({
    workspace: "/Users/me/client-a",
    description: "Client A",
    mode: "read-only",
    room: {
      enabled: true,
      image: "bumper/ai-room:latest",
      egress: "allowlist",
      egressTemplates: ["anthropic"],
      egressHosts: ["api.example.com"],
      doors: [{ hostPath: "/tmp/x", roomPath: "/shared/x", access: "read-write" }],
      workspaceShare: "selected",
      shareSubpaths: ["src"],
    },
  });
  const snap = snapshotPermissionSetup(project);
  assert.equal(snap.mode, "read-only");
  assert.equal(snap.inheritMode, false);
  assert.deepEqual(snap.readPaths, ["/tmp/a-read"]);
  assert.deepEqual(snap.writePaths, ["/tmp/a-write"]);
  // repos is never captured into a setup (legacy field, not a boundary).
  assert.deepEqual(snap.repos, []);
  assert.equal(snap.room.egress, "allowlist");
  assert.equal(snap.room.image, "bumper/ai-room:latest");
  assert.deepEqual(snap.room.shareSubpaths, ["src"]);
  assert.ok(!("workspace" in snap));
});

test("apply permission setup copies boundary onto another project without wiping workspace/backends", () => {
  const source = blankContext({
    mode: "read-only",
    repos: ["github.com/acme"],
    room: {
      enabled: true,
      image: "img-a",
      egress: "open",
      egressTemplates: [],
      egressHosts: [],
      doors: [{ hostPath: "/tmp/d", roomPath: "/shared/d", access: "read-only" }],
      workspaceShare: "whole",
      shareSubpaths: [],
    },
  });
  const target = blankContext({
    workspace: "/Users/me/other",
    backends: ["filesystem"],
    mode: "read-write",
    loginProfiles: { grok: "client-acme" },
    room: {
      enabled: true,
      image: "img-b",
      egress: "blocked",
      egressTemplates: [],
      egressHosts: [],
      doors: [],
      workspaceShare: "whole",
      shareSubpaths: [],
    },
  });
  const applied = applyPermissionSetup(target, snapshotPermissionSetup(source));
  assert.equal(applied.workspace, "/Users/me/other");
  assert.deepEqual(applied.backends, ["filesystem"]);
  assert.equal(applied.loginProfiles.grok, "client-acme");
  assert.equal(applied.mode, "read-only");
  assert.equal(applied.room.egress, "open");
  assert.equal(applied.room.image, "img-a");
  assert.equal(applied.room.doors.length, 1);
});

// --- MCP set ---

// --- AI login profiles ---

let authDir;
before(() => {
  authDir = mkdtempSync(join(tmpdir(), "bumper-phase3-auth-"));
  process.env.BUMPER_STATE = join(authDir, "state.json");
});
after(() => {
  delete process.env.BUMPER_STATE;
  rmSync(authDir, { recursive: true, force: true });
});

test("default auth profile preserves legacy host path layout", () => {
  assert.equal(normalizeAuthProfileId(undefined), DEFAULT_AUTH_PROFILE);
  assert.equal(normalizeAuthProfileId(""), DEFAULT_AUTH_PROFILE);
  const def = hostAuthDir("grok", "/root/.grok", "default");
  const legacy = hostAuthDir("grok", "/root/.grok");
  assert.equal(def, legacy);
  assert.match(def, /room-auth[/\\]grok[/\\]/);
  assert.ok(!def.includes(`${join("profiles")}`));
});

test("named auth profiles isolate host dirs from default and each other", () => {
  const personal = roomAuthDoors("claude", "default");
  const client = roomAuthDoors("claude", "client-acme");
  const other = roomAuthDoors("claude", "personal");
  assert.equal(personal.length, client.length);
  assert.notEqual(personal[0].hostPath, client[0].hostPath);
  assert.notEqual(client[0].hostPath, other[0].hostPath);
  assert.match(client[0].hostPath, /profiles[/\\]client-acme/);
  assert.equal(personal[0].roomPath, client[0].roomPath);

  // Real credential filename: presence must mean a credential file, not any bytes.
  writeFileSync(join(personal[0].hostPath, ".credentials.json"), '{"p":1}');
  writeFileSync(join(client[0].hostPath, ".credentials.json"), '{"c":1}');
  assert.equal(roomAuthCredentialPresent("claude", "default"), true);
  assert.equal(roomAuthCredentialPresent("claude", "client-acme"), true);

  // Empty third profile stays unsigned even after its dirs are created
  assert.equal(roomAuthCredentialPresent("claude", "empty-slot"), false);
  roomAuthDoors("claude", "empty-slot");
  assert.equal(roomAuthCredentialPresent("claude", "empty-slot"), false);
});

test("invalid profile ids with path separators are rejected", () => {
  assert.throws(() => normalizeAuthProfileId("../escape"), /Invalid auth profile/);
  assert.throws(() => normalizeAuthProfileId("a/b"), /Invalid auth profile/);
});

test("roomSpecForAgentLaunch mounts profile-specific auth doors from loginProfiles", () => {
  const context = blankContext({
    workspace: "/tmp/ws",
    loginProfiles: { grok: "client-acme" },
  });
  mkdirSync("/tmp/ws", { recursive: true });
  const spec = roomSpecForAgentLaunch(context, "/tmp/ws", "grok", { mountAuth: true });
  const authDoor = spec.doors.find((d) => d.roomPath === "/root/.grok");
  assert.ok(authDoor);
  assert.match(authDoor.hostPath, /profiles[/\\]client-acme/);
  assert.equal(profileIdForAgent(context, "grok"), "client-acme");
  assert.equal(projectAuthProfileId(context, "grok"), "client-acme");
  assert.equal(projectAuthProfileId(context, "claude"), "default");

  const doors = roomLaunchAuthDoors("grok", { mountAuth: true, profileId: "client-acme" });
  assert.match(doors[0].hostPath, /client-acme/);
});

test("listAuthProfileIds always includes default and project selections", () => {
  const config = ConfigSchema.parse({
    authProfiles: ["default", "work"],
    contexts: {
      p: blankContext({ loginProfiles: { grok: "client-acme" } }),
    },
  });
  const ids = listAuthProfileIds(config, config.contexts.p);
  assert.ok(ids.includes("default"));
  assert.ok(ids.includes("work"));
  assert.ok(ids.includes("client-acme"));
});

// --- API integration ---

test("API: permission setup save/apply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bumper-phase3-api-"));
  const configPath = join(dir, "bumper.config.json");
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = join(dir, "state.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    defaultContext: "alpha",
    backends: {
      filesystem: { command: "echo", args: ["fs"], env: {} },
      github: { command: "echo", args: ["gh"], env: {} },
    },
    contexts: {
      alpha: {
        description: "A",
        workspace: join(dir, "ws-a"),
        backends: ["filesystem"],
        mode: "read-only",
        inheritMode: false,
        readPaths: ["/tmp/from-alpha"],
        writePaths: [],
        denyReadPaths: [],
        denyWritePaths: [],
        gitIgnored: "hidden",
        repos: ["github.com/alpha"],
        allowedHosts: [],
        commands: { gitRemoteWrite: "block" },
        native: { allow: [], deny: [] },
        policies: {},
        loginProfiles: {},
        room: {
          enabled: true,
          image: "docker.io/library/alpine:3.20",
          egress: "allowlist",
          egressTemplates: [],
          egressHosts: ["api.alpha.test"],
          doors: [],
          workspaceShare: "whole",
          shareSubpaths: [],
        },
      },
      beta: {
        description: "B",
        workspace: join(dir, "ws-b"),
        backends: [],
        mode: "read-write",
        inheritMode: true,
        readPaths: [],
        writePaths: [],
        denyReadPaths: [],
        denyWritePaths: [],
        gitIgnored: "visible",
        repos: [],
        allowedHosts: [],
        commands: {},
        native: { allow: [], deny: [] },
        policies: {},
        loginProfiles: { grok: "default" },
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
      },
    },
  }, null, 2));
  mkdirSync(join(dir, "ws-a"), { recursive: true });
  mkdirSync(join(dir, "ws-b"), { recursive: true });

  const { config } = loadConfig(configPath);
  const handle = await startApp(config, () => loadConfig(configPath).config, join(dir, "bin"));
  try {
    const base = handle.url;

    // state exposes setups catalogs
    const stateRes = await fetch(`${base}/api/state`);
    const state = await stateRes.json();
    assert.ok(state.permissionSetups);
    assert.ok(Array.isArray(state.authProfiles));
    assert.ok(state.authProfiles.includes("default"));
    assert.ok(state.contexts.alpha.loginProfiles);
    assert.equal(state.contexts.alpha.access.rootCount >= 1, true);

    // save permission setup from alpha
    const saveSetup = await fetch(`${base}/api/permission-setups`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ name: "client-readonly", fromProject: "alpha" }),
    });
    assert.equal(saveSetup.status, 200);
    const saved = await saveSetup.json();
    assert.equal(saved.ok, true);

    // apply to beta
    const applySetup = await fetch(`${base}/api/permission-setups/apply`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ name: "client-readonly", project: "beta" }),
    });
    assert.equal(applySetup.status, 200);
    const applied = await applySetup.json();
    assert.equal(applied.ok, true);

    const after = await (await fetch(`${base}/api/state`)).json();
    assert.equal(after.contexts.beta.mode, "read-only");
    assert.ok(after.contexts.beta.readPaths.includes("/tmp/from-alpha"));
    assert.equal(after.contexts.beta.room.egress, "allowlist");
    // repos is no longer published as a boundary and setups never write it.
    assert.equal(after.contexts.beta.repos, undefined);
    assert.equal(after.contexts.beta.appliedPermissionSetup, "client-readonly");
    // workspace preserved
    assert.equal(after.contexts.beta.workspace, join(dir, "ws-b"));

    // loginProfiles on context registers catalog entries (POST auth-profiles removed F5).
    const beforeCtx = await (await fetch(`${base}/api/state`)).json();
    const putCtx = await fetch(`${base}/api/contexts`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        previous: "beta",
        name: "beta",
        description: "B",
        workspace: join(dir, "ws-b"),
        mode: "read-only",
        inheritMode: false,
        backends: ["filesystem", "github"],
        loginProfiles: { grok: "client-acme", claude: "default" },
        gitIgnored: "visible",
        repos: ["github.com/alpha"],
        allowedHosts: [],
        readPaths: ["/tmp/from-alpha"],
        writePaths: [],
        denyReadPaths: [],
        denyWritePaths: [],
        commands: {},
        native: { allow: [], deny: [] },
        room: beforeCtx.contexts.beta.room,
      }),
    });
    assert.equal(putCtx.status, 200);

    const final = await (await fetch(`${base}/api/state`)).json();
    assert.equal(final.contexts.beta.loginProfiles.grok, "client-acme");
    assert.ok(final.authProfiles.includes("client-acme"));

    const agents = await (await fetch(`${base}/api/agents?context=beta`)).json();
    const grok = agents.find((a) => a.id === "grok");
    assert.ok(grok);
    assert.equal(grok.profileId, "client-acme");
  } finally {
    await handle.close();
    delete process.env.BUMPER_CONFIG;
    delete process.env.BUMPER_STATE;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- GUI surface regressions ---

test("GUI exposes AI login profiles on Project page; MCP Hub hidden; Sessions not top-level", () => {
  const appHtml = html();
  const appJs = js();

  assert.match(appHtml, /data-project-section="ai"/);
  // Sessions/diagnostics tab removed 2026-07-26: it duplicated Overview's live proof
  // (both called /api/room/ai-proof). Project sections are Overview..MCP only.
  assert.doesNotMatch(appHtml, /data-project-section="advanced"/);
  assert.match(appHtml, /data-project-section="connections"[^>]*>\s*Connections\s*</);
  assert.match(appHtml, /data-route="library"/);
  assert.match(appHtml, /Standard development/);
  assert.doesNotMatch(appHtml, /Built-in Permission templates/);
  assert.doesNotMatch(appHtml, /data-route="tools"/);
  assert.doesNotMatch(appHtml, /data-route="sessions"/);
  assert.doesNotMatch(appHtml, /id="mcp-advanced"/);
  assert.doesNotMatch(appHtml, /data-dialog-tab="ai-tools"/);

  assert.match(appJs, /function renderProjectAi/);
  assert.match(appJs, /ai-fact-row|project\.ai\.desc_terminal/);
  assert.match(appJs, /loginProfiles/);
  // Phase 9: no GUI Sign in on Project AI; storage is Settings → Privacy.
  assert.doesNotMatch(appJs, /signin-tool/);
  assert.match(appJs, /settings\.privacy\.ai_title|ai-storage-delete/);
});
