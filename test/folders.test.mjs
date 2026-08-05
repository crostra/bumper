/**
 * Phase 2 Folders — templates, draft/apply, RoomSpec mapping, session stop-gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addShareRow,
  applyFolderDraft,
  assertCanApplyFolders,
  builtinPermissionSetup,
  classifyHostPath,
  doorsFromFolderDraft,
  draftFromContext,
  FOLDER_CAPABILITIES,
  folderDraftFromShareRows,
  folderMatrix,
  folderPolicyDiff,
  isBuiltinTemplateName,
  listBuiltinPermissionSetups,
  normalizeFolderDraft,
  runningSessionsForProject,
  shareRowsFromDraft,
  workspacePresence,
} from "../dist/folders.js";
import { roomSpecForContext } from "../dist/room/spec.js";
import { applyPermissionSetup, resolvePermissionSetup } from "../dist/setups.js";
import { buildRunArgs } from "../dist/room/apple-container.js";

test("built-in Permission templates match decision table and are immutable names", () => {
  const all = listBuiltinPermissionSetups();
  assert.deepEqual(Object.keys(all).sort(), [
    "Offline edit",
    "Offline review",
    "Standard development",
  ]);
  assert.equal(isBuiltinTemplateName("Standard development"), true);
  assert.equal(isBuiltinTemplateName("My custom"), false);

  const standard = builtinPermissionSetup("Standard development");
  assert.equal(standard.mode, "read-write");
  assert.equal(standard.room.egress, "open");
  assert.equal(standard.room.workspaceShare, "whole");

  const offlineEdit = builtinPermissionSetup("Offline edit");
  assert.equal(offlineEdit.mode, "read-write");
  assert.equal(offlineEdit.room.egress, "blocked");

  const offlineReview = builtinPermissionSetup("Offline review");
  assert.equal(offlineReview.mode, "read-only");
  assert.equal(offlineReview.room.egress, "blocked");
});

test("nested override capability stays off until proven", () => {
  assert.equal(FOLDER_CAPABILITIES.nestedOverride, false);
  assert.equal(FOLDER_CAPABILITIES.hiddenWhileMounted, false);
  assert.equal(FOLDER_CAPABILITIES.selectedMounts, true);
  assert.equal(FOLDER_CAPABILITIES.simpleWholeWorkspace, true);
});

test("Simple whole-workspace draft maps to one /workspace door with matching access", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-folders-simple-"));
  try {
    const rw = doorsFromFolderDraft(root, {
      editor: "simple",
      workspaceAccess: "read-write",
      workspaceShare: "whole",
      entries: [],
      extraReadPaths: [],
      extraWritePaths: [],
    });
    assert.equal(rw.length, 1);
    assert.equal(rw[0].roomPath, "/workspace");
    assert.equal(rw[0].access, "read-write");
    assert.equal(rw[0].hostPath, root);

    const ro = doorsFromFolderDraft(root, {
      editor: "simple",
      workspaceAccess: "read-only",
      workspaceShare: "whole",
      entries: [],
      extraReadPaths: [],
      extraWritePaths: [],
    });
    assert.equal(ro[0].access, "read-only");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("share rows project whole and selected insides with R1/R2 rules", () => {
  const whole = normalizeFolderDraft({
    editor: "simple",
    workspaceAccess: "read-write",
    workspaceShare: "whole",
    entries: [],
    extraReadPaths: [],
    extraWritePaths: [],
  });
  const wholeRows = shareRowsFromDraft(whole);
  assert.equal(wholeRows.length, 1);
  assert.equal(wholeRows[0].kind, "project-root");
  assert.equal(wholeRows[0].access, "read-write");

  // Adding inside while root is present is refused (R1).
  const refuse = addShareRow(wholeRows, { kind: "inside", path: "src", access: "read-write" });
  assert.ok(refuse.error);
  assert.equal(refuse.rows.length, 1);

  // Root + inside collapse to root-only when mapping back.
  const collapsed = folderDraftFromShareRows([
    { kind: "project-root", access: "read-only" },
    { kind: "inside", path: "src", access: "read-write" },
  ]);
  assert.equal(collapsed.workspaceShare, "whole");
  assert.equal(collapsed.workspaceAccess, "read-only");
  assert.equal(collapsed.entries.length, 0);

  // Selected insides + outside extras.
  let rows = [];
  rows = addShareRow(rows, { kind: "inside", path: "src", access: "read-write" }).rows;
  rows = addShareRow(rows, { kind: "inside", path: "docs", access: "read-only" }).rows;
  rows = addShareRow(rows, { kind: "outside", hostPath: "/tmp/extra", access: "read-only" }).rows;
  // Child of src refused.
  const child = addShareRow(rows, { kind: "inside", path: "src/lib", access: "read-write" });
  assert.ok(child.error);
  // Parent of docs drops docs.
  const parent = addShareRow(rows, { kind: "inside", path: "docs", access: "read-write" });
  // docs already present
  assert.ok(parent.error);
  rows = addShareRow(
    rows.filter((r) => !(r.kind === "inside" && r.path === "docs")),
    { kind: "inside", path: "docs/public", access: "read-write" },
  ).rows;
  const withParent = addShareRow(rows, { kind: "inside", path: "docs", access: "read-only" });
  assert.ok(!withParent.error);
  assert.ok(withParent.rows.some((r) => r.kind === "inside" && r.path === "docs"));
  assert.ok(!withParent.rows.some((r) => r.kind === "inside" && r.path === "docs/public"));

  const draft = folderDraftFromShareRows(withParent.rows);
  assert.equal(draft.workspaceShare, "selected");
  assert.ok(draft.entries.some((e) => e.path === "src"));
  assert.ok(draft.entries.some((e) => e.path === "docs" && e.access === "read-only"));
  assert.deepEqual(draft.extraReadPaths, ["/tmp/extra"]);

  const classified = classifyHostPath("/tmp/other", "/Users/me/proj");
  assert.equal(classified.kind, "outside");
  assert.equal(classifyHostPath("/Users/me/proj", "/Users/me/proj").kind, "project-root");
  assert.equal(classifyHostPath("/Users/me/proj/src", "/Users/me/proj").kind, "inside");
});

test("Selected mounts produce per-path doors; escape paths are dropped", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-folders-selected-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  try {
    const doors = doorsFromFolderDraft(root, {
      editor: "advanced",
      workspaceAccess: "read-write",
      workspaceShare: "selected",
      entries: [
        { path: "src", access: "read-write" },
        { path: "docs", access: "read-only" },
        { path: "../escape", access: "read-write" },
        { path: "", access: "read-write" },
      ],
      extraReadPaths: [],
      extraWritePaths: [],
    });
    assert.equal(doors.length, 2);
    assert.ok(doors.some((d) => d.roomPath === "/workspace/src" && d.access === "read-write"));
    assert.ok(doors.some((d) => d.roomPath === "/workspace/docs" && d.access === "read-only"));
    assert.ok(!doors.some((d) => d.roomPath === "/workspace"));
    assert.ok(!doors.some((d) => d.roomPath.includes("escape")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("roomSpecForContext uses folder policy for whole and selected shares", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-folders-spec-"));
  const workspace = join(root, "ws");
  mkdirSync(join(workspace, "src"), { recursive: true });
  try {
    const whole = roomSpecForContext(
      {
        mode: "read-only",
        readPaths: [],
        writePaths: [],
        room: {
          enabled: true,
          image: "docker.io/library/alpine:3.20",
          egress: "blocked",
          doors: [],
          workspaceShare: "whole",
          shareSubpaths: [],
          shareEntries: [],
        },
      },
      workspace,
    );
    assert.ok(
      whole.doors.some(
        (d) => d.roomPath === "/workspace" && d.access === "read-only" && d.hostPath === workspace,
      ),
    );

    const selected = roomSpecForContext(
      {
        mode: "read-write",
        readPaths: [],
        writePaths: [],
        room: {
          enabled: true,
          image: "docker.io/library/alpine:3.20",
          egress: "blocked",
          doors: [],
          workspaceShare: "selected",
          shareSubpaths: ["src"],
          shareEntries: [{ path: "src", access: "read-only" }],
        },
      },
      workspace,
    );
    assert.ok(!selected.doors.some((d) => d.roomPath === "/workspace"));
    assert.ok(
      selected.doors.some((d) => d.roomPath === "/workspace/src" && d.access === "read-only"),
    );

    const args = buildRunArgs(selected, ["/bin/true"]);
    assert.ok(args.some((arg) => String(arg).includes("target=/workspace/src,readonly")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyFolderDraft + diff + matrix cover Simple and Advanced", () => {
  const base = {
    mode: "read-write",
    inheritMode: true,
    readPaths: [],
    writePaths: [],
    room: {
      enabled: true,
      image: "docker.io/library/alpine:3.20",
      egress: "blocked",
      doors: [],
      workspaceShare: "whole",
      shareSubpaths: [],
      shareEntries: [],
    },
  };
  const draft = normalizeFolderDraft({
    editor: "advanced",
    workspaceAccess: "read-only",
    workspaceShare: "selected",
    entries: [{ path: "src", access: "read-write" }],
    extraReadPaths: [],
    extraWritePaths: [],
  });
  const applied = applyFolderDraft(base, draft);
  assert.equal(applied.mode, "read-only");
  assert.equal(applied.inheritMode, false);
  assert.equal(applied.room.workspaceShare, "selected");
  assert.deepEqual(applied.room.shareEntries, [{ path: "src", access: "read-write" }]);

  const diff = folderPolicyDiff(base, draft);
  assert.ok(diff.some((item) => item.field === "Shared folders"));
  assert.match(diff.find((item) => item.field === "Shared folders").after, /src/);

  const matrix = folderMatrix(draft);
  assert.ok(matrix.every((row) => row.source === "Explicit"));
  assert.ok(matrix.some((row) => row.path === "src" && row.write === true && row.read === true));

  const wholeMatrix = folderMatrix({
    editor: "simple",
    workspaceAccess: "read-write",
    workspaceShare: "whole",
    entries: [],
    extraReadPaths: [],
    extraWritePaths: [],
  });
  assert.equal(wholeMatrix[0].displayPath, "/workspace");
  assert.equal(wholeMatrix[0].source, "Explicit");
  assert.equal(wholeMatrix[0].write, true);
});

test("workspace presence never invents a missing folder", () => {
  assert.equal(workspacePresence("").status, "unset");
  assert.equal(workspacePresence("/definitely/missing/bumper-folder-xyz").status, "missing");
  const root = mkdtempSync(join(tmpdir(), "bumper-folders-presence-"));
  try {
    assert.equal(workspacePresence(root).status, "ok");
    const file = join(root, "not-a-dir");
    writeFileSync(file, "x");
    assert.equal(workspacePresence(file).status, "not-directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Apply stop-gate rejects when Project sessions are running", () => {
  const sessions = [
    { id: "1", context: "acme", status: "running", agentName: "Grok" },
    { id: "2", context: "other", status: "running", agentName: "Claude" },
    { id: "3", context: "acme", status: "stopped", agentName: "Old" },
  ];
  assert.equal(runningSessionsForProject(sessions, "acme").length, 1);
  assert.throws(() => assertCanApplyFolders(sessions, "acme"), /Stop running sessions/);
  assert.doesNotThrow(() => assertCanApplyFolders(sessions, "quiet"));
});

test("resolvePermissionSetup prefers built-ins over config shadows", () => {
  const cfg = {
    permissionSetups: {
      "Standard development": builtinPermissionSetup("Offline review"),
    },
  };
  const resolved = resolvePermissionSetup(cfg, "Standard development");
  assert.equal(resolved.mode, "read-write");
  assert.equal(resolved.room.egress, "open");

  const project = applyPermissionSetup(
    {
      mode: "read-only",
      inheritMode: true,
      commands: {},
      native: { allow: [], deny: [] },
      writePaths: ["/tmp/out"],
      readPaths: [],
      denyReadPaths: [],
      denyWritePaths: [],
      gitIgnored: "visible",
      repos: [],
      allowedHosts: [],
      backends: [],
      policies: {},
      loginProfiles: {},
      room: {
        enabled: true,
        image: "x",
        egress: "blocked",
        doors: [],
        workspaceShare: "selected",
        shareSubpaths: ["src"],
        shareEntries: [{ path: "src", access: "read-write" }],
      },
    },
    resolved,
  );
  assert.equal(project.mode, "read-write");
  assert.equal(project.room.egress, "open");
  assert.equal(project.room.workspaceShare, "whole");
});

test("draftFromContext round-trips shareEntries", () => {
  const draft = draftFromContext({
    mode: "read-write",
    readPaths: [],
    writePaths: [],
    room: {
      enabled: true,
      image: "x",
      egress: "blocked",
      doors: [],
      workspaceShare: "selected",
      shareSubpaths: ["src"],
      shareEntries: [{ path: "docs", access: "read-only" }],
    },
  });
  assert.equal(draft.workspaceShare, "selected");
  assert.deepEqual(draft.entries, [{ path: "docs", access: "read-only" }]);
});
