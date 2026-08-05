/**
 * Project composition helpers: Access roots and resolveProject for CLI/GUI.
 * Context records remain the on-disk Project store (no rename in Phase 1).
 */
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";
import type { Config, Context } from "./types.js";
import { initialRoomImage } from "./room/setup.js";

export type AccessRole = "workspace" | "read" | "write" | "door";

export interface ProjectAccessRoot {
  /** Absolute host path (expanded). */
  path: string;
  role: AccessRole;
  /** Door / workspace access mode when known. */
  access?: "read-only" | "read-write";
}

export type ResolveSource = "flag" | "cwd" | "interactive-select" | "interactive-create";

export type ResolveProjectOk = {
  ok: true;
  name: string;
  source: ResolveSource;
  /** Config may have been mutated when source is interactive-create. */
  created?: boolean;
};

export type ResolveProjectErr = {
  ok: false;
  reason: "unknown-flag" | "ambiguous" | "none" | "cancelled" | "no-projects";
  matches: string[];
  message: string;
};

export type ResolveProjectResult = ResolveProjectOk | ResolveProjectErr;

export type ResolveAskRequest =
  | { type: "select"; prompt: string; choices: string[]; allowCreate: boolean;
      /** Nothing covers this folder: Enter should mean "create one for it". */
      defaultCreate?: boolean }
  | { type: "create-name"; prompt: string; defaultName: string };

export type ResolveAskResponse =
  | { action: "select"; name: string }
  | { action: "create"; name: string }
  | { action: "cancel" };

export interface ResolveProjectOptions {
  config: Config;
  cwd: string;
  /** Explicit `-p` / project flag. Wins over cwd. */
  flag?: string | null;
  /**
   * When true and resolution is ambiguous or empty, ask the user.
   * When false, return a hard error (never invent a project).
   */
  interactive: boolean;
  /** Injected for tests / CLI readline. Required when interactive needs input. */
  ask?: (req: ResolveAskRequest) => Promise<ResolveAskResponse>;
  /**
   * Called when the user chooses create. Must persist a project and leave
   * `config.contexts[name]` usable. Never called without an explicit create choice.
   */
  createProject?: (input: { name: string; workspace: string }) => void | Promise<void>;
}

function expand(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

/** Prefer realpath when the path exists so symlinks compare equal. */
export function normalizeHostPath(path: string): string {
  const abs = expand(path);
  if (!abs) return "";
  try {
    if (existsSync(abs)) return realpathSync(abs);
  } catch {
    /* keep abs */
  }
  return abs;
}

/**
 * Access roots owned by a Project — used for cwd matching and UI summary.
 * Includes workspace, extra read/write folders, and explicit Room doors.
 */
export function projectAccessRoots(context: Context): ProjectAccessRoot[] {
  const roots: ProjectAccessRoot[] = [];
  const seen = new Set<string>();

  const push = (raw: string | undefined, role: AccessRole, access?: "read-only" | "read-write") => {
    if (!raw?.trim()) return;
    const path = normalizeHostPath(raw);
    if (!path || seen.has(path)) return;
    seen.add(path);
    roots.push(access ? { path, role, access } : { path, role });
  };

  push(context.workspace, "workspace", context.mode === "read-write" ? "read-write" : "read-only");
  for (const p of context.readPaths ?? []) push(p, "read", "read-only");
  for (const p of context.writePaths ?? []) push(p, "write", "read-write");
  for (const door of context.room?.doors ?? []) {
    push(door.hostPath, "door", door.access === "read-write" ? "read-write" : "read-only");
  }
  return roots;
}

/** True when cwd is the root or a descendant of root. */
export function pathCovers(root: string, cwd: string): boolean {
  const r = normalizeHostPath(root);
  const c = normalizeHostPath(cwd);
  if (!r || !c) return false;
  if (r === c) return true;
  const rel = relative(r, c);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Projects whose Access roots cover cwd (workspace / extra dirs / doors).
 * Order follows Object.keys(config.contexts).
 */
export function matchProjectsByCwd(config: Config, cwd: string): string[] {
  const absCwd = normalizeHostPath(cwd || process.cwd());
  if (!absCwd) return [];
  const names: string[] = [];
  for (const [name, ctx] of Object.entries(config.contexts)) {
    const roots = projectAccessRoots(ctx);
    if (roots.some((root) => pathCovers(root.path, absCwd))) names.push(name);
  }
  return names;
}

function error(
  reason: ResolveProjectErr["reason"],
  matches: string[],
  message: string,
): ResolveProjectErr {
  return { ok: false, reason, matches, message };
}

function unknownFlagMessage(flag: string, available: string[]): string {
  const list = available.length ? available.join(", ") : "(none)";
  return `Unknown project "${flag}". Available: ${list}. Use -p <project> or open the Bumper app to create one.`;
}

function needFlagMessage(matches: string[]): string {
  if (matches.length === 0) {
    return (
      "No project matches this directory's Access roots. " +
      "Pass -p <project>, bind a folder with `bumper access set` (or Projects → Access), " +
      "or run in an interactive terminal to select or create a project. " +
      "Bumper never creates a project silently."
    );
  }
  return `Multiple projects match this directory (${matches.join(", ")}). Pass -p <project>, or run in an interactive terminal to choose. Bumper never guesses.`;
}

/**
 * Resolve which Project a CLI invocation should use.
 *
 * Priority:
 * 1. flag (-p) — must exist
 * 2. unique cwd Access match — auto
 * 3. 0 or many matches — interactive select/create when interactive+TTY ask;
 *    otherwise hard error asking for -p
 *
 * Never silently creates or launches.
 */
export async function resolveProject(opts: ResolveProjectOptions): Promise<ResolveProjectResult> {
  const { config, interactive } = opts;
  const names = Object.keys(config.contexts);
  const cwd = opts.cwd || process.cwd();
  const flag = opts.flag?.trim() || "";

  if (flag) {
    if (!config.contexts[flag]) {
      return error("unknown-flag", [], unknownFlagMessage(flag, names));
    }
    return { ok: true, name: flag, source: "flag" };
  }

  const matches = matchProjectsByCwd(config, cwd);

  if (matches.length === 1) {
    return { ok: true, name: matches[0]!, source: "cwd" };
  }

  if (!interactive) {
    return error(
      matches.length === 0 ? "none" : "ambiguous",
      matches,
      needFlagMessage(matches),
    );
  }

  if (!opts.ask) {
    return error(
      matches.length === 0 ? "none" : "ambiguous",
      matches,
      needFlagMessage(matches) + " (interactive mode requires an ask handler)",
    );
  }

  const choices = matches.length > 0 ? matches : names;
  if (choices.length === 0 && matches.length === 0) {
    // No projects at all — still allow create when interactive.
  }

  const select = await opts.ask({
    type: "select",
    prompt:
      matches.length === 0
        ? `No Project covers this folder yet:\n  ${normalizeHostPath(cwd)}\n\nCreate one for it, or pick an existing Project.`
        : `Multiple projects match this directory. Choose one:`,
    choices: choices.length > 0 ? choices : [],
    allowCreate: true,
    // Confirmed by a keypress, never silent — but the obvious answer is one key.
    defaultCreate: matches.length === 0,
  });

  if (select.action === "cancel") {
    return error("cancelled", matches, "Project selection cancelled. Pass -p <project> to continue.");
  }

  if (select.action === "select") {
    if (!config.contexts[select.name]) {
      return error("unknown-flag", matches, unknownFlagMessage(select.name, names));
    }
    return { ok: true, name: select.name, source: "interactive-select" };
  }

  // create
  const defaultName = defaultProjectNameFromCwd(cwd);
  let createName = select.name?.trim() || "";
  if (!createName) {
    const named = await opts.ask({
      type: "create-name",
      prompt: "New project name",
      defaultName,
    });
    if (named.action === "cancel") {
      return error("cancelled", matches, "Project creation cancelled. Pass -p <project> to continue.");
    }
    createName = (named.action === "create" || named.action === "select"
      ? named.name
      : defaultName
    ).trim() || defaultName;
  }

  if (config.contexts[createName]) {
    return error(
      "unknown-flag",
      matches,
      `Project "${createName}" already exists. Choose it with -p or select it interactively.`,
    );
  }

  if (!opts.createProject) {
    return error(
      "none",
      matches,
      `Cannot create project "${createName}" without a createProject handler. Pass -p or create the project in the Bumper app first.`,
    );
  }

  const workspace = normalizeHostPath(cwd);
  await opts.createProject({ name: createName, workspace });
  return { ok: true, name: createName, source: "interactive-create", created: true };
}

export function defaultProjectNameFromCwd(cwd: string): string {
  const abs = normalizeHostPath(cwd);
  const base = abs.split(/[/\\]/).filter(Boolean).pop() || "project";
  return base.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60) || "project";
}

/**
 * Persist a minimal Project (context) for interactive create.
 * Callers pass the live config object after loadConfig; this mutates it in memory
 * and expects the caller to write the file (or use writeRawConfig-style APIs).
 */
export function applyCreatedProject(
  config: Config,
  input: { name: string; workspace: string },
): Context {
  const name = input.name.trim();
  if (!name) throw new Error("Project name is required.");
  if (config.contexts[name]) throw new Error(`Project "${name}" already exists.`);
  const workspace = normalizeHostPath(input.workspace);
  const next: Context = {
    description: `Created from ${workspace || "cwd"}`,
    workspace: workspace || undefined,
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
    gitAccess: "none",
    gitRepository: "",
    gitRepositories: [],
    gitWriteUntil: "",
    gitProviderConnectionId: "",
    repos: [],
    mcpBindings: {},
    allowedHosts: [],
    // The room is the boundary — a project created from a folder starts without
    // the tool's own approval prompts. Turn it off per Project on Overview.
    autoApprove: true,
    development: {
      preview: { enabled: true },
      docker: { enabled: true },
    },
    loginProfiles: {},
    room: {
      enabled: true,
      image: initialRoomImage(),
      // Same default as the app's "Standard development" template. An AI CLI
      // with no network cannot reach its own API, so a blocked default made
      // the first `bumper <cli>` fail for a reason the user never chose.
      // Unrestricted is stated plainly on Overview; Network → Off is one click.
      egress: "open",
      egressTemplates: [],
      egressHosts: [],
      doors: [],
      workspaceShare: "whole",
      shareSubpaths: [],
      shareEntries: [],
    },
  };
  config.contexts[name] = next;
  if (!config.defaultContext) config.defaultContext = name;
  return next;
}

export type SetProjectAccessWorkspaceResult = {
  projectName: string;
  workspace: string;
  previous: string | undefined;
  /** True when the bound folder is the user's home — large share; user chose it. */
  bindsHome: boolean;
};

/**
 * Bind a host folder as the Project's primary Access root (workspace).
 * Never invents a path: caller must supply an existing directory.
 * Does not silently expand Access to $HOME — binding home requires an explicit path.
 */
export function setProjectAccessWorkspace(
  config: Config,
  projectName: string,
  folder: string,
): SetProjectAccessWorkspaceResult {
  const name = projectName.trim();
  if (!name) throw new Error("Project name is required.");
  const project = config.contexts[name];
  if (!project) {
    const available = Object.keys(config.contexts).join(", ") || "(none)";
    throw new Error(`Unknown project "${name}". Available: ${available}.`);
  }

  const raw = folder?.trim();
  if (!raw) {
    throw new Error(
      "Folder path is required. Example: bumper access set ./my-repo  (never invents a home-wide door).",
    );
  }

  const workspace = normalizeHostPath(raw);
  if (!workspace) {
    throw new Error("Folder path is required.");
  }
  if (!existsSync(workspace)) {
    throw new Error(`Folder does not exist: ${workspace}`);
  }

  const home = normalizeHostPath(homedir());
  const bindsHome = Boolean(home && workspace === home);
  const previous = project.workspace?.trim() || undefined;
  project.workspace = workspace;
  return { projectName: name, workspace, previous, bindsHome };
}

/**
 * Resolve which Project to mutate for Access CLI when -p is omitted.
 * Priority: unique cwd Access match → active state → defaultContext.
 * Never invents a project.
 */
export function resolveProjectNameForAccessEdit(
  config: Config,
  cwd: string,
  flag?: string | null,
  activeName?: string | null,
): { name: string; source: "flag" | "cwd" | "active-state" | "default" } | { error: string } {
  if (flag?.trim()) {
    const name = flag.trim();
    if (!config.contexts[name]) {
      return {
        error: `Unknown project "${name}". Available: ${Object.keys(config.contexts).join(", ") || "(none)"}.`,
      };
    }
    return { name, source: "flag" };
  }

  const matches = matchProjectsByCwd(config, cwd);
  if (matches.length === 1) return { name: matches[0]!, source: "cwd" };
  if (matches.length > 1) {
    return {
      error: `Multiple projects match this directory (${matches.join(", ")}). Pass -p <project>.`,
    };
  }

  const active = activeName?.trim();
  if (active && config.contexts[active]) return { name: active, source: "active-state" };

  const fallback = config.defaultContext?.trim();
  if (fallback && config.contexts[fallback]) return { name: fallback, source: "default" };

  return {
    error:
      "No project to edit. Pass -p <project>, or create one in the Bumper app / interactive `bumper <cli>`.",
  };
}
