/**
 * Phase 3: reusable Project setups — Permission snapshots, MCP sets, login profiles.
 *
 * Permission setup = named boundary snapshot (Access extras / egress / network).
 * Built-in Permission templates (Standard development / Offline edit / Offline review)
 * live in folders.ts and are immutable — never overwritten via custom snapshot save.
 * MCP set = named backend list applied to Project.backends (host proxy only).
 * Login profile selection lives on Context.loginProfiles; host dirs are in room/auth.
 */
import type { Config, Context, PermissionSetup } from "./types.js";
import { DEFAULT_AUTH_PROFILE, normalizeAuthProfileId } from "./room/auth.js";
import {
  builtinPermissionSetup,
  isBuiltinTemplateName,
  listBuiltinPermissionSetups,
  type BuiltinTemplateId,
} from "./folders.js";

export { isBuiltinTemplateName, listBuiltinPermissionSetups, builtinPermissionSetup };

/** Resolve a permission setup by name (built-in first, then custom). */
export function resolvePermissionSetup(
  config: Config,
  name: string,
): PermissionSetup | undefined {
  if (isBuiltinTemplateName(name)) {
    return builtinPermissionSetup(name as BuiltinTemplateId);
  }
  return config.permissionSetups?.[name];
}

/** Fields captured when saving a permission setup from a Project. */
export function snapshotPermissionSetup(project: Context, description?: string): PermissionSetup {
  return {
    description: description ?? project.description,
    mode: project.mode,
    inheritMode: project.inheritMode,
    commands: { ...project.commands },
    native: {
      allow: [...(project.native?.allow ?? [])],
      deny: [...(project.native?.deny ?? [])],
    },
    writePaths: [...(project.writePaths ?? [])],
    readPaths: [...(project.readPaths ?? [])],
    denyReadPaths: [...(project.denyReadPaths ?? [])],
    denyWritePaths: [...(project.denyWritePaths ?? [])],
    gitIgnored: project.gitIgnored ?? "visible",
    // Legacy schema field only — never capture project.repos into a setup.
    repos: [],
    allowedHosts: [...(project.allowedHosts ?? [])],
    room: {
      egress: project.room?.egress,
      egressTemplates: [...(project.room?.egressTemplates ?? [])],
      egressHosts: [...(project.room?.egressHosts ?? [])],
      doors: (project.room?.doors ?? []).map((door) => ({ ...door })),
      workspaceShare: project.room?.workspaceShare,
      shareSubpaths: [...(project.room?.shareSubpaths ?? [])],
      shareEntries: (project.room?.shareEntries ?? []).map((entry) => ({ ...entry })),
      image: project.room?.image,
    },
  };
}

/**
 * Apply a permission setup onto a Project. Does not change name, description,
 * workspace, backends, loginProfiles, or room.enabled.
 */
export function applyPermissionSetup(project: Context, setup: PermissionSetup): Context {
  return {
    ...project,
    mode: setup.mode,
    inheritMode: setup.inheritMode,
    commands: { ...setup.commands },
    native: {
      allow: [...(setup.native?.allow ?? [])],
      deny: [...(setup.native?.deny ?? [])],
    },
    writePaths: [...(setup.writePaths ?? [])],
    readPaths: [...(setup.readPaths ?? [])],
    denyReadPaths: [...(setup.denyReadPaths ?? [])],
    denyWritePaths: [...(setup.denyWritePaths ?? [])],
    gitIgnored: setup.gitIgnored ?? "visible",
    // Do not write project.repos — legacy field, not a boundary.
    allowedHosts: [...(setup.allowedHosts ?? [])],
    room: {
      ...project.room,
      ...(setup.room?.egress ? { egress: setup.room.egress } : {}),
      ...(setup.room?.egressTemplates ? { egressTemplates: [...setup.room.egressTemplates] } : {}),
      ...(setup.room?.egressHosts ? { egressHosts: [...setup.room.egressHosts] } : {}),
      ...(setup.room?.doors ? { doors: setup.room.doors.map((door) => ({ ...door })) } : {}),
      ...(setup.room?.workspaceShare ? { workspaceShare: setup.room.workspaceShare } : {}),
      ...(setup.room?.shareSubpaths ? { shareSubpaths: [...setup.room.shareSubpaths] } : {}),
      ...(setup.room?.shareEntries
        ? { shareEntries: setup.room.shareEntries.map((entry) => ({ ...entry })) }
        : {}),
      ...(setup.room?.image ? { image: setup.room.image } : {}),
      enabled: project.room?.enabled !== false,
    },
  };
}

/** Profile id selected for an agent on a Project (default preserves legacy path). */
export function projectAuthProfileId(
  project: Pick<Context, "loginProfiles"> | undefined,
  agentId: string,
): string {
  const raw = project?.loginProfiles?.[agentId];
  return normalizeAuthProfileId(raw);
}

/** Catalog of profile ids for UI pickers (always includes default + config + project selections). */
export function listAuthProfileIds(config: Config, project?: Context): string[] {
  const ids = new Set<string>([DEFAULT_AUTH_PROFILE]);
  for (const id of config.authProfiles ?? []) {
    const n = normalizeAuthProfileId(id);
    if (n) ids.add(n);
  }
  if (project?.loginProfiles) {
    for (const id of Object.values(project.loginProfiles)) {
      ids.add(normalizeAuthProfileId(id));
    }
  }
  return [...ids].sort((a, b) => {
    if (a === DEFAULT_AUTH_PROFILE) return -1;
    if (b === DEFAULT_AUTH_PROFILE) return 1;
    return a.localeCompare(b);
  });
}

export function sanitizeSetupName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function assertSetupName(name: string): string {
  const n = sanitizeSetupName(name);
  if (!n) throw new Error("Setup name is required.");
  if (n.length > 80) throw new Error("Setup name is too long (max 80).");
  return n;
}
