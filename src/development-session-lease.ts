/**
 * Host-only control and runtime state for development capabilities.
 *
 * The Room gets a request Door but never this lease directory. Consequently it
 * may ask to use Preview or Docker, but it cannot turn either capability on.
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stateDir } from "./paths.js";

export const DEVELOPMENT_HEARTBEAT_MS = 1_000;
export const DEVELOPMENT_STALE_MS = 10_000;

export interface PreviewPortMapping {
  source?: "room" | "docker";
  roomPort: number;
  hostPort: number;
  url: string;
}

export type DockerRuntimeStatus = "idle" | "starting" | "ready" | "stopping" | "failed";

export interface DevelopmentSessionLeaseMeta {
  id: string;
  pid: number;
  projectName: string;
  agentId: string;
  agentName: string;
  startedAt: string;
}

export interface DevelopmentSessionControl {
  previewEnabled: boolean;
  dockerEnabled: boolean;
  updatedAt: string;
}

export interface DevelopmentSessionRuntime {
  previewPorts: PreviewPortMapping[];
  previewError: string;
  dockerStatus: DockerRuntimeStatus;
  dockerError: string;
  updatedAt: string;
}

export interface DevelopmentSessionLease extends DevelopmentSessionLeaseMeta {
  heartbeatAt: string;
  control: DevelopmentSessionControl;
  runtime: DevelopmentSessionRuntime;
  live: boolean;
}

function rootDir(): string {
  return join(stateDir(), "development-session-leases");
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9-]{8,96}$/.test(id);
}

function paths(id: string): { meta: string; control: string; heartbeat: string; runtime: string } {
  if (!validId(id)) throw new Error("Invalid Development Session id.");
  const root = rootDir();
  return {
    meta: join(root, `${id}.lease.json`),
    control: join(root, `${id}.control.json`),
    heartbeat: join(root, `${id}.heartbeat`),
    runtime: join(root, `${id}.runtime.json`),
  };
}

function atomicWrite(path: string, value: string): void {
  mkdirSync(rootDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
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

function emptyRuntime(at: string): DevelopmentSessionRuntime {
  return {
    previewPorts: [],
    previewError: "",
    dockerStatus: "idle",
    dockerError: "",
    updatedAt: at,
  };
}

export function createDevelopmentSessionLease(input: Omit<DevelopmentSessionLeaseMeta, "startedAt"> & {
  startedAt?: string;
  previewEnabled: boolean;
  dockerEnabled: boolean;
}): DevelopmentSessionLeaseMeta {
  const startedAt = input.startedAt || new Date().toISOString();
  const meta: DevelopmentSessionLeaseMeta = {
    id: input.id,
    pid: input.pid,
    projectName: input.projectName,
    agentId: input.agentId,
    agentName: input.agentName,
    startedAt,
  };
  const file = paths(input.id);
  atomicWrite(file.meta, `${JSON.stringify(meta, null, 2)}\n`);
  atomicWrite(file.control, `${JSON.stringify({
    previewEnabled: input.previewEnabled,
    dockerEnabled: input.dockerEnabled,
    updatedAt: startedAt,
  }, null, 2)}\n`);
  atomicWrite(file.runtime, `${JSON.stringify(emptyRuntime(startedAt), null, 2)}\n`);
  atomicWrite(file.heartbeat, `${startedAt}\n`);
  return meta;
}

export function heartbeatDevelopmentSessionLease(id: string, at = new Date().toISOString()): boolean {
  const file = paths(id);
  if (!existsSync(file.meta)) return false;
  atomicWrite(file.heartbeat, `${at}\n`);
  return true;
}

export function readDevelopmentSessionLease(
  id: string,
  now = Date.now(),
  alive: (pid: number) => boolean = processAlive,
): DevelopmentSessionLease | undefined {
  const file = paths(id);
  const meta = readJson<DevelopmentSessionLeaseMeta>(file.meta);
  const control = readJson<DevelopmentSessionControl>(file.control);
  const runtime = readJson<DevelopmentSessionRuntime>(file.runtime);
  if (!meta || meta.id !== id || !control || !runtime) return undefined;
  let heartbeatAt = "";
  try { heartbeatAt = readFileSync(file.heartbeat, "utf8").trim(); } catch { /* stale */ }
  const heartbeatMs = Date.parse(heartbeatAt);
  const live = alive(meta.pid)
    && Number.isFinite(heartbeatMs)
    && now - heartbeatMs <= DEVELOPMENT_STALE_MS;
  return { ...meta, heartbeatAt, control, runtime, live };
}

export function listDevelopmentSessionLeases(
  now = Date.now(),
  alive: (pid: number) => boolean = processAlive,
): DevelopmentSessionLease[] {
  let names: string[] = [];
  try { names = readdirSync(rootDir()); } catch { return []; }
  return names
    .filter((name) => name.endsWith(".lease.json"))
    .map((name) => name.slice(0, -".lease.json".length))
    .map((id) => readDevelopmentSessionLease(id, now, alive))
    .filter((lease): lease is DevelopmentSessionLease => Boolean(lease))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function updateDevelopmentSessionControl(
  id: string,
  patch: Partial<Pick<DevelopmentSessionControl, "previewEnabled" | "dockerEnabled">>,
  at = new Date().toISOString(),
): DevelopmentSessionControl {
  const file = paths(id);
  if (!existsSync(file.meta)) throw new Error("Development Session is no longer running.");
  const current = readJson<DevelopmentSessionControl>(file.control);
  if (!current) throw new Error("Development Session control is unavailable.");
  const next = {
    previewEnabled: typeof patch.previewEnabled === "boolean" ? patch.previewEnabled : current.previewEnabled,
    dockerEnabled: typeof patch.dockerEnabled === "boolean" ? patch.dockerEnabled : current.dockerEnabled,
    updatedAt: at,
  };
  atomicWrite(file.control, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function updateDevelopmentSessionRuntime(
  id: string,
  patch: Partial<Omit<DevelopmentSessionRuntime, "updatedAt">>,
  at = new Date().toISOString(),
): DevelopmentSessionRuntime {
  const file = paths(id);
  const current = readJson<DevelopmentSessionRuntime>(file.runtime) ?? emptyRuntime(at);
  const next = { ...current, ...patch, updatedAt: at };
  atomicWrite(file.runtime, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function removeDevelopmentSessionLease(id: string): void {
  const file = paths(id);
  for (const path of Object.values(file)) {
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
  }
}
