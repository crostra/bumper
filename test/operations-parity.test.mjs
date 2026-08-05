/**
 * The surfaces that were GUI-only until the parity audit: prove, GitHub
 * repository binding, permission setups, development Session controls, prefs,
 * and stored logins.
 *
 * VM-backed evidence (`bumper prove` against a real microVM) is gated behind
 * BUMPER_VM_TESTS=1 like the other boundary proofs — it boots a Linux VM and
 * needs the container services running. Everything else runs headless.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  GITHUB_APP_BROWSER_REASON,
  bindProjectRepository,
  listGitHubConnections,
  storedInstallations,
  summarizeRefresh,
  unbindProjectRepository,
} from "../dist/operations/github.js";
import {
  applySetupToProject,
  deleteSetup,
  listSetups,
  saveSetup,
} from "../dist/operations/setups.js";
import { setDevelopmentSessionAccess } from "../dist/operations/development.js";
import { RETENTION_VALUES, retentionSentence, setPref } from "../dist/operations/prefs.js";
import { isOperationError } from "../dist/operations/error.js";
import { applyCreatedProject } from "../dist/project.js";
import { projectGitBindings } from "../dist/git-repositories.js";

const CLI = join(process.cwd(), "dist", "cli.js");
const VM = process.env.BUMPER_VM_TESTS === "1";

function projectAt(workspace, name = "Demo") {
  const config = { contexts: {}, githubApps: {}, permissionSetups: {} };
  applyCreatedProject(config, { name, workspace });
  return config;
}

function connectedApp(config, { owner = "crostra", repo = "bumper", selection = "selected" } = {}) {
  config.githubApps = {
    "gh-1": {
      ownerLogin: owner,
      ownerType: "Organization",
      installations: [{
        id: 42,
        accountLogin: owner,
        accountType: "Organization",
        repositorySelection: selection,
        repositories: [{ id: 7, fullName: `${owner}/${repo}`, private: false }],
      }],
    },
  };
  return config;
}

/* -------------------------------------------------------------- GitHub ---- */

test("binding a repository writes a provable binding at the level asked for", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-gh-"));
  try {
    const config = connectedApp(projectAt(root));
    const result = bindProjectRepository({
      config, projectName: "Demo",
      repository: "https://github.com/crostra/bumper",
      capability: "write",
      isConnected: () => true,
    });
    assert.equal(result.fullName, "crostra/bumper");
    assert.equal(result.capability, "write");
    assert.equal(result.installationId, 42);
    assert.equal(result.repositoryId, 7);
    // The binding must be readable back through the canonical reader.
    const stored = projectGitBindings(config.contexts.Demo);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].capability, "write");

    unbindProjectRepository({ config, projectName: "Demo", repository: "crostra/bumper" });
    assert.deepEqual(projectGitBindings(config.contexts.Demo), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unprovable repository is refused rather than stored to fail later", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-gh-"));
  try {
    const config = connectedApp(projectAt(root));

    // Owner Bumper has no App for.
    assert.throws(
      () => bindProjectRepository({
        config, projectName: "Demo",
        repository: "https://github.com/someone-else/thing",
        capability: "read", isConnected: () => true,
      }),
      (err) => {
        assert.ok(isOperationError(err));
        assert.equal(err.code, "invalid");
        assert.ok(err.fix.some((line) => line.includes("bumper github connect")));
        return true;
      },
    );

    // Right owner, repository not in the installation.
    assert.throws(
      () => bindProjectRepository({
        config, projectName: "Demo",
        repository: "https://github.com/crostra/not-added",
        capability: "read", isConnected: () => true,
      }),
      (err) => isOperationError(err) && err.fix.some((line) => line.includes("bumper github refresh")),
    );

    // Not a repository URL at all.
    assert.throws(
      () => bindProjectRepository({
        config, projectName: "Demo", repository: "nonsense",
        capability: "read", isConnected: () => true,
      }),
      (err) => isOperationError(err) && err.code === "invalid",
    );

    // Unknown capability rung.
    assert.throws(
      () => bindProjectRepository({
        config, projectName: "Demo",
        repository: "https://github.com/crostra/bumper",
        capability: "admin", isConnected: () => true,
      }),
      (err) => isOperationError(err) && /Unknown Git access level/.test(err.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the installation mapping both entry points refresh through keeps every field", () => {
  const fetched = [{
    id: 9, account: "acme", accountType: "Organization",
    repositorySelection: "all", settingsUrl: "https://github.com/x",
    repositories: [{ id: 1, fullName: "acme/one", private: true }],
  }];
  const stored = storedInstallations(fetched);
  assert.equal(stored[0].id, 9);
  assert.equal(stored[0].accountLogin, "acme");
  assert.equal(stored[0].repositorySelection, "all");
  assert.equal(stored[0].settingsUrl, "https://github.com/x");
  assert.deepEqual(stored[0].repositories, [{ id: 1, fullName: "acme/one", private: true }]);

  const summary = summarizeRefresh("gh-1", fetched);
  assert.equal(summary.repositories, 1);
  assert.equal(summary.allRepositories, true);
});

test("the browser step is named, and only that step", () => {
  // Everything else about GitHub is local; conflating them is what left
  // repository binding unreachable from a terminal.
  assert.match(GITHUB_APP_BROWSER_REASON, /manifest flow/);
  assert.match(GITHUB_APP_BROWSER_REASON, /nothing is sent anywhere else/);
});

test("listGitHubConnections reports what is actually usable", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-gh-"));
  try {
    const config = connectedApp(projectAt(root));
    const [connection] = listGitHubConnections(config, () => false);
    assert.equal(connection.connected, false, "a stored App with no key is not connected");
    assert.equal(connection.installations[0].repositoryCount, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------- setups ---- */

test("a saved setup carries a boundary to another Project", () => {
  const a = mkdtempSync(join(tmpdir(), "bumper-setup-a-"));
  const b = mkdtempSync(join(tmpdir(), "bumper-setup-b-"));
  try {
    const config = projectAt(a, "Source");
    applyCreatedProject(config, { name: "Target", workspace: b });
    config.contexts.Source.room.egress = "blocked";
    config.contexts.Target.room.egress = "open";

    saveExpect(() => saveSetup({ config, name: "locked-down", fromProject: "Source" }));
    assert.ok(listSetups(config).some((setup) => setup.name === "locked-down"));

    const result = applySetupToProject({
      config, name: "locked-down", projectName: "Target", runningSessions: [],
    });
    Object.assign(config.contexts.Target, result.applied);
    assert.equal(config.contexts.Target.room.egress, "blocked", "the boundary travelled");

    deleteSetup({ config, name: "locked-down" });
    assert.ok(!listSetups(config).some((setup) => setup.name === "locked-down" && !setup.builtin));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
  function saveExpect(fn) { fn(); }
});

test("applying a setup is blocked by a live Session, like any boundary change", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-setup-"));
  try {
    const config = projectAt(root);
    saveSetup({ config, name: "snap", fromProject: "Demo" });
    assert.throws(
      () => applySetupToProject({
        config, name: "snap", projectName: "Demo",
        runningSessions: [{ id: "s1", context: "Demo", agentName: "Claude Code", status: "running" }],
      }),
      (err) => isOperationError(err) && err.code === "conflict",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("built-in templates cannot be overwritten or removed", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-setup-"));
  try {
    const config = projectAt(root);
    const builtin = listSetups(config).find((setup) => setup.builtin);
    assert.ok(builtin, "expected at least one built-in template");
    assert.throws(
      () => saveSetup({ config, name: builtin.name, fromProject: "Demo" }),
      (err) => isOperationError(err) && err.code === "invalid",
    );
    assert.throws(
      () => deleteSetup({ config, name: builtin.name }),
      (err) => isOperationError(err) && err.code === "invalid",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------- development ---- */

test("a development control on a dead Session refuses rather than pretending", () => {
  assert.throws(
    () => setDevelopmentSessionAccess({ sessionId: "no-such-session-id", capability: "preview", enabled: false }),
    (err) => isOperationError(err) && err.code === "conflict",
  );
  assert.throws(
    () => setDevelopmentSessionAccess({ sessionId: "bad", capability: "preview", enabled: false }),
    (err) => isOperationError(err) && err.code === "invalid",
  );
  assert.throws(
    () => setDevelopmentSessionAccess({ sessionId: "a-valid-looking-id", capability: "nope", enabled: false }),
    (err) => isOperationError(err) && err.code === "invalid",
  );
});

/* --------------------------------------------------------------- prefs ---- */

test("event retention can be turned off from a terminal", () => {
  // The local record is a privacy control; a GUI-only switch is the wrong
  // default for a tool whose pitch is that nothing leaves the Mac.
  assert.ok(RETENTION_VALUES.includes("off"));
  assert.match(retentionSentence("off"), /No event metadata is kept/);
  assert.throws(
    () => setPref({ key: "eventRetention", value: "forever" }),
    (err) => isOperationError(err) && err.code === "invalid",
  );
  assert.throws(
    () => setPref({ key: "nope", value: "x" }),
    (err) => isOperationError(err) && err.code === "invalid",
  );
});

/* ----------------------------------------------------------------- CLI ---- */

test("the parity commands work from a terminal", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-parity-cli-"));
  try {
    const workspace = join(root, "my-repo");
    mkdirSync(workspace);
    const configPath = join(root, "config.json");
    const env = {
      ...process.env,
      BUMPER_CONFIG: configPath,
      BUMPER_STATE: join(root, "state", "state.json"),
      BUMPER_NO_CONTAINER_AUTOSTART: "1",
    };
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: workspace });

    assert.equal(run("init").status, 0);

    const github = run("github", "list");
    assert.equal(github.status, 0, github.stderr);
    assert.match(github.stdout, /No GitHub connections yet/);
    assert.match(github.stdout, /manifest flow/);

    const setups = run("setup", "list");
    assert.equal(setups.status, 0, setups.stderr);
    assert.match(setups.stdout, /built-in/);

    const saved = run("setup", "save", "mine");
    assert.equal(saved.status, 0, saved.stderr);
    assert.match(saved.stdout, /Saved "mine"/);
    assert.ok(JSON.parse(readFileSync(configPath, "utf8")).permissionSetups.mine);

    const dev = run("dev", "sessions");
    assert.equal(dev.status, 0, dev.stderr);
    assert.match(dev.stdout, /No Development Sessions/);

    const prefs = run("prefs");
    assert.equal(prefs.status, 0, prefs.stderr);
    assert.match(prefs.stdout, /eventRetention/);

    const login = run("login", "list");
    assert.equal(login.status, 0, login.stderr);

    // The dead-code case that started this: an operation with no command.
    const exported = run("log", "--export");
    assert.equal(exported.status, 0, exported.stderr);
    assert.doesNotThrow(() => JSON.parse(exported.stdout), "log --export must emit JSON");

    // Binding a repository with no GitHub App says which step is missing.
    const bind = run("git", "repo", "add", "https://github.com/crostra/bumper");
    assert.notEqual(bind.status, 0);
    assert.match(bind.stderr, /bumper github connect/);

    const help = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
    for (const command of [/bumper prove/, /bumper github list/, /bumper setup list/, /bumper dev sessions/, /bumper login list/, /bumper prefs/, /bumper git repo add/]) {
      assert.match(help.stdout, command);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VM: bumper prove --sealed runs a real Sandbox and reports what held", { skip: !VM }, async () => {
  const { proveSealedRoom } = await import("../dist/operations/prove.js");
  const result = await proveSealedRoom();
  assert.equal(result.available, true, `Apple container unavailable: ${result.detail}`);
  assert.ok(result.results.length > 0, "the proof must actually run probes");
  for (const probe of result.results) {
    assert.equal(typeof probe.contained, "boolean");
    assert.ok(probe.evidence.length > 0, `${probe.id} must carry evidence, not just a verdict`);
  }
  const escaped = result.results.filter((probe) => !probe.contained);
  assert.deepEqual(escaped.map((p) => p.id), [], "the sealed room must contain every probe");
});
