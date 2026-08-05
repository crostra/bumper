/**
 * Library Git Connections — named host/identity labels for Projects.
 *
 * A Connection holds provider/host/identity metadata in config only. It holds no
 * secret and grants no access. The room receives no credential from this model;
 * Labels/commit identity here are separate from provider-scoped GitHub App access
 * (see room/assurance git-credentials).
 *
 * SSH host config / agent sockets are intentionally out of scope — Bumper does
 * not claim SSH as managed and does not mount ~/.ssh into Rooms.
 */
import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { logEvent } from "./log.js";
import { stateFilePath } from "./paths.js";
import type { Config, GitConnection } from "./types.js";

export type GitProvider = GitConnection["provider"];

export interface GitConnectionPublic {
  id: string;
  name: string;
  provider: GitProvider;
  host: string;
  identity: string;
  userName: string;
  userEmail: string;
  /** Host path ref only — never a secret value. */
  sshKeyPath: string;
  /** Library status vocab: always Host Git for L1. */
  status: "host-git";
}

/** Path of the removed host-side token store (deleted on startup if still present). */
export function gitConnectionSecretsPath(): string {
  return join(dirname(stateFilePath()), "git-connection-secrets.json");
}

/**
 * One-shot migration: remove the obsolete git-connection-secrets.json file.
 * Users may have pasted real PATs into an earlier build; nothing reads them now.
 * Logs a single Events line with no token material.
 */
export function purgeLegacyGitConnectionSecrets(): boolean {
  const path = gitConnectionSecretsPath();
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
  } catch {
    return false;
  }
  logEvent({
    context: "_system",
    surface: "session",
    source: "app",
    type: "system",
    decision: "allowed",
    target: "Removed obsolete Git Connection secrets store",
    reason: "git-connection-secrets.json deleted — Connections hold labels only; GitHub App access is separate",
  });
  return true;
}

export function normalizeGitConnectionId(raw: string): string {
  const id = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!id) throw new Error("Git Connection id is required.");
  return id;
}

export function normalizeGitHost(raw: string, provider: GitProvider = "github"): string {
  let host = String(raw ?? "").trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!host) {
    if (provider === "github") return "github.com";
    if (provider === "gitlab") return "gitlab.com";
    if (provider === "bitbucket") return "bitbucket.org";
    throw new Error("Git host is required.");
  }
  return host;
}

/**
 * Validate the SSH key path reference. Bumper never reads the key, but the value
 * is interpolated into GIT_SSH_COMMAND in the host command we tell the user to
 * copy — and git runs GIT_SSH_COMMAND through a shell. So the stored value must
 * be a plain path: no shell metacharacters, no newlines, no relative paths.
 */
export function normalizeSshKeyPath(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value || value === "~") return "";
  if (!(value.startsWith("/") || value.startsWith("~/"))) {
    throw new Error(
      `SSH key path must be absolute or start with "~/" — got "${value}".`,
    );
  }
  // Characters a shell treats as syntax. Spaces are allowed — the key is quoted
  // inside GIT_SSH_COMMAND (see buildHostCommand), so paths like
  // "/Users/my name/.ssh/id_ed25519" still work.
  if (/[;&|<>$`'"\\]/.test(value)) {
    throw new Error(
      "SSH key path may not contain quotes or shell metacharacters — " +
        "it is pasted into a host command.",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("SSH key path may not contain control characters.");
  }
  if (value.includes("..")) throw new Error("SSH key path may not contain \"..\".");
  return value;
}

export function listGitConnections(config: Config): GitConnectionPublic[] {
  return Object.entries(config.gitConnections ?? {})
    .map(([id, conn]) => ({
      id,
      name: conn.name || id,
      provider: conn.provider,
      host: conn.host,
      identity: conn.identity ?? "",
      userName: conn.userName ?? "",
      userEmail: conn.userEmail ?? "",
      sshKeyPath: conn.sshKeyPath ?? "",
      status: "host-git" as const,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getGitConnection(config: Config, id: string | undefined): (GitConnection & { id: string }) | undefined {
  if (!id) return undefined;
  try {
    const normalized = normalizeGitConnectionId(id);
    const conn = config.gitConnections?.[normalized];
    if (!conn) return undefined;
    return { id: normalized, ...conn };
  } catch {
    return undefined;
  }
}

export function upsertGitConnection(
  config: Config,
  input: {
    id?: string;
    name?: string;
    provider?: string;
    host?: string;
    identity?: string;
    userName?: string;
    userEmail?: string;
    sshKeyPath?: string;
  },
): { id: string; connection: GitConnection } {
  const provider = (["github", "gitlab", "bitbucket", "other"].includes(String(input.provider))
    ? String(input.provider)
    : "github") as GitProvider;
  const id = normalizeGitConnectionId(input.id || input.name || "");
  const name = String(input.name ?? id).trim() || id;
  const host = normalizeGitHost(input.host ?? "", provider);
  const identity = String(input.identity ?? "").trim();
  const userName = String(input.userName ?? "").trim();
  const userEmail = String(input.userEmail ?? "").trim();
  const sshKeyPath = normalizeSshKeyPath(input.sshKeyPath);
  const connection: GitConnection = {
    name,
    provider,
    host,
    identity,
    userName,
    userEmail,
    sshKeyPath,
  };
  return { id, connection };
}

export function projectsUsingGitConnection(config: Config, id: string): string[] {
  const normalized = normalizeGitConnectionId(id);
  return Object.entries(config.contexts)
    .filter(([, ctx]) => ctx.gitConnectionId === normalized)
    .map(([name]) => name);
}

/** True when request host matches the Connection host (exact). */
export function connectionHostMatches(connectionHost: string, requestHost: string): boolean {
  const expected = normalizeGitHost(connectionHost);
  const actual = String(requestHost ?? "").trim().toLowerCase();
  return Boolean(expected && actual && expected === actual);
}
