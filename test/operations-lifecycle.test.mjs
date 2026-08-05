/**
 * Phase 3–4: Git Sessions, MCP bindings, and the lifecycle commands.
 *
 * These are the last surfaces that existed only behind the GUI. The Git one
 * carries the most weight: turning a live Session's access Off has to take the
 * token back, and the CLI must leave the same audit record the app does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  GIT_WRITE_WINDOW_MS,
  configuredGitAccess,
  describeProjectGit,
  listGitSessions,
  mergeSweepConnections,
  setGitSessionAccess,
} from "../dist/operations/git.js";
import {
  MCP_OUTSIDE_SANDBOX_NOTE,
  bindProjectMcp,
  describeProjectMcp,
  listMcpConnections,
  unbindProjectMcp,
} from "../dist/operations/mcp.js";
import {
  describeFeedback,
  previewUninstall,
  restoreBackup,
} from "../dist/operations/lifecycle.js";
import { isOperationError } from "../dist/operations/error.js";
import { applyCreatedProject } from "../dist/project.js";
import { createGitSessionLease, removeGitSessionLease } from "../dist/git-session-lease.js";

const CLI = join(process.cwd(), "dist", "cli.js");

function projectAt(workspace, name = "Demo") {
  const config = { contexts: {}, mcpConnections: {}, mcpIntegrations: {} };
  applyCreatedProject(config, { name, workspace });
  return config;
}

/* ---------------------------------------------------------------- Git ---- */

test("a Project with no repository bound allows no Git access", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-git-"));
  try {
    const config = projectAt(root);
    assert.equal(configuredGitAccess(config, "Demo"), "none");
    const view = describeProjectGit(config, "Demo");
    assert.equal(view.ceiling, "none");
    assert.deepEqual(view.bindings, []);
    assert.throws(
      () => describeProjectGit(config, "Nope"),
      (err) => isOperationError(err) && err.code === "not-found",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Session id that is not live refuses instead of pretending", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-git-"));
  try {
    const config = projectAt(root);
    await assert.rejects(
      () => setGitSessionAccess({
        config, sessionId: "not-a-real-session-id", action: "disable",
        revokeSession: async () => ({ revoked: 0, pending: 0 }),
      }),
      (err) => {
        assert.ok(isOperationError(err));
        assert.equal(err.code, "conflict");
        assert.match(err.message, /no longer live/);
        return true;
      },
    );
    // A malformed id is bad input, not a state conflict.
    await assert.rejects(
      () => setGitSessionAccess({
        config, sessionId: "short", action: "disable",
        revokeSession: async () => ({ revoked: 0, pending: 0 }),
      }),
      (err) => isOperationError(err) && err.code === "invalid",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("turning a live Session Off revokes across every connection it could have used", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-git-"));
  const stateDir = mkdtempSync(join(tmpdir(), "bumper-state-"));
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(stateDir, "state.json");
  const sessionId = "session-abcdefgh-1234";
  try {
    const config = projectAt(root);
    createGitSessionLease({
      id: sessionId,
      pid: process.pid,
      projectName: "Demo",
      agentId: "claude",
      agentName: "Claude Code",
      repository: "crostra/bumper",
      connectionId: "conn-a",
      enabled: true,
    });

    const asked = [];
    const result = await setGitSessionAccess({
      config, sessionId, action: "disable",
      revokeSession: async (connectionId, id) => {
        asked.push(connectionId);
        assert.equal(id, sessionId);
        return { revoked: 1, pending: 0 };
      },
    });

    assert.equal(result.effectiveAccess, "none");
    assert.equal(result.enabled, false);
    assert.equal(result.writeUntil, "");
    assert.ok(asked.includes("conn-a"), "the lease's own connection must be swept");
    assert.equal(result.revoked, 1);
    assert.deepEqual(result.pendingConnections, []);
  } finally {
    removeGitSessionLease(sessionId);
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("a connection whose revoke fails goes on the retry list, never dropped", () => {
  // Losing one here means a live token outlives an explicit Off.
  assert.deepEqual(mergeSweepConnections(undefined, ["a"]), ["a"]);
  assert.deepEqual(mergeSweepConnections(["a"], ["b"]), ["a", "b"]);
  assert.deepEqual(mergeSweepConnections(["a"], ["a"]), ["a"]);
  assert.deepEqual(mergeSweepConnections("not-an-array", ["a"]), ["a"]);
});

test("the write window is the same 15 minutes the GUI grants", () => {
  assert.equal(GIT_WRITE_WINDOW_MS, 15 * 60_000);
});

test("listGitSessions is empty when nothing has launched", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-git-"));
  const stateDir = mkdtempSync(join(tmpdir(), "bumper-state-"));
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(stateDir, "state.json");
  try {
    assert.deepEqual(listGitSessions(projectAt(root)), []);
  } finally {
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- MCP ---- */

test("binding an MCP Connection replaces the one for the same integration", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-mcp-"));
  try {
    const config = projectAt(root);
    config.mcpIntegrations = { slack: { name: "Slack" } };
    config.mcpConnections = {
      "slack-work": { name: "Slack (work)", integrationId: "slack", values: {}, description: "" },
      "slack-personal": { name: "Slack (personal)", integrationId: "slack", values: {}, description: "" },
    };

    const first = bindProjectMcp({ config, projectName: "Demo", connectionId: "slack-work" });
    assert.equal(first.replaced, undefined);
    // At most one Connection per Integration — the second replaces the first.
    const second = bindProjectMcp({ config, projectName: "Demo", connectionId: "slack-personal" });
    assert.equal(second.replaced, "slack-work");
    assert.deepEqual(config.contexts.Demo.mcpBindings, { slack: "slack-personal" });

    const view = describeProjectMcp(config, "Demo");
    assert.equal(view.bindings.length, 1);
    // The honest limit travels with the operation, not per surface.
    assert.match(view.note, /outside the Sandbox/);
    assert.equal(view.note, MCP_OUTSIDE_SANDBOX_NOTE);
    // Only tools with a verified per-session flag receive the Hub.
    const claude = view.reachedBy.find((a) => a.agentId === "claude");
    const grok = view.reachedBy.find((a) => a.agentId === "grok");
    assert.equal(claude.supported, true);
    assert.equal(grok.supported, false, "grok has no per-session MCP flag; do not claim it does");

    assert.equal(listMcpConnections(config).find((c) => c.id === "slack-personal").boundTo[0], "Demo");

    unbindProjectMcp({ config, projectName: "Demo", connectionId: "slack-personal" });
    assert.deepEqual(config.contexts.Demo.mcpBindings, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binding an unknown Connection says where Connections come from", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-mcp-"));
  try {
    const config = projectAt(root);
    assert.throws(
      () => bindProjectMcp({ config, projectName: "Demo", connectionId: "nope" }),
      (err) => {
        assert.ok(isOperationError(err));
        assert.equal(err.code, "not-found");
        assert.ok(err.fix.some((line) => line.includes("bumper mcp list")));
        return true;
      },
    );
    assert.throws(
      () => unbindProjectMcp({ config, projectName: "Demo", connectionId: "nope" }),
      (err) => isOperationError(err) && err.code === "not-found",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------- lifecycle ---- */

test("uninstall never lists a project folder among what it removes", () => {
  const preview = previewUninstall({ includeLocalData: true, runningSessions: [] });
  assert.ok(preview.neverDeletes.some((line) => /workspace/i.test(line)));
  for (const target of preview.localDataPaths) {
    assert.match(target, /\.bumper|state|config/i, `${target} does not look like Bumper's own state`);
  }
});

test("uninstall refuses while a Session is running", async () => {
  const { performUninstall } = await import("../dist/operations/lifecycle.js");
  assert.throws(
    () => performUninstall({
      includeLocalData: true,
      runningSessions: [{ id: "s1", context: "Demo", agentName: "Claude Code", status: "running" }],
    }),
    (err) => {
      assert.ok(isOperationError(err));
      assert.equal(err.code, "conflict");
      assert.match(err.message, /still running/);
      return true;
    },
  );
});

test("restoring a backup that does not exist says so", () => {
  assert.throws(
    () => restoreBackup({ backupId: "config.nope.json" }),
    (err) => isOperationError(err) && err.code === "not-found",
  );
  assert.throws(
    () => restoreBackup({ backupId: "" }),
    (err) => isOperationError(err) && err.code === "invalid",
  );
});

test("feedback is a URL plus local facts — nothing is sent", () => {
  const target = describeFeedback({
    kind: "discussion", bumperVersion: "0.6.0",
    platform: "darwin", arch: "arm64", nodeVersion: "24.10.0",
    containerDetail: "container CLI version 1.1.0",
  });
  assert.match(target.url, /^https:\/\/github\.com\/crostra\/bumper\/discussions$/);
  assert.ok(target.context.some((line) => line.includes("0.6.0")));
  assert.ok(target.context.some((line) => line.includes("darwin/arm64")));
  assert.equal(describeFeedback({
    kind: "bug", bumperVersion: "0", platform: "darwin", arch: "arm64", nodeVersion: "24",
  }).url.includes("/issues/"), true);
});

/* ---------------------------------------------------------------- CLI ---- */

test("the lifecycle commands work from a terminal", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-lifecycle-cli-"));
  try {
    const workspace = join(root, "my-repo");
    mkdirSync(workspace);
    const configPath = join(root, "config.json");
    const env = { ...process.env, BUMPER_CONFIG: configPath, BUMPER_STATE: join(root, "state", "state.json") };
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: workspace });

    assert.equal(run("init").status, 0);

    const git = run("git", "status");
    assert.equal(git.status, 0, git.stderr);
    assert.match(git.stdout, /Highest Git access this Project allows: none/);
    assert.match(git.stdout, /GitHub enforces repository and contents scope/);

    const sessions = run("git", "sessions");
    assert.equal(sessions.status, 0, sessions.stderr);
    assert.match(sessions.stdout, /No Git Sessions/);

    const mcp = run("mcp", "list");
    assert.equal(mcp.status, 0, mcp.stderr);
    assert.match(mcp.stdout, /No MCP Connections/);

    const mcpShow = run("mcp", "show");
    assert.equal(mcpShow.status, 0, mcpShow.stderr);
    assert.match(mcpShow.stdout, /outside the Sandbox/);

    // Uninstall defaults to a dry run — it must not delete on a bare invocation.
    const dry = run("uninstall");
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dry run, nothing has been removed/);
    assert.match(dry.stdout, /Never removed:/);
    assert.match(dry.stdout, /bumper uninstall --yes/);
    assert.ok(readFileSync(configPath, "utf8").length > 0, "a dry run must leave the config alone");

    const backup = run("backup", "list");
    assert.equal(backup.status, 0, backup.stderr);

    const feedback = run("feedback");
    assert.equal(feedback.status, 0, feedback.stderr);
    assert.match(feedback.stdout, /github\.com\/crostra\/bumper\/discussions/);
    assert.match(feedback.stdout, /Bumper sends nothing on its own/);

    const help = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
    for (const command of [/bumper git status\|sessions/, /bumper mcp list\|show\|bind\|unbind/, /bumper uninstall/, /bumper feedback/, /bumper backup/]) {
      assert.match(help.stdout, command);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
