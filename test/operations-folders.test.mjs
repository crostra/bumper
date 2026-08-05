/**
 * W1-2: Project folders as a shared operation.
 *
 * The sharing rules already lived in src/folders.ts. What is new is that the
 * *sequencing* around them — refuse while a Session is live, refuse an empty
 * share, then write — sits in one place that `/api/folders/apply` and
 * `bumper folders` both call, instead of inline in the HTTP handler where only
 * the GUI could reach it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  accessLabel,
  addProjectFolder,
  applyFolderPatch,
  applyProjectFolders,
  describeProjectFolders,
  describeShareRow,
  removeProjectFolder,
} from "../dist/operations/folders.js";
import { mergeSessionRefs } from "../dist/operations/running-sessions.js";
import { classifyHostPath } from "../dist/folders.js";
import { isOperationError } from "../dist/operations/error.js";
import { applyCreatedProject } from "../dist/project.js";

const CLI = join(process.cwd(), "dist", "cli.js");

function projectAt(workspace, name = "Demo") {
  const config = { contexts: {} };
  applyCreatedProject(config, { name, workspace });
  return config;
}

function commit(config, name, result) {
  config.contexts[name] = applyFolderPatch(config.contexts[name], result.patch);
  return config.contexts[name];
}

test("a new Project shares its project folder and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-folders-"));
  try {
    const config = projectAt(root);
    const view = describeProjectFolders({ config, projectName: "Demo" });
    assert.equal(view.rows.length, 1);
    assert.equal(view.rows[0].kind, "project-root");
    assert.equal(describeShareRow(view.rows[0]).label, ".");
    assert.equal(accessLabel("read-write"), "Can edit");
    assert.equal(accessLabel("read-only"), "Look only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adding a folder outside the project keeps both, with its own access", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-folders-"));
  try {
    const outside = mkdtempSync(join(tmpdir(), "bumper-outside-"));
    try {
      const config = projectAt(root);
      const result = addProjectFolder({
        config, projectName: "Demo", hostPath: outside,
        access: "read-only", runningSessions: [],
      });
      commit(config, "Demo", result);

      const rows = describeProjectFolders({ config, projectName: "Demo" }).rows;
      const outsideRow = rows.find((row) => row.kind === "outside");
      assert.ok(outsideRow, "the outside folder should be shared");
      assert.equal(outsideRow.access, "read-only");
      // Read-only shares land in readPaths, never writePaths.
      assert.ok(config.contexts.Demo.readPaths.some((p) => p.includes("bumper-outside-")));
      assert.deepEqual(config.contexts.Demo.writePaths, []);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sharing the project root replaces subfolder shares (rule R1)", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-folders-"));
  try {
    mkdirSync(join(root, "src"));
    const config = projectAt(root);

    // Narrow to one subfolder first.
    commit(config, "Demo", applyProjectFolders({
      config, projectName: "Demo", runningSessions: [],
      draft: {
        editor: "advanced", workspaceAccess: "read-write", workspaceShare: "selected",
        entries: [{ path: "src", access: "read-write" }],
        extraReadPaths: [], extraWritePaths: [],
      },
    }));
    assert.deepEqual(
      describeProjectFolders({ config, projectName: "Demo" }).rows.map((r) => r.kind),
      ["inside"],
    );

    // Then share the whole project folder: the subfolder row is redundant.
    // Absolute, because a relative path resolves against cwd (shell convention),
    // and this unit test does not run inside the temp workspace.
    const widened = addProjectFolder({
      config, projectName: "Demo", hostPath: root, access: "read-write", runningSessions: [],
    });
    commit(config, "Demo", widened);
    assert.deepEqual(
      describeProjectFolders({ config, projectName: "Demo" }).rows.map((r) => r.kind),
      ["project-root"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live Session blocks a folder change from either entry point", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-folders-"));
  try {
    const config = projectAt(root);
    const running = [{ id: "sess-1", context: "Demo", agentName: "Claude Code", status: "running" }];
    assert.throws(
      () => addProjectFolder({
        config, projectName: "Demo", hostPath: root, access: "read-only",
        runningSessions: running,
      }),
      (err) => {
        assert.ok(isOperationError(err));
        assert.equal(err.code, "conflict", "a live Session is a conflict, not bad input");
        assert.match(err.message, /Claude Code/);
        return true;
      },
    );
    // A Session for a different Project is not this Project's business.
    const other = [{ id: "sess-2", context: "Other", agentName: "Codex", status: "running" }];
    assert.doesNotThrow(() => addProjectFolder({
      config, projectName: "Demo", hostPath: root, access: "read-only", runningSessions: other,
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a rule refusal carries the commands that unblock it", () => {
  // The rules are worded for a board you click ("Remove the project folder row
  // first"). In a terminal that sentence is a dead end without the command.
  const root = mkdtempSync(join(tmpdir(), "bumper-folders-"));
  try {
    mkdirSync(join(root, "src"));
    const config = projectAt(root);
    assert.throws(
      () => addProjectFolder({
        config, projectName: "Demo", hostPath: join(root, "src"),
        access: "read-write", runningSessions: [],
      }),
      (err) => {
        assert.ok(isOperationError(err));
        assert.equal(err.code, "invalid");
        assert.ok(err.fix.length >= 1, "a refusal with an obvious remedy must name it");
        assert.match(err.fix[0], /bumper folders remove \./);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symlinked path still classifies as the project folder", () => {
  // macOS puts /tmp and /var behind symlinks, so a stored workspace is a
  // realpath while a typed path is not. Comparing them raw made a folder that
  // *is* the project folder look like some unrelated folder elsewhere on the
  // Mac — for the GUI's picker as much as for the CLI.
  const root = mkdtempSync(join(tmpdir(), "bumper-symlink-"));
  try {
    const real = join(root, "real-repo");
    mkdirSync(real);
    mkdirSync(join(real, "src"));
    const link = join(root, "linked-repo");
    symlinkSync(real, link);

    // A Project bound through the symlink stores the resolved path…
    const config = projectAt(link);
    const stored = config.contexts.Demo.workspace;
    assert.ok(stored.endsWith("real-repo"), "the stored workspace is the realpath");

    // …and the symlinked spelling must still be recognised as that folder.
    assert.equal(classifyHostPath(link, stored).kind, "project-root");
    const inside = classifyHostPath(join(link, "src"), stored);
    assert.equal(inside.kind, "inside");
    assert.equal(inside.path, "src");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session sources merge without double-counting an id", () => {
  const guiList = [{ id: "a", context: "Demo", status: "running" }];
  const leases = [
    { id: "a", context: "Demo", status: "running" },
    { id: "b", context: "Demo", status: "running" },
  ];
  assert.deepEqual(mergeSessionRefs(guiList, leases).map((r) => r.id), ["a", "b"]);
  assert.deepEqual(mergeSessionRefs([], []), []);
});

test("removing the last share is refused, not silently applied", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-folders-"));
  try {
    const config = projectAt(root);
    assert.throws(
      () => removeProjectFolder({ config, projectName: "Demo", hostPath: root, runningSessions: [] }),
      (err) => {
        assert.ok(isOperationError(err));
        assert.equal(err.code, "invalid");
        assert.match(err.message, /Share at least one folder/);
        return true;
      },
    );
    // Removing something that was never shared says so rather than no-op'ing.
    assert.throws(
      () => removeProjectFolder({ config, projectName: "Demo", hostPath: "/nowhere", runningSessions: [] }),
      (err) => isOperationError(err) && err.code === "not-found",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bumper folders gives a CLI-only user the folder dial", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-folders-cli-"));
  try {
    const workspace = join(root, "my-repo");
    mkdirSync(workspace);
    mkdirSync(join(workspace, "src"));
    const notes = join(root, "notes");
    mkdirSync(notes);
    const configPath = join(root, "config.json");
    const env = { ...process.env, BUMPER_CONFIG: configPath, BUMPER_STATE: join(root, "state", "state.json") };
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: workspace });

    assert.equal(run("init").status, 0);

    const list = run("folders", "list");
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /Shared with the Sandbox:/);
    assert.match(list.stdout, /Can edit/);
    assert.match(list.stdout, /Everything else on this Mac: Not shared\./);

    const add = run("folders", "add", notes, "--read-only");
    assert.equal(add.status, 0, add.stderr);
    assert.match(add.stdout, /now sharing/);
    assert.match(add.stdout, /Look only/);
    assert.match(add.stdout, /Applies to new Sessions/);

    const written = JSON.parse(readFileSync(configPath, "utf8")).contexts["my-repo"];
    assert.ok(written.readPaths.some((p) => p.endsWith("notes")), "read-only share must be a read path");
    assert.deepEqual(written.writePaths, [], "a Look only share must not become writable");
    assert.equal(written.room.enabled, true, "the patch must not disable the Sandbox");

    const remove = run("folders", "remove", notes);
    assert.equal(remove.status, 0, remove.stderr);
    assert.match(remove.stdout, /stopped sharing/);

    // The refusals reach the terminal with a next command.
    const empty = run("folders", "remove", ".");
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /Share at least one folder/);
    assert.match(empty.stderr, /Next:/);

    const help = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
    assert.match(help.stdout, /bumper folders add <path>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bumper project list|create|remove manages Projects without the app", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-project-cli-"));
  try {
    const workspace = join(root, "my-repo");
    mkdirSync(workspace);
    const second = join(root, "other-repo");
    mkdirSync(second);
    const configPath = join(root, "config.json");
    const env = { ...process.env, BUMPER_CONFIG: configPath, BUMPER_STATE: join(root, "state", "state.json") };
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd: workspace });

    assert.equal(run("init").status, 0);

    const created = run("project", "create", "Second", "--path", second);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /Created Project "Second"/);

    const list = run("project", "list");
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /my-repo/);
    assert.match(list.stdout, /Second/);

    // A duplicate name is a conflict, with somewhere to go.
    const dup = run("project", "create", "Second", "--path", second);
    assert.notEqual(dup.status, 0);
    assert.match(dup.stderr, /already exists/);
    assert.match(dup.stderr, /Next:/);

    const removed = run("project", "remove", "Second");
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /Removed Project "Second"/);
    // Removing a Project must never suggest the folder went anywhere.
    assert.match(removed.stdout, /Your folder is untouched/);
    assert.ok(!("Second" in JSON.parse(readFileSync(configPath, "utf8")).contexts));

    const missing = run("project", "remove", "Nope");
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Unknown project "Nope"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
