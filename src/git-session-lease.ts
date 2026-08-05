/**
 * Host-side live Git Session leases.
 *
 * These files are deliberately outside the Room Git door. The Room can ask the
 * credential helper for a token, but it cannot enable or widen its own lease.
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stateDir } from "./paths.js";
import type { GitAccess } from "./git-broker.js";

export const GIT_SESSION_HEARTBEAT_MS = 1_000;
export const GIT_SESSION_STALE_MS = 10_000;

export interface GitSessionLeaseMeta {
  id: string;
  pid: number;
  projectName: string;
  agentId: string;
  agentName: string;
  repository: string;
  connectionId: string;
  startedAt: string;
}

export interface GitSessionLeaseControl {
  enabled: boolean;
  writeUntil: string;
  updatedAt: string;
}

export interface GitSessionLease extends GitSessionLeaseMeta {
  heartbeatAt: string;
  control: GitSessionLeaseControl;
  live: boolean;
  effectiveAccess: GitAccess;
}

function leasesDir(): string {
  return join(stateDir(), "git-session-leases");
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9-]{8,96}$/.test(id);
}

function paths(id: string): { meta: string; control: string; heartbeat: string } {
  if (!validId(id)) throw new Error("Invalid Git Session id.");
  const root = leasesDir();
  return {
    meta: join(root, `${id}.lease.json`),
    control: join(root, `${id}.control.json`),
    heartbeat: join(root, `${id}.heartbeat`),
  };
}

function atomicWrite(path: string, value: string): void {
  mkdirSync(leasesDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  renameSync(tmp, path);
}

function json<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return undefined; }
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function effectiveLeaseAccess(
  projectAccess: GitAccess,
  control: Pick<GitSessionLeaseControl, "enabled" | "writeUntil">,
  now = Date.now(),
): GitAccess {
  if (projectAccess === "none" || !control.enabled) return "none";
  const writeUntil = Date.parse(control.writeUntil);
  if (Number.isFinite(writeUntil) && writeUntil > now) return "write";
  return projectAccess;
}

export function createGitSessionLease(input: Omit<GitSessionLeaseMeta, "id" | "startedAt"> & {
  id?: string;
  startedAt?: string;
  enabled: boolean;
}): GitSessionLeaseMeta {
  const id = input.id || randomUUID();
  const startedAt = input.startedAt || new Date().toISOString();
  const meta: GitSessionLeaseMeta = {
    id,
    pid: input.pid,
    projectName: input.projectName,
    agentId: input.agentId,
    agentName: input.agentName,
    repository: input.repository,
    connectionId: input.connectionId,
    startedAt,
  };
  const file = paths(id);
  atomicWrite(file.meta, `${JSON.stringify(meta, null, 2)}\n`);
  atomicWrite(file.control, `${JSON.stringify({
    enabled: input.enabled,
    writeUntil: "",
    updatedAt: startedAt,
  }, null, 2)}\n`);
  atomicWrite(file.heartbeat, `${startedAt}\n`);
  return meta;
}

export function heartbeatGitSessionLease(id: string, at = new Date().toISOString()): boolean {
  const file = paths(id);
  if (!existsSync(file.meta)) return false;
  atomicWrite(file.heartbeat, `${at}\n`);
  return true;
}

export function readGitSessionLease(
  id: string,
  projectAccess: GitAccess = "read",
  now = Date.now(),
  alive: (pid: number) => boolean = processAlive,
): GitSessionLease | undefined {
  const file = paths(id);
  const meta = json<GitSessionLeaseMeta>(file.meta);
  const control = json<GitSessionLeaseControl>(file.control);
  if (!meta || meta.id !== id || !control || typeof control.enabled !== "boolean") return undefined;
  let heartbeatAt = "";
  try { heartbeatAt = readFileSync(file.heartbeat, "utf8").trim(); } catch { /* stale */ }
  const heartbeatMs = Date.parse(heartbeatAt);
  const live = alive(meta.pid)
    && Number.isFinite(heartbeatMs)
    && now - heartbeatMs <= GIT_SESSION_STALE_MS;
  return {
    ...meta,
    heartbeatAt,
    control,
    live,
    effectiveAccess: effectiveLeaseAccess(projectAccess, control, now),
  };
}

export function listGitSessionLeases(
  accessForProject: (projectName: string) => GitAccess = () => "read",
  now = Date.now(),
  alive: (pid: number) => boolean = processAlive,
): GitSessionLease[] {
  let names: string[] = [];
  try { names = readdirSync(leasesDir()); } catch { return []; }
  return names
    .filter((name) => name.endsWith(".lease.json"))
    .map((name) => name.slice(0, -".lease.json".length))
    .map((id) => {
      const meta = json<GitSessionLeaseMeta>(paths(id).meta);
      return meta ? readGitSessionLease(id, accessForProject(meta.projectName), now, alive) : undefined;
    })
    .filter((lease): lease is GitSessionLease => Boolean(lease))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function updateGitSessionLease(
  id: string,
  patch: Partial<Pick<GitSessionLeaseControl, "enabled" | "writeUntil">>,
  now = new Date().toISOString(),
): GitSessionLeaseControl {
  const file = paths(id);
  if (!existsSync(file.meta)) throw new Error("Git Session is no longer running.");
  const current = json<GitSessionLeaseControl>(file.control);
  if (!current) throw new Error("Git Session control is unavailable.");
  const next: GitSessionLeaseControl = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    writeUntil: typeof patch.writeUntil === "string" ? patch.writeUntil : current.writeUntil,
    updatedAt: now,
  };
  if (!next.enabled) next.writeUntil = "";
  atomicWrite(file.control, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function removeGitSessionLease(id: string): void {
  const file = paths(id);
  for (const path of [file.meta, file.control, file.heartbeat]) {
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
  }
}
