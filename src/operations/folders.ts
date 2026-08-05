/**
 * Which folders a Project shares with its Sandbox — the first of the two dials
 * that make a Sandbox *yours* (the other is operations/network.ts).
 *
 * Everything here composes `src/folders.ts`, which already holds the rules:
 * R1 (the project root and a subfolder cannot both be shared — the root wins),
 * R2 (an ancestor already covers its descendants), path classification, and
 * the draft ⇄ rows projection the GUI board edits. This module owns the
 * *sequencing* the GUI handler used to carry inline: refuse while a Session is
 * live, refuse an empty share, then write.
 *
 * `bumper folders` and the GUI board both call it, so the two cannot drift on
 * what a legal share is.
 */
import type { Config, Context } from "../types.js";
import {
  addShareRow,
  applyFolderDraft,
  assertCanApplyFolders,
  classifyHostPath,
  draftFromContext,
  folderDraftFromShareRows,
  normalizeFolderDraft,
  runningSessionsForProject,
  shareRowsFromDraft,
  sortShareRows,
  workspacePresence,
  type FolderAccess,
  type FolderDraft,
  type FolderSessionRef,
  type ShareRow,
} from "../folders.js";
import { OperationError } from "./error.js";

/** The subset of a Context a folder change writes. */
export interface FolderPatch {
  mode: Context["mode"];
  inheritMode: false;
  readPaths: string[];
  writePaths: string[];
  room: Record<string, unknown>;
}

/**
 * Merge a patch into a context-shaped object.
 *
 * Both adapters call this: the GUI against the raw JSON it edits through
 * `writeRawConfig` (which must keep fields Zod does not know about), the CLI
 * against the parsed Context. One merge, so neither can forget `enabled` or
 * clobber `workspace`.
 */
export function applyFolderPatch<T extends Record<string, any>>(target: T, patch: FolderPatch): T {
  return {
    ...target,
    mode: patch.mode,
    inheritMode: patch.inheritMode,
    readPaths: patch.readPaths,
    writePaths: patch.writePaths,
    room: {
      ...(target.room ?? {}),
      ...patch.room,
      enabled: true,
    },
  };
}

export interface ProjectFoldersView {
  projectName: string;
  workspace: string;
  workspaceExists: boolean;
  rows: ShareRow[];
  draft: FolderDraft;
  /** Live Sessions that would block an edit right now. */
  blockingSessions: FolderSessionRef[];
}

function requireProject(config: Config, projectName: string): Context {
  const name = projectName.trim();
  const project = config.contexts[name];
  if (!project) {
    const available = Object.keys(config.contexts).join(", ") || "(none)";
    throw new OperationError("not-found", `Unknown project "${name}". Available: ${available}.`, [
      "bumper contexts        # list Projects",
    ]);
  }
  return project;
}

export function describeProjectFolders(input: {
  config: Config;
  projectName: string;
  runningSessions?: FolderSessionRef[];
}): ProjectFoldersView {
  const project = requireProject(input.config, input.projectName);
  const draft = normalizeFolderDraft(draftFromContext(project));
  const workspace = project.workspace?.trim() ?? "";
  return {
    projectName: input.projectName.trim(),
    workspace,
    workspaceExists: workspacePresence(workspace).exists,
    rows: shareRowsFromDraft(draft),
    draft,
    blockingSessions: runningSessionsForProject(input.runningSessions ?? [], input.projectName.trim()),
  };
}

export interface ApplyProjectFoldersResult {
  projectName: string;
  draft: FolderDraft;
  rows: ShareRow[];
  patch: FolderPatch;
  /** Folder changes never reach a Session that is already running. */
  appliesToNewSessions: true;
}

/**
 * Validate a draft and produce the patch to write. Does not persist — the
 * adapters own their write paths (raw JSON vs parsed Config); what must not
 * differ is everything above.
 */
export function applyProjectFolders(input: {
  config: Config;
  projectName: string;
  draft: FolderDraft;
  /** Live Sessions. Pass leaseSessionRefs() at minimum; the GUI adds its own. */
  runningSessions: FolderSessionRef[];
}): ApplyProjectFoldersResult {
  const project = requireProject(input.config, input.projectName);
  const projectName = input.projectName.trim();

  try {
    assertCanApplyFolders(input.runningSessions, projectName);
  } catch (err) {
    throw new OperationError("conflict", (err as Error).message, [
      "Stop the Session (exit the AI CLI), then run this again.",
    ]);
  }

  const draft = normalizeFolderDraft(input.draft);

  // A Project that shares nothing is almost never what someone meant, and it
  // fails later as a puzzling "the AI can't see my files".
  const noProjectTree = draft.workspaceShare === "selected" && draft.entries.length === 0;
  const noOutside = (draft.extraReadPaths?.length ?? 0) === 0 && (draft.extraWritePaths?.length ?? 0) === 0;
  if (noProjectTree && noOutside) {
    throw new OperationError(
      "invalid",
      "Share at least one folder (the project folder, a subfolder, or another folder on this Mac).",
      [
        "bumper folders add .            # share the project folder",
        "bumper folders add ./src        # or just a subfolder",
      ],
    );
  }

  const applied = applyFolderDraft(project, draft);
  return {
    projectName,
    draft,
    rows: shareRowsFromDraft(draft),
    patch: {
      mode: applied.mode,
      inheritMode: false,
      readPaths: applied.readPaths ?? [],
      writePaths: applied.writePaths ?? [],
      room: (applied.room ?? {}) as Record<string, unknown>,
    },
    appliesToNewSessions: true,
  };
}

export interface MutateProjectFolderResult extends ApplyProjectFoldersResult {
  /** Set when the rules rewrote the list (root replacing subfolders, etc.). */
  note?: string;
}

/**
 * Share one host folder, read-only or read-write.
 *
 * The path is classified against the workspace exactly as the GUI's picker
 * does, so `.`, `./src`, and `~/other-repo` land on the same three row kinds
 * and get the same R1/R2 treatment.
 */
export function addProjectFolder(input: {
  config: Config;
  projectName: string;
  hostPath: string;
  access: FolderAccess;
  runningSessions: FolderSessionRef[];
}): MutateProjectFolderResult {
  const project = requireProject(input.config, input.projectName);
  const workspace = project.workspace?.trim() ?? "";
  if (!workspace) {
    throw new OperationError("invalid", `Project "${input.projectName}" has no project folder yet.`, [
      `bumper access set -p "${input.projectName}"   # bind this folder first`,
    ]);
  }

  const classified = classifyHostPath(input.hostPath, workspace);
  if (classified.kind === "invalid") {
    throw new OperationError("invalid", classified.reason, [
      "Pass a folder path: bumper folders add ./src",
    ]);
  }

  const current = shareRowsFromDraft(normalizeFolderDraft(draftFromContext(project)));
  const next: ShareRow =
    classified.kind === "project-root"
      ? { kind: "project-root", access: input.access }
      : classified.kind === "inside"
        ? { kind: "inside", path: classified.path, access: input.access }
        : { kind: "outside", hostPath: classified.hostPath, access: input.access };

  const mutation = addShareRow(current, next);
  if (mutation.error) {
    // The rules refuse in prose written for a board you click. In a terminal
    // the same refusal needs the command that unblocks it.
    const project = input.projectName.trim();
    const covering = current.find((row) => row.kind === "project-root")
      ? "."
      : current.filter((row): row is Extract<ShareRow, { kind: "inside" }> => row.kind === "inside")
        .find((row) => classified.kind === "inside" && classified.path.startsWith(`${row.path}/`))?.path;
    const fix = covering
      ? [`bumper folders remove ${covering === "." ? "." : `./${covering}`} -p "${project}"`, `bumper folders add ${input.hostPath} -p "${project}"`]
      : [`bumper folders list -p "${project}"`];
    throw new OperationError("invalid", mutation.error, fix);
  }

  const result = applyProjectFolders({
    config: input.config,
    projectName: input.projectName,
    draft: folderDraftFromShareRows(sortShareRows(mutation.rows)),
    runningSessions: input.runningSessions,
  });
  return { ...result, note: mutation.note };
}

/** Stop sharing a folder. Identified the way `bumper folders list` prints it. */
export function removeProjectFolder(input: {
  config: Config;
  projectName: string;
  hostPath: string;
  runningSessions: FolderSessionRef[];
}): MutateProjectFolderResult {
  const project = requireProject(input.config, input.projectName);
  const workspace = project.workspace?.trim() ?? "";
  const classified = classifyHostPath(input.hostPath, workspace);
  if (classified.kind === "invalid") {
    throw new OperationError("invalid", classified.reason, [
      `bumper folders list -p "${input.projectName}"   # the paths you can remove`,
    ]);
  }

  const current = shareRowsFromDraft(normalizeFolderDraft(draftFromContext(project)));
  const remaining = current.filter((row) => {
    if (classified.kind === "project-root") return row.kind !== "project-root";
    if (classified.kind === "inside") return !(row.kind === "inside" && row.path === classified.path);
    return !(row.kind === "outside" && row.hostPath === classified.hostPath);
  });

  if (remaining.length === current.length) {
    throw new OperationError("not-found", `"${input.hostPath}" is not shared by this Project.`, [
      `bumper folders list -p "${input.projectName}"`,
    ]);
  }

  return applyProjectFolders({
    config: input.config,
    projectName: input.projectName,
    draft: folderDraftFromShareRows(sortShareRows(remaining)),
    runningSessions: input.runningSessions,
  });
}

/** One printable line per shared folder. Shared so both surfaces label alike. */
export function describeShareRow(row: ShareRow): { label: string; access: FolderAccess; scope: string } {
  const access = row.access;
  switch (row.kind) {
    case "project-root":
      return { label: ".", access, scope: "project folder" };
    case "inside":
      return { label: `./${row.path}`, access, scope: "inside the project folder" };
    case "outside":
      return { label: row.hostPath, access, scope: "elsewhere on this Mac" };
  }
}

/** The GUI's words for an access level; the CLI must not invent its own. */
export function accessLabel(access: FolderAccess): string {
  return access === "read-write" ? "Can edit" : "Look only";
}
