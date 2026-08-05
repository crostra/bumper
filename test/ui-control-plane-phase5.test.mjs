/**
 * Git access supersedes the withdrawn host-only Git surface. GitHub controls
 * scopes; Bumper's Sandbox queue carries only credential protocol fields.
 * Slice B MCP Hub UI/tests live in ui-control-plane-phase5b.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";
import {
  listGitConnections,
  gitConnectionSecretsPath,
  purgeLegacyGitConnectionSecrets,
} from "../dist/git-connections.js";
import { readGitWorkspaceStatus } from "../dist/git-workspace.js";
import { roomSpecForContext } from "../dist/room/spec.js";
import { readEvents } from "../dist/log.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appJs = () => readFileSync(join(repoRoot, "assets", "app.js"), "utf8");

test("Git UI exposes provider connection and Project token scope (never token storage)", () => {
  const js = appJs();
  assert.match(js, /function renderLibraryGitConnections/);
  assert.match(js, /function renderLibraryGitConnectionEdit/);
  assert.match(js, /function renderLibraryGitHubAccess/);
  assert.match(js, /function renderProjectGit/);
  assert.match(js, /github-add-owner/);
  assert.match(js, /github-manage/);
  assert.match(js, /github-refresh/);
  assert.match(js, /git-repository/);
  assert.match(js, /git-access/);
  assert.match(js, /function gitLiveSessionsHtml/);
  assert.match(js, /git-session-toggle/);
  assert.match(js, /\/api\/github\/session-access/);
  assert.match(js, /Write for 15 min/);
  assert.match(js, /project\.git\.fact/);
  assert.match(js, /MCP integrations/);
  assert.doesNotMatch(js, /Coming soon/i);
  assert.doesNotMatch(js, /hasCredential/);
  assert.doesNotMatch(js, /Store token/);
  assert.doesNotMatch(js, /Bumper (?:blocks|inspects) git/i);
});

test("Phase 5: Connections are labels only; no credential API; secrets purged at startup", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase5-git-"));
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
        repos: ["github.com/acme/app"],
        gitConnectionId: "client-a",
        room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked" },
      },
    },
  }));
  writeFileSync(statePath, JSON.stringify({ activeContext: "demo" }));

  // Pre-existing secrets store must be deleted on app start.
  const secretsPath = join(dirname(statePath), "git-connection-secrets.json");
  writeFileSync(secretsPath, JSON.stringify({ "connection:client-a": "SECRET_TOKEN_VALUE" }), { mode: 0o600 });
  assert.equal(existsSync(secretsPath), true);

  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = cfg;
  process.env.BUMPER_STATE = statePath;

  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(repoRoot, "dist", "cli.js"));
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal(existsSync(secretsPath), false, "startup must delete git-connection-secrets.json");

  const state = await fetch(`${handle.url}/api/state`).then((r) => r.json());
  const blob = JSON.stringify(state);
  assert.doesNotMatch(blob, /SECRET_TOKEN_VALUE/);
  assert.doesNotMatch(blob, /connection:client-a/);
  assert.equal(state.gitConnections[0].id, "client-a");
  assert.equal(state.gitConnections[0].token, undefined);
  assert.equal("hasCredential" in state.gitConnections[0], false);
  assert.equal(state.contexts.demo.gitConnectionId, "client-a");
  assert.equal(state.contexts.demo.gitConnection.host, "github.com");
  assert.equal("hasCredential" in (state.contexts.demo.gitConnection || {}), false);
  assert.equal(state.contexts.demo.repos, undefined);

  // Credential routes must not accept tokens anymore.
  const postCred = await fetch(`${handle.url}/api/git-connections/credential`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "client-a", token: "SHOULD_NOT_STORE" }),
  });
  assert.notEqual(postCred.status, 200);
  const delCred = await fetch(`${handle.url}/api/git-connections/credential`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "client-a" }),
  });
  assert.notEqual(delCred.status, 200);
  assert.equal(existsSync(secretsPath), false);

  // Events line for purge must not contain token material.
  const events = readEvents({ limit: 50 });
  const purge = events.find((e) => String(e.target || "").includes("Git Connection secrets"));
  assert.ok(purge, "purge should log an Events line");
  assert.doesNotMatch(JSON.stringify(purge), /SECRET_TOKEN_VALUE|SHOULD_NOT_STORE/);
});

test("Phase 5: the Sandbox mounts no credential door at all", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase5-broker-"));
  try {
    const workspace = join(root, "ws");
    mkdirSync(workspace, { recursive: true });
    const context = {
      mode: "read-write",
      repos: ["github.com/acme/app"],
      gitConnectionId: "client-a",
      readPaths: [],
      writePaths: [],
      denyReadPaths: [],
      denyWritePaths: [],
      room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked", doors: [] },
    };
    const spec = roomSpecForContext(context, workspace);
    for (const door of spec.doors || []) {
      assert.notEqual(door.roomPath, "/bumper", "the credential broker door is gone for good");
      assert.doesNotMatch(door.hostPath, /\/\.ssh(?:\/|$)/);
      assert.doesNotMatch(door.hostPath, /git-connection-secrets/);
      assert.doesNotMatch(door.hostPath, /tokens\.json/);
      assert.doesNotMatch(door.hostPath, /room-broker/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5: listGitConnections never exposes token or hasCredential", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase5-list-"));
  try {
    const cfg = join(root, "cfg.json");
    writeFileSync(cfg, JSON.stringify({
      gitConnections: { "client-a": { name: "A", provider: "github", host: "github.com", identity: "" } },
      contexts: {},
    }));
    process.env.BUMPER_CONFIG = cfg;
    process.env.BUMPER_STATE = join(root, "state.json");
    const { config } = loadConfig(cfg);
    const listed = listGitConnections(config);
    assert.equal(listed[0].id, "client-a");
    assert.equal("token" in listed[0], false);
    assert.equal("hasCredential" in listed[0], false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5: purgeLegacyGitConnectionSecrets removes the file once", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase5-purge-"));
  const statePath = join(root, "state.json");
  writeFileSync(statePath, "{}");
  const previous = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = statePath;
  try {
    const path = gitConnectionSecretsPath();
    writeFileSync(path, JSON.stringify({ "connection:x": "tok" }), { mode: 0o600 });
    assert.equal(purgeLegacyGitConnectionSecrets(), true);
    assert.equal(existsSync(path), false);
    assert.equal(purgeLegacyGitConnectionSecrets(), false);
  } finally {
    if (previous === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5: GET /api/git/workspace returns structured host git status", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase5-ws-"));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  writeFileSync(join(workspace, "readme.txt"), "hello\n");
  execFileSync("git", ["add", "readme.txt"], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "first"], { cwd: workspace });
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();

  const cfg = join(root, "bumper.config.json");
  const statePath = join(root, "state.json");
  writeFileSync(cfg, JSON.stringify({
    webPort: 0,
    defaultContext: "demo",
    contexts: {
      demo: {
        workspace,
        mode: "read-write",
        room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked" },
      },
    },
  }));
  writeFileSync(statePath, JSON.stringify({ activeContext: "demo" }));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = cfg;
  process.env.BUMPER_STATE = statePath;

  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(repoRoot, "dist", "cli.js"));
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  const status = await fetch(`${handle.url}/api/git/workspace?context=demo`).then((r) => r.json());
  assert.equal(status.kind, "ready");
  assert.equal(status.branch, branch);
  assert.equal(status.upstream, null);
  assert.ok(status.hostCommand.includes("git push --set-upstream"));
  assert.ok(status.hostCommand.includes(workspace));
  assert.ok(status.commits.length >= 1);
  assert.equal(status.commits[0].subject, "first");
  // Never invent placeholders
  assert.doesNotMatch(status.hostCommand, /<your-|<repo>|example\.com\/org/i);

  const unbound = await readGitWorkspaceStatus("");
  assert.equal(unbound.kind, "unbound");
  const notRepo = await readGitWorkspaceStatus(root);
  assert.equal(notRepo.kind, "not-repo");
  assert.match(notRepo.hostGuidance || "", /git init/);
});
