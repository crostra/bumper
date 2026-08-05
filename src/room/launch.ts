/**
 * Shared Room agent launch wiring (GUI + future CLI).
 *
 * One pipeline builds the mounts used for both executable preflight and real
 * launch. Preflight must not omit auth doors: an empty host overlay can hide
 * image content under vendor trees (e.g. grok under /root/.grok) while a bare
 * image check would still pass.
 *
 * Session-only concerns (PTY, egress proxy listen) stay in SessionManager;
 * this module owns policy-shaped RoomSpec assembly only.
 */
import type { Context } from "../types.js";
import type { AgentId } from "../agents.js";
import type { Door, RoomSpec } from "./backend.js";
import {
  roomAuthDoors,
  roomAuthEnv,
  roomHistoryDoors,
  DEFAULT_AUTH_PROFILE,
  normalizeAuthProfileId,
} from "./auth.js";
import { roomSpecForContext } from "./spec.js";

export interface RoomLaunchMountOptions {
  /** When true (default for agent launches), attach per-agent auth doors. */
  mountAuth?: boolean;
  /**
   * Login profile slot for this agent (Phase 3). Default "default" preserves
   * legacy room-auth host paths. Named profiles isolate tokens.
   */
  profileId?: string | null;
  /**
   * Project name for history isolation overlays (Phase 9-4). When set, history
   * subpaths are mounted from project-agent-state/ on top of the account auth door.
   */
  projectName?: string | null;
}

/**
 * Auth doors for an agent launch. room-shell has no vendor login state.
 */
export function roomLaunchAuthDoors(
  agentId: AgentId | "room-shell",
  options: RoomLaunchMountOptions = {},
): Door[] {
  const mountAuth = options.mountAuth !== false;
  if (!mountAuth || agentId === "room-shell") return [];
  return roomAuthDoors(agentId, options.profileId);
}

/**
 * Resolve profile for an agent from Project.loginProfiles (default profile).
 */
export function profileIdForAgent(
  context: Pick<Context, "loginProfiles"> | undefined,
  agentId: AgentId | "room-shell",
): string {
  if (agentId === "room-shell") return DEFAULT_AUTH_PROFILE;
  const raw = context?.loginProfiles?.[agentId];
  return normalizeAuthProfileId(raw);
}

/**
 * Project policy doors + auth doors — the mount set shared by preflight and
 * launch (before session-only broker / proxy wiring).
 * When profileId is omitted, uses context.loginProfiles[agentId] or "default".
 */
export function roomSpecForAgentLaunch(
  context: Context,
  workspace: string,
  agentId: AgentId | "room-shell",
  options: RoomLaunchMountOptions = {},
): RoomSpec {
  const base = roomSpecForContext(context, workspace);
  const profileId =
    options.profileId !== undefined && options.profileId !== null
      ? normalizeAuthProfileId(options.profileId)
      : profileIdForAgent(context, agentId);
  const authDoors = roomLaunchAuthDoors(agentId, { ...options, profileId });
  const historyDoors =
    agentId === "room-shell" ? [] : roomHistoryDoors(agentId, options.projectName);
  const authEnv = agentId === "room-shell" ? {} : roomAuthEnv(agentId);
  const env = { ...base.env, ...authEnv };
  const extraDoors = [...authDoors, ...historyDoors];
  if (!extraDoors.length) {
    return Object.keys(authEnv).length ? { ...base, env } : base;
  }
  return {
    ...base,
    // History overlays must come after account auth doors so nested mounts win.
    doors: [...base.doors, ...authDoors, ...historyDoors],
    ...(Object.keys(env).length ? { env } : {}),
  };
}

/**
 * One-line summary of the folders a Room can actually reach.
 *
 * The launch banner used to hardcode "Workspace door: /workspace", which is a lie
 * whenever the Project shares selected subpaths only — that config produces no
 * /workspace mount at all, and the agent then reports an empty working directory
 * with no explanation. Report the real doors instead.
 *
 * Auth / history doors under /root are Bumper plumbing, not folders the user chose,
 * so they are excluded.
 */
export function describeFolderDoors(spec: Pick<RoomSpec, "doors">): string {
  const folders = spec.doors.filter((door) => !door.roomPath.startsWith("/root/"));
  if (!folders.length) return "No folder shared — nothing of yours is in the room";
  return folders
    .map((door) => `${door.roomPath} (${door.access === "read-only" ? "read only" : "read + write"})`)
    .join(", ");
}

/** Append doors to a spec without mutating the original. */
export function roomSpecWithExtraDoors(spec: RoomSpec, extra: Door[]): RoomSpec {
  if (!extra.length) return spec;
  return { ...spec, doors: [...spec.doors, ...extra] };
}

/** Electron utility window map key — prefer session.windowKey, else session id. */
export function terminalWindowFocusKey(sessionId: string, windowKey?: string | null): string {
  return windowKey || `session:${sessionId}`;
}
