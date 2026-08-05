/**
 * Project Access empty-roots usability:
 * - bumper access set binds workspace as primary Access root
 * - cwd resolveProject matches after Access is set
 * - status / CLI messaging stays honest (no silent home door)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  matchProjectsByCwd,
  normalizeHostPath,
  projectAccessRoots,
  resolveProject,
  resolveProjectNameForAccessEdit,
  setProjectAccessWorkspace,
} from "../dist/project.js";
import { buildProjectStatusSnapshot, formatProjectStatus, nextCommandsForAction } from "../dist/cli-room.js";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";

function blankContext(overrides = {}) {
  return {
    description: "",
    backends: [],
    mode: "read-write",
    inheritMode: true,
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
    ...overrides,
  };
}

function makeConfig(contexts) {
  return {
    webPort: 0,
    backends: {},
    globalPolicy: {
      mode: "read-write",
      native: { allow: [], deny: [] },
      commands: {
        gitRead: "allow", gitLocalWrite: "allow", gitRemoteRead: "allow",
        gitRemoteWrite: "block", shellRead: "allow", shellWrite: "allow", unknown: "block",
      },
      readPaths: [], writePaths: [], denyReadPaths: [], denyWritePaths: [],
    },
    contexts,
    defaultContext: Object.keys(contexts)[0],
  };
}

test("setProjectAccessWorkspace binds folder; cwd resolve matches afterward", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-access-set-"));
  try {
    const ws = join(root, "repo");
    mkdirSync(ws);
    const config = makeConfig({
      "Local workspace": blankContext({ description: "empty Access by default" }),
    });

    assert.equal(projectAccessRoots(config.contexts["Local workspace"]).length, 0);
    assert.deepEqual(matchProjectsByCwd(config, ws), []);

    const before = await resolveProject({ config, cwd: ws, interactive: false });
    assert.equal(before.ok, false);
    assert.equal(before.reason, "none");
    assert.match(before.message, /bumper access set/i);

    const bound = setProjectAccessWorkspace(config, "Local workspace", ws);
    assert.equal(normalizeHostPath(bound.workspace), normalizeHostPath(ws));
    assert.equal(bound.bindsHome, false);
    assert.ok(projectAccessRoots(config.contexts["Local workspace"]).some((r) => r.role === "workspace"));

    assert.deepEqual(matchProjectsByCwd(config, ws), ["Local workspace"]);
    const nested = join(ws, "src");
    mkdirSync(nested);
    assert.deepEqual(matchProjectsByCwd(config, nested), ["Local workspace"]);

    const after = await resolveProject({ config, cwd: nested, interactive: false });
    assert.equal(after.ok, true);
    assert.equal(after.name, "Local workspace");
    assert.equal(after.source, "cwd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setProjectAccessWorkspace refuses missing path and does not invent home", () => {
  const config = makeConfig({ Demo: blankContext() });
  assert.throws(
    () => setProjectAccessWorkspace(config, "Demo", ""),
    /required|never invents/i,
  );
  assert.throws(
    () => setProjectAccessWorkspace(config, "Demo", join(tmpdir(), "bumper-no-such-dir-" + Date.now())),
    /does not exist/i,
  );
  assert.equal(config.contexts.Demo.workspace, undefined);
  assert.equal(projectAccessRoots(config.contexts.Demo).length, 0);

  // Explicit home bind is allowed but flagged — never silent default.
  const home = normalizeHostPath(homedir());
  if (home) {
    const result = setProjectAccessWorkspace(config, "Demo", home);
    assert.equal(result.bindsHome, true);
    assert.equal(normalizeHostPath(result.workspace), home);
  }
});

test("resolveProjectNameForAccessEdit: flag / active / default; ambiguous cwd needs -p", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-access-resolve-"));
  try {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const config = makeConfig({
      Alpha: blankContext({ workspace: a }),
      Beta: blankContext({ workspace: b }),
      "Local workspace": blankContext(),
    });
    config.defaultContext = "Local workspace";

    assert.equal(
      resolveProjectNameForAccessEdit(config, root, "Alpha").name,
      "Alpha",
    );
    assert.equal(
      resolveProjectNameForAccessEdit(config, a, null).name,
      "Alpha",
    );
    assert.equal(
      resolveProjectNameForAccessEdit(config, root, null, "Beta").name,
      "Beta",
    );
    assert.equal(
      resolveProjectNameForAccessEdit(config, root, null, null).name,
      "Local workspace",
    );

    const shared = join(root, "shared");
    mkdirSync(shared);
    config.contexts.One = blankContext({ workspace: shared });
    config.contexts.Two = blankContext({ readPaths: [shared] });
    const amb = resolveProjectNameForAccessEdit(config, shared, null);
    assert.match(amb.error, /-p/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status format: empty Access points at bumper access set (no home invent)", async () => {
  const config = makeConfig({
    "Local workspace": blankContext(),
  });
  const snapshot = await buildProjectStatusSnapshot({
    config,
    projectName: "Local workspace",
    source: "active-state",
    cwd: process.cwd(),
    roomAvailable: false,
    roomAvailableDetail: "test",
  });
  assert.equal(snapshot.accessRoots.length, 0);
  const text = formatProjectStatus(snapshot);
  assert.match(text, /none — cwd resolve cannot match/i);
  assert.match(text, /bumper access set -p "Local workspace"/);
  assert.match(text, /does not invent a home-wide door/i);
  assert.doesNotMatch(text, /readPaths \/ writePaths \/ room doors/);
});

test("choose-workspace next commands mention access set", () => {
  const lines = nextCommandsForAction("choose-workspace");
  assert.ok(lines.some((l) => /bumper access set/i.test(l)));
  assert.ok(lines.some((l) => /Access/i.test(l)));
});

test("API POST /api/access/workspace binds primary Access root", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-access-api-bind-"));
  const folder = join(root, "chosen");
  mkdirSync(folder);
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.json");
  writeFileSync(configPath, JSON.stringify(makeConfig({
    "Local workspace": blankContext({ description: "empty" }),
  }), null, 2));

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

  const before = await (await fetch(`${handle.url}/api/state`)).json();
  assert.equal(before.contexts["Local workspace"].access.rootCount, 0);

  const res = await fetch(`${handle.url}/api/access/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: "Local workspace", workspace: folder }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(normalizeHostPath(body.workspace), normalizeHostPath(folder));
  assert.equal(body.bindsHome, false);

  const after = await (await fetch(`${handle.url}/api/state`)).json();
  assert.ok(after.contexts["Local workspace"].access.rootCount >= 1);
  assert.equal(
    normalizeHostPath(after.contexts["Local workspace"].access.workspace),
    normalizeHostPath(folder),
  );

  const refuseEmpty = await fetch(`${handle.url}/api/access/workspace`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: "Local workspace", workspace: "" }),
  });
  assert.equal(refuseEmpty.status, 400);
  const refuseBody = await refuseEmpty.json();
  assert.match(refuseBody.error, /required|invent/i);
});

test("CLI process: access set then status + cwd resolve path", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-access-cli-"));
  try {
    const ws = join(root, "work");
    mkdirSync(ws);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(makeConfig({
      "Local workspace": blankContext({ description: "Only the folder selected when a session starts" }),
    }), null, 2));

    const env = {
      ...process.env,
      BUMPER_CONFIG: configPath,
      BUMPER_STATE: join(root, "state.json"),
    };
    const cli = join(process.cwd(), "dist", "cli.js");

    const emptyStatus = spawnSync(process.execPath, [cli, "status", "-p", "Local workspace"], {
      encoding: "utf8",
      env,
    });
    assert.equal(emptyStatus.status, 0, emptyStatus.stderr);
    assert.match(emptyStatus.stdout, /bumper access set/i);
    assert.match(emptyStatus.stdout, /does not invent a home-wide door/i);

    const set = spawnSync(
      process.execPath,
      [cli, "access", "set", "-p", "Local workspace", ws],
      { encoding: "utf8", env },
    );
    assert.equal(set.status, 0, set.stderr + set.stdout);
    assert.match(set.stdout, /primary Access root/i);
    assert.match(set.stdout, /cwd resolve/i);

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(normalizeHostPath(saved.contexts["Local workspace"].workspace), normalizeHostPath(ws));

    const show = spawnSync(process.execPath, [cli, "access", "show", "-p", "Local workspace"], {
      encoding: "utf8",
      env,
    });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /workspace:/i);
    assert.match(show.stdout, new RegExp(ws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const status = spawnSync(process.execPath, [cli, "status"], {
      encoding: "utf8",
      env,
      cwd: ws,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Project: Local workspace/);
    assert.match(status.stdout, /resolved via cwd/);
    assert.match(status.stdout, /workspace:/i);
    assert.doesNotMatch(status.stdout, /none — cwd resolve cannot match/);

    const help = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8", env });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /bumper access set/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
