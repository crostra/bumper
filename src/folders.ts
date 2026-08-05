/**
 * Phase 2 Folders — permission templates, draft/apply, matrix, RoomSpec mapping.
 *
 * Hard-guarantee honesty:
 *  - Whole workspace Read+Write / Read only → one /workspace door (VM enforced).
 *  - Selected folders → only listed mounts exist; unlisted paths fail (VM enforced).
 *  - Nested override inside a whole mount / Hidden-as-deny-while-mounted → NOT offered
 *    until Apple container positive+negative proof lands (see FOLDER_CAPABILITIES).
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Context, PermissionSetup, RoomDoor } from "./types.js";
import type { Door } from "./room/backend.js";

/** Minimal session shape for the Apply stop-gate (avoids importing SessionManager). */
export interface FolderSessionRef {
  id: string;
  context: string;
  status: string;
  agentName?: string;
}

export type FolderAccess = "read-only" | "read-write";
export type FolderSource = "Inherited" | "Override" | "Explicit";
export type FolderEditorMode = "simple" | "advanced";

/** One mount row under Advanced (selected share) or display row in the matrix. */
export interface FolderEntry {
  /** Workspace-relative path; empty string = workspace root. */
  path: string;
  access: FolderAccess;
}

export interface FolderDraft {
  editor: FolderEditorMode;
  /** Entire-workspace access when share is "whole". */
  workspaceAccess: FolderAccess;
  workspaceShare: "whole" | "selected";
  /** Explicit selected mounts (Advanced). Ignored when share is "whole". */
  entries: FolderEntry[];
  /** Extra host folders outside the workspace (additional doors). */
  extraReadPaths: string[];
  extraWritePaths: string[];
}

export interface FolderMatrixRow {
  path: string;
  displayPath: string;
  depth: number;
  read: boolean;
  write: boolean;
  source: FolderSource;
  /** True when the row is a real mount target the user can edit in Advanced. */
  editable: boolean;
}

export interface FolderDiffItem {
  field: string;
  before: string;
  after: string;
}

export interface WorkspacePresence {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  status: "ok" | "missing" | "not-directory" | "unset";
}

/** What the Folders UI may expose this iteration. */
export const FOLDER_CAPABILITIES = {
  simpleWholeWorkspace: true,
  selectedMounts: true,
  /** Nested RO/Hidden inside a whole RW mount — not proven; keep UI off. */
  nestedOverride: false,
  hiddenWhileMounted: false,
  note:
    "Nested override / Hidden-while-mounted stay off until Apple container " +
    "positive+negative proof. Selected-only mounts already hide unlisted paths by absence.",
} as const;

export const BUILTIN_TEMPLATE_IDS = [
  "Standard development",
  "Offline edit",
  "Offline review",
] as const;

export type BuiltinTemplateId = (typeof BUILTIN_TEMPLATE_IDS)[number];

export function isBuiltinTemplateName(name: string): boolean {
  return (BUILTIN_TEMPLATE_IDS as readonly string[]).includes(name);
}

/** Immutable built-in Permission templates (decision 2026-07-23). */
export function builtinPermissionSetup(id: BuiltinTemplateId): PermissionSetup {
  switch (id) {
    case "Standard development":
      return {
        description: "Built-in · Workspace Read + Write · Network Open",
        mode: "read-write",
        inheritMode: false,
        commands: {},
        native: { allow: [], deny: [] },
        writePaths: [],
        readPaths: [],
        denyReadPaths: [],
        denyWritePaths: [],
        gitIgnored: "visible",
        repos: [],
        allowedHosts: [],
        room: {
          egress: "open",
          egressTemplates: [],
          egressHosts: [],
          doors: [],
          workspaceShare: "whole",
          shareSubpaths: [],
          shareEntries: [],
        },
      };
    case "Offline edit":
      return {
        description: "Built-in · Workspace Read + Write · Network Off",
        mode: "read-write",
        inheritMode: false,
        commands: {},
        native: { allow: [], deny: [] },
        writePaths: [],
        readPaths: [],
        denyReadPaths: [],
        denyWritePaths: [],
        gitIgnored: "visible",
        repos: [],
        allowedHosts: [],
        room: {
          egress: "blocked",
          egressTemplates: [],
          egressHosts: [],
          doors: [],
          workspaceShare: "whole",
          shareSubpaths: [],
          shareEntries: [],
        },
      };
    case "Offline review":
      return {
        description: "Built-in · Workspace Read only · Network Off",
        mode: "read-only",
        inheritMode: false,
        commands: {},
        native: { allow: [], deny: [] },
        writePaths: [],
        readPaths: [],
        denyReadPaths: [],
        denyWritePaths: [],
        gitIgnored: "visible",
        repos: [],
        allowedHosts: [],
        room: {
          egress: "blocked",
          egressTemplates: [],
          egressHosts: [],
          doors: [],
          workspaceShare: "whole",
          shareSubpaths: [],
          shareEntries: [],
        },
      };
  }
}

export function listBuiltinPermissionSetups(): Record<string, PermissionSetup> {
  const out: Record<string, PermissionSetup> = {};
  for (const id of BUILTIN_TEMPLATE_IDS) out[id] = builtinPermissionSetup(id);
  return out;
}

function expand(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

/**
 * Expand and resolve symlinks, the way project.ts stores a workspace.
 *
 * Without this, comparing a typed path against a stored workspace fails on
 * macOS wherever a symlink is in the way — `/tmp` and `/var` are the usual
 * ones — and a folder that *is* the project folder gets classified as some
 * unrelated folder elsewhere on the Mac. The stored side is already a realpath
 * (`normalizeHostPath`), so the compared side has to be too.
 */
function expandReal(path: string): string {
  const abs = expand(path);
  if (!abs) return "";
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Normalize a workspace-relative subpath; reject escapes. */
export function cleanFolderRelPath(rel: string): string | undefined {
  const trimmed = rel.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return "";
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.some((s) => s === "..")) return undefined;
  return segments.join("/");
}

function accessFromMode(mode: Context["mode"] | FolderAccess): FolderAccess {
  return mode === "read-write" ? "read-write" : "read-only";
}

function entriesFromContext(context: Context): FolderEntry[] {
  const room = context.room;
  const shareEntries = room.shareEntries ?? [];
  if (shareEntries.length > 0) {
    return shareEntries
      .map((entry) => {
        const path = cleanFolderRelPath(entry.path);
        if (path === undefined || path === "") return null;
        return { path, access: accessFromMode(entry.access) };
      })
      .filter((e): e is FolderEntry => Boolean(e));
  }
  const access = accessFromMode(context.mode);
  return (room.shareSubpaths ?? [])
    .map((rel) => cleanFolderRelPath(rel))
    .filter((rel): rel is string => Boolean(rel))
    .map((path) => ({ path, access }));
}

/** Build an editable draft from the Project's current folder-related fields. */
export function draftFromContext(context: Context): FolderDraft {
  const share = context.room?.workspaceShare === "selected" ? "selected" : "whole";
  const entries = entriesFromContext(context);
  return {
    editor: share === "selected" || entries.length > 0 ? "advanced" : "simple",
    workspaceAccess: accessFromMode(context.mode),
    workspaceShare: share,
    entries,
    extraReadPaths: [...(context.readPaths ?? [])],
    extraWritePaths: [...(context.writePaths ?? [])],
  };
}

export function normalizeFolderDraft(draft: FolderDraft): FolderDraft {
  const workspaceAccess: FolderAccess =
    draft.workspaceAccess === "read-write" ? "read-write" : "read-only";
  const workspaceShare = draft.workspaceShare === "selected" ? "selected" : "whole";
  const editor: FolderEditorMode =
    draft.editor === "advanced" || workspaceShare === "selected" ? "advanced" : "simple";
  const seen = new Set<string>();
  const entries: FolderEntry[] = [];
  // whole (project-root mount) and selected insides are mutually exclusive —
  // nested per-child access under a whole mount is not proven.
  if (workspaceShare === "selected") {
    for (const entry of draft.entries ?? []) {
      const path = cleanFolderRelPath(entry.path ?? "");
      if (path === undefined || path === "") continue;
      if (seen.has(path)) continue;
      seen.add(path);
      entries.push({
        path,
        access: entry.access === "read-only" ? "read-only" : "read-write",
      });
    }
  }
  return {
    editor: workspaceShare === "selected" ? "advanced" : editor,
    workspaceAccess,
    workspaceShare,
    entries,
    extraReadPaths: [...new Set((draft.extraReadPaths ?? []).map((p) => expand(p)).filter(Boolean))],
    extraWritePaths: [...new Set((draft.extraWritePaths ?? []).map((p) => expand(p)).filter(Boolean))],
  };
}

/* -------------------------------------------------------------------------- */
/* Share rows — list-first UI projection (keeps whole/selected wire format)   */
/* -------------------------------------------------------------------------- */

/** One row in the list-first Folders editor. */
export type ShareRow =
  | { kind: "project-root"; access: FolderAccess }
  | { kind: "inside"; path: string; access: FolderAccess }
  | { kind: "outside"; hostPath: string; access: FolderAccess };

/** Project a FolderDraft into list rows. */
export function shareRowsFromDraft(draft: FolderDraft): ShareRow[] {
  const next = normalizeFolderDraft(draft);
  const rows: ShareRow[] = [];
  if (next.workspaceShare === "whole") {
    rows.push({ kind: "project-root", access: next.workspaceAccess });
  } else {
    for (const entry of next.entries) {
      rows.push({ kind: "inside", path: entry.path, access: entry.access });
    }
  }
  const writes = new Set(next.extraWritePaths);
  for (const hostPath of next.extraWritePaths) {
    rows.push({ kind: "outside", hostPath, access: "read-write" });
  }
  for (const hostPath of next.extraReadPaths) {
    if (writes.has(hostPath)) continue;
    rows.push({ kind: "outside", hostPath, access: "read-only" });
  }
  return sortShareRows(rows);
}

/**
 * Collapse list rows back into a FolderDraft for doors / apply.
 * R1: project-root and inside cannot both survive — root wins and drops inside.
 */
export function folderDraftFromShareRows(rows: ShareRow[]): FolderDraft {
  let hasRoot = false;
  let rootAccess: FolderAccess = "read-write";
  const inside: FolderEntry[] = [];
  const extraReadPaths: string[] = [];
  const extraWritePaths: string[] = [];
  const seenInside = new Set<string>();
  const seenOutside = new Set<string>();

  for (const row of rows) {
    if (row.kind === "project-root") {
      hasRoot = true;
      rootAccess = row.access === "read-only" ? "read-only" : "read-write";
      continue;
    }
    if (row.kind === "inside") {
      const path = cleanFolderRelPath(row.path);
      if (path === undefined || path === "") continue;
      if (seenInside.has(path)) continue;
      seenInside.add(path);
      inside.push({
        path,
        access: row.access === "read-only" ? "read-only" : "read-write",
      });
      continue;
    }
    const host = expand(row.hostPath);
    if (!host || seenOutside.has(host)) continue;
    seenOutside.add(host);
    if (row.access === "read-write") extraWritePaths.push(host);
    else extraReadPaths.push(host);
  }

  const keepInside = hasRoot ? [] : collapseInsideAncestors(inside);
  const workspaceShare: FolderDraft["workspaceShare"] = hasRoot ? "whole" : "selected";
  let workspaceAccess: FolderAccess = rootAccess;
  if (!hasRoot) {
    workspaceAccess = keepInside.some((e) => e.access === "read-write")
      ? "read-write"
      : keepInside.length
        ? "read-only"
        : "read-write";
  }

  return normalizeFolderDraft({
    editor: hasRoot ? "simple" : "advanced",
    workspaceAccess,
    workspaceShare,
    entries: keepInside,
    extraReadPaths,
    extraWritePaths,
  });
}

/** Drop child paths covered by a listed ancestor (ancestor wins). */
function collapseInsideAncestors(entries: FolderEntry[]): FolderEntry[] {
  const sorted = [...entries].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  const kept: FolderEntry[] = [];
  for (const entry of sorted) {
    const covered = kept.some((parent) => entry.path === parent.path || entry.path.startsWith(`${parent.path}/`));
    if (covered) continue;
    kept.push(entry);
  }
  return kept;
}

export type ClassifiedHostPath =
  | { kind: "project-root" }
  | { kind: "inside"; path: string }
  | { kind: "outside"; hostPath: string }
  | { kind: "invalid"; reason: string };

/** Classify a Finder-picked absolute path relative to the Project workspace. */
export function classifyHostPath(hostPath: string, workspace: string): ClassifiedHostPath {
  const abs = expandReal(hostPath);
  const ws = expandReal((workspace || "").trim());
  if (!abs) return { kind: "invalid", reason: "Choose a folder." };
  if (!ws) return { kind: "invalid", reason: "Set the project folder first." };
  const wsNorm = ws.replace(/\/+$/, "");
  const absNorm = abs.replace(/\/+$/, "");
  if (absNorm === wsNorm) return { kind: "project-root" };
  if (absNorm.startsWith(`${wsNorm}/`)) {
    const rel = absNorm.slice(wsNorm.length + 1);
    const path = cleanFolderRelPath(rel);
    if (path === undefined || path === "") {
      return { kind: "invalid", reason: "That path is not a valid folder inside the project." };
    }
    return { kind: "inside", path };
  }
  return { kind: "outside", hostPath: absNorm };
}

export interface ShareRowMutation {
  rows: ShareRow[];
  /** Hard refuse — do not change list. */
  error?: string;
  /** Soft note after a successful change. */
  note?: string;
}

/** Add a classified share; enforces R1 (root vs inside) and R2 (ancestor wins). */
export function addShareRow(rows: ShareRow[], next: ShareRow): ShareRowMutation {
  const list = [...rows];

  if (next.kind === "project-root") {
    const withoutInside: ShareRow[] = list.filter((r) => r.kind !== "inside" && r.kind !== "project-root");
    const dropped = list.some((r) => r.kind === "inside");
    withoutInside.unshift({
      kind: "project-root",
      access: next.access === "read-only" ? "read-only" : "read-write",
    });
    return {
      rows: sortShareRows(withoutInside),
      note: dropped ? "Subfolders are included in the project folder." : undefined,
    };
  }

  if (next.kind === "inside") {
    if (list.some((r) => r.kind === "project-root")) {
      return {
        rows: list,
        error:
          "The project folder already includes this. Remove the project folder row first to share only some folders.",
      };
    }
    const path = cleanFolderRelPath(next.path);
    if (path === undefined || path === "") {
      return { rows: list, error: "Choose a folder inside the project folder." };
    }
    if (list.some((r) => r.kind === "inside" && r.path === path)) {
      return { rows: list, error: "That folder is already shared." };
    }
    if (list.some((r) => r.kind === "inside" && (path === r.path || path.startsWith(`${r.path}/`)))) {
      return {
        rows: list,
        error: "A parent of this folder is already shared — contents follow the parent.",
      };
    }
    const filtered = list.filter(
      (r) => !(r.kind === "inside" && r.path.startsWith(`${path}/`)),
    );
    filtered.push({
      kind: "inside",
      path,
      access: next.access === "read-only" ? "read-only" : "read-write",
    });
    return { rows: sortShareRows(filtered) };
  }

  const host = expand(next.hostPath);
  if (!host) return { rows: list, error: "Choose a folder." };
  if (list.some((r) => r.kind === "outside" && expand(r.hostPath) === host)) {
    return { rows: list, error: "That folder is already shared." };
  }
  list.push({
    kind: "outside",
    hostPath: host,
    access: next.access === "read-only" ? "read-only" : "read-write",
  });
  return { rows: sortShareRows(list) };
}

/** Stable display order: project root, inside (by path), outside (by host path). */
export function sortShareRows(rows: ShareRow[]): ShareRow[] {
  const root = rows.filter((r) => r.kind === "project-root");
  const inside = rows
    .filter((r): r is Extract<ShareRow, { kind: "inside" }> => r.kind === "inside")
    .sort((a, b) => a.path.localeCompare(b.path));
  const outside = rows
    .filter((r): r is Extract<ShareRow, { kind: "outside" }> => r.kind === "outside")
    .sort((a, b) => a.hostPath.localeCompare(b.hostPath));
  return [...root, ...inside, ...outside];
}

function shareRowLabel(row: ShareRow): string {
  const access = row.access === "read-write" ? "Can edit" : "Look only";
  if (row.kind === "project-root") return `project folder (${access})`;
  if (row.kind === "inside") return `${row.path} (${access})`;
  return `${row.hostPath} (${access})`;
}

/**
 * Apply a folder draft onto a Project. Does not change name, description,
 * workspace path, backends, loginProfiles, or egress (egress belongs to Network /
 * templates — except when applying a full Permission template).
 */
export function applyFolderDraft(project: Context, draft: FolderDraft): Context {
  const next = normalizeFolderDraft(draft);
  const shareEntries =
    next.workspaceShare === "selected"
      ? next.entries.map((e) => ({ path: e.path, access: e.access }))
      : [];
  return {
    ...project,
    mode: next.workspaceAccess,
    inheritMode: false,
    readPaths: [...next.extraReadPaths],
    writePaths: [...next.extraWritePaths],
    room: {
      ...project.room,
      workspaceShare: next.workspaceShare,
      shareSubpaths: shareEntries.map((e) => e.path),
      shareEntries,
      enabled: project.room?.enabled !== false,
    },
  };
}

/** Human-readable draft vs effective folder policy diff for Apply confirm. */
export function folderPolicyDiff(before: Context, draft: FolderDraft): FolderDiffItem[] {
  const a = normalizeFolderDraft(draftFromContext(before));
  const b = normalizeFolderDraft(draft);
  const items: FolderDiffItem[] = [];
  const aRows = shareRowsFromDraft(a).map((r) => shareRowLabel(r)).sort().join(", ") || "(none)";
  const bRows = shareRowsFromDraft(b).map((r) => shareRowLabel(r)).sort().join(", ") || "(none)";
  if (aRows !== bRows) {
    items.push({ field: "Shared folders", before: aRows, after: bRows });
  }
  return items;
}

/**
 * Matrix rows for UI. Nested Override is never editable (capability off).
 * Selected share lists Explicit mounts only; whole share shows root Explicit +
 * optional Inherited children for orientation.
 */
export function folderMatrix(draft: FolderDraft, workspacePath?: string): FolderMatrixRow[] {
  const next = normalizeFolderDraft(draft);
  const rows: FolderMatrixRow[] = [];

  if (next.workspaceShare === "whole") {
    rows.push({
      path: "",
      displayPath: "/workspace",
      depth: 0,
      read: true,
      write: next.workspaceAccess === "read-write",
      source: "Explicit",
      editable: true,
    });
    if (workspacePath && existsSync(workspacePath)) {
      for (const name of listImmediateChildren(workspacePath).slice(0, 40)) {
        rows.push({
          path: name,
          displayPath: name,
          depth: 1,
          read: true,
          write: next.workspaceAccess === "read-write",
          source: "Inherited",
          editable: false,
        });
      }
    }
    return rows;
  }

  // Selected: only Explicit mounts — unlisted paths are absent (Hidden by construction).
  if (next.entries.length === 0) {
    rows.push({
      path: "",
      displayPath: "/workspace (no mounts)",
      depth: 0,
      read: false,
      write: false,
      source: "Explicit",
      editable: false,
    });
    return rows;
  }
  for (const entry of [...next.entries].sort((a, b) => a.path.localeCompare(b.path))) {
    rows.push({
      path: entry.path,
      displayPath: `/workspace/${entry.path}`,
      depth: entry.path.split("/").length - 1,
      read: true,
      write: entry.access === "read-write",
      source: "Explicit",
      editable: true,
    });
  }
  return rows;
}

function listImmediateChildren(workspacePath: string): string[] {
  try {
    return readdirSync(workspacePath)
      .filter((name) => !name.startsWith("."))
      .filter((name) => {
        try {
          return statSync(join(workspacePath, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function workspacePresence(workspace: string | undefined): WorkspacePresence {
  const path = (workspace ?? "").trim();
  if (!path) {
    return { path: "", exists: false, isDirectory: false, status: "unset" };
  }
  const abs = expand(path);
  if (!existsSync(abs)) {
    return { path: abs, exists: false, isDirectory: false, status: "missing" };
  }
  try {
    const isDirectory = statSync(abs).isDirectory();
    return {
      path: abs,
      exists: true,
      isDirectory,
      status: isDirectory ? "ok" : "not-directory",
    };
  } catch {
    return { path: abs, exists: false, isDirectory: false, status: "missing" };
  }
}

/** Running/starting sessions that would still use the old folder policy. */
export function runningSessionsForProject(
  sessions: FolderSessionRef[],
  projectName: string,
): FolderSessionRef[] {
  return sessions.filter(
    (s) =>
      s.context === projectName && (s.status === "running" || s.status === "starting"),
  );
}

export function assertCanApplyFolders(
  sessions: FolderSessionRef[],
  projectName: string,
): void {
  const running = runningSessionsForProject(sessions, projectName);
  if (running.length === 0) return;
  const labels = running.map((s) => s.agentName || s.id).join(", ");
  throw new Error(
    `Stop running sessions for this Project before applying Folders (${labels}). ` +
      "Folder changes apply to new sessions only.",
  );
}

function roomName(path: string): string {
  return basename(path).replace(/[^a-zA-Z0-9._-]/g, "-") || "folder";
}

export function defaultRoomPathForHostPath(path: string): string {
  return `/shared/${roomName(path)}`;
}

/**
 * Workspace + extra doors implied by a folder draft.
 * Matches UI claims: allowed RW, read-only write fail, unmounted outside fail.
 */
export function doorsFromFolderDraft(workspace: string, draft: FolderDraft): Door[] {
  const next = normalizeFolderDraft(draft);
  const root = expand(workspace);
  const doors: Door[] = [];

  if (next.workspaceShare === "selected") {
    for (const entry of next.entries) {
      doors.push({
        hostPath: join(root, entry.path),
        roomPath: `/workspace/${entry.path}`,
        access: entry.access,
      });
    }
  } else {
    doors.push({
      hostPath: root,
      roomPath: "/workspace",
      access: next.workspaceAccess,
    });
  }

  for (const path of next.extraReadPaths) {
    doors.push({
      hostPath: expand(path),
      roomPath: defaultRoomPathForHostPath(path),
      access: "read-only",
    });
  }
  for (const path of next.extraWritePaths) {
    doors.push({
      hostPath: expand(path),
      roomPath: defaultRoomPathForHostPath(path),
      access: "read-write",
    });
  }
  return doors;
}

/** Config doors (absolute host paths) that are not the workspace share itself. */
export function configExtraDoors(doors: RoomDoor[] | undefined): Door[] {
  return (doors ?? []).map((door) => ({
    hostPath: expand(door.hostPath),
    roomPath: door.roomPath.startsWith("/") ? door.roomPath : `/${door.roomPath}`,
    access: door.access === "read-write" ? "read-write" : "read-only",
  }));
}
