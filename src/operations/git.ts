/**
 * Git access for a Project, and for one live Session.
 *
 * The Session controls are the interesting part: a running Sandbox holds a
 * GitHub installation token, and turning access Off has to actually take it
 * back. The GUI handler carried that sequence inline — validate the lease, make
 * sure the Project's bindings still match what the Session was opened against,
 * write the control, then sweep revocation across *every* connection the
 * Session could have minted from.
 *
 * That last step is why this belongs in one place. A Session may hold one token
 * per (owner, rung); revoking only the lease's own connection leaves live
 * tokens behind after an explicit Off. A second entry point re-deriving that
 * sequence would get it subtly wrong, and the failure is silent.
 */
import type { Config } from "../types.js";
import { projectGitBindings, projectGitCeiling } from "../git-repositories.js";
import {
  effectiveLeaseAccess,
  listGitSessionLeases,
  readGitSessionLease,
  updateGitSessionLease,
} from "../git-session-lease.js";
import type { GitAccess } from "../git-broker.js";
import { logEvent } from "../log.js";
import { OperationError } from "./error.js";

/** Temporary write elevation, matching the GUI's window. */
export const GIT_WRITE_WINDOW_MS = 15 * 60_000;

export type GitSessionAction = "disable" | "enable" | "read" | "write";

export function configuredGitAccess(config: Config, projectName: string): GitAccess {
  const ceiling = projectGitCeiling(config.contexts[projectName]);
  if (ceiling === "none") return "none";
  return ceiling === "read" ? "read" : "write";
}

export interface ProjectGitView {
  projectName: string;
  ceiling: string;
  bindings: { fullName: string; capability: string; connectionId: string }[];
}

export function describeProjectGit(config: Config, projectName: string): ProjectGitView {
  const project = config.contexts[projectName];
  if (!project) {
    throw new OperationError("not-found", `Unknown project "${projectName}".`, ["bumper project list"]);
  }
  return {
    projectName,
    ceiling: projectGitCeiling(project),
    bindings: projectGitBindings(project).map((row) => ({
      fullName: row.fullName,
      capability: row.capability,
      connectionId: row.connectionId,
    })),
  };
}

export interface GitSessionView {
  id: string;
  projectName: string;
  agentName: string;
  repository: string;
  live: boolean;
  enabled: boolean;
  writeUntil: string;
  effectiveAccess: GitAccess;
}

export function listGitSessions(config: Config, onlyProject?: string): GitSessionView[] {
  return listGitSessionLeases((projectName) => configuredGitAccess(config, projectName))
    .filter((lease) => (onlyProject ? lease.projectName === onlyProject : true))
    .map((lease) => ({
      id: lease.id,
      projectName: lease.projectName,
      agentName: lease.agentName,
      repository: lease.repository,
      live: lease.live,
      enabled: lease.control.enabled,
      writeUntil: lease.control.writeUntil,
      effectiveAccess: lease.effectiveAccess,
    }));
}

export interface SetGitSessionAccessResult {
  sessionId: string;
  projectName: string;
  action: GitSessionAction;
  enabled: boolean;
  writeUntil: string;
  effectiveAccess: GitAccess;
  revoked: number;
  /** Connections whose revoke did not land; a sweep retries them later. */
  pendingConnections: string[];
}

export interface SetGitSessionAccessInput {
  config: Config;
  sessionId: string;
  action: GitSessionAction;
  /** Injected so this stays testable without a GitHub App. */
  revokeSession: (connectionId: string, sessionId: string) => Promise<{ revoked: number; pending: number }>;
  now?: number;
}

export async function setGitSessionAccess(
  input: SetGitSessionAccessInput,
): Promise<SetGitSessionAccessResult> {
  const sessionId = input.sessionId.trim();
  if (!/^[a-zA-Z0-9-]{8,96}$/.test(sessionId)) {
    throw new OperationError("invalid", "Invalid Git Session id.", ["bumper git sessions"]);
  }

  const discovered = readGitSessionLease(sessionId, "read");
  const initial = discovered
    ? readGitSessionLease(sessionId, configuredGitAccess(input.config, discovered.projectName))
    : undefined;
  if (!initial?.live) {
    throw new OperationError(
      "conflict",
      "This Git Session is no longer live. Its access is being revoked.",
      ["bumper git sessions        # the Sessions that are still running"],
    );
  }

  const project = input.config.contexts[initial.projectName];
  const projectAccess = configuredGitAccess(input.config, initial.projectName);
  const bindings = projectGitBindings(project);

  /*
   * The lease records the repositories the Session was opened against. If the
   * Project's set has changed since, enabling would silently widen or redirect
   * a running Session, so only "disable" stays available.
   */
  const bindingMatches = Boolean(
    bindings.length
    && bindings.map((row) => row.fullName).join(", ").toLowerCase() === initial.repository.toLowerCase(),
  );
  if (input.action !== "disable" && (projectAccess === "none" || !bindingMatches)) {
    throw new OperationError(
      "conflict",
      "The Project Git binding changed. This Session stays Off; start a new Session.",
      ["Exit the AI CLI and run it again to pick up the new binding."],
    );
  }

  const now = input.now ?? Date.now();
  let enabled: boolean;
  let writeUntil: string;
  switch (input.action) {
    case "disable": enabled = false; writeUntil = ""; break;
    case "enable":
    case "read": enabled = true; writeUntil = ""; break;
    case "write": enabled = true; writeUntil = new Date(now + GIT_WRITE_WINDOW_MS).toISOString(); break;
    default:
      throw new OperationError("invalid", "Unknown Git Session access action.", [
        "bumper git off|read|write <session-id>",
      ]);
  }

  const control = updateGitSessionLease(sessionId, { enabled, writeUntil });

  const connectionIds = [...new Set([
    initial.connectionId,
    ...bindings.map((row) => row.connectionId),
  ].filter(Boolean))];
  let revoked = 0;
  const pendingConnections: string[] = [];
  for (const connectionId of connectionIds) {
    try {
      const result = await input.revokeSession(connectionId, sessionId);
      revoked += result.revoked;
      if (result.pending) pendingConnections.push(connectionId);
    } catch {
      pendingConnections.push(connectionId);
    }
  }

  const access = effectiveLeaseAccess(projectAccess, control, now);

  /*
   * The audit record is a product claim, not a GUI feature. Writing it here
   * means `bumper git off` leaves the same trace the app's toggle does —
   * outside, one of the two would have been silent.
   */
  const target = input.action === "disable"
    ? "Live Git access disabled"
    : input.action === "write"
      ? "Temporary Git write access started"
      : initial.effectiveAccess === "write"
        ? "Temporary Git write access ended"
        : "Live Git access enabled";
  logEvent({
    context: initial.projectName,
    surface: "session",
    source: "app",
    type: "git",
    decision: pendingConnections.length ? "failed" : "allowed",
    target,
    reason: pendingConnections.length
      ? `Session control applied as ${access}; ${pendingConnections.length} prior token revocation(s) pending`
      : `Session control applied as ${access}; ${revoked} prior token(s) revoked`,
    sessionId,
    repository: initial.repository,
    access,
    expiresAt: writeUntil || undefined,
  });

  return {
    sessionId,
    projectName: initial.projectName,
    action: input.action,
    enabled: control.enabled,
    writeUntil: control.writeUntil,
    effectiveAccess: access,
    revoked,
    pendingConnections,
  };
}

/**
 * Fold connections whose revoke did not land into the retry list.
 *
 * Shared because the GUI edits raw JSON and the CLI edits a parsed Config; the
 * dedupe rule must not exist twice. Dropping a connection here means a live
 * token outlives an explicit Off.
 */
export function mergeSweepConnections(existing: unknown, pending: string[]): string[] {
  const current = Array.isArray(existing) ? existing.map((value) => String(value)) : [];
  return [...new Set([...current, ...pending])];
}
