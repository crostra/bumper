/**
 * Project Docker broker.
 *
 * The AI Room receives only a file request Door and a tiny `docker` wrapper.
 * Commands execute inside a separate privileged Apple-container VM whose host
 * mounts are limited to the selected Project and Bumper's Preview relay.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  rmSync, writeFileSync, writeSync, renameSync,
} from "node:fs";
import { join, posix } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Door, Egress } from "./room/backend.js";
import type { PreviewBrokerParts } from "./preview-broker.js";
import {
  readDevelopmentSessionLease,
  updateDevelopmentSessionRuntime,
} from "./development-session-lease.js";

const exec = promisify(execFile);
const CONTAINER_BIN = "/usr/local/bin/container";
export const DOCKER_ENGINE_BASE_IMAGE = "docker.io/library/docker:27.5.1-dind";
export const DOCKER_ENGINE_IMAGE = "bumper/docker-engine:27.5.1";
const REQUEST_POLL_MS = 150;
const MAX_REQUEST_BYTES = 256 * 1024;

export interface DockerBrokerParts {
  doors: Door[];
  env: Record<string, string>;
}

export interface DockerBrokerEvent {
  decision: "allowed" | "blocked" | "failed";
  target: string;
  reason: string;
}

export interface DockerEngineRunOptions {
  engineName: string;
  workspaceDoors: Door[];
  egress: Egress;
  proxyEnv?: Record<string, string>;
  preview?: PreviewBrokerParts;
}

interface DockerRequest {
  id: string;
  args: string[];
  cwd: string;
  createdAt: string;
}

function requestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{16,64}$/.test(value);
}

function commandFamily(args: string[]): string {
  const word = args.find((arg) => arg && !arg.startsWith("-"));
  if (!word) return "docker";
  if (word === "compose") {
    const sub = args.slice(args.indexOf(word) + 1).find((arg) => arg && !arg.startsWith("-"));
    return sub ? `compose ${sub}` : "compose";
  }
  return word.slice(0, 40);
}

function closeFd(fd: number): void {
  try { closeSync(fd); } catch { /* already closed */ }
}

export function dockerWrapperSource(): string {
  return `import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = process.env.BUMPER_DOCKER_REQUESTS;
if (!root) {
  console.error("bumper: Docker capability is unavailable in this Sandbox.");
  process.exit(125);
}
const id = crypto.randomUUID();
const request = { id, args: process.argv.slice(2), cwd: process.cwd(), createdAt: new Date().toISOString() };
const requestPath = path.join(root, id + ".request.json");
fs.writeFileSync(requestPath + ".tmp", JSON.stringify(request));
fs.renameSync(requestPath + ".tmp", requestPath);
let outAt = 0;
let errAt = 0;
let finished = false;

function copyNew(file, fd, at) {
  try {
    const data = fs.readFileSync(file);
    if (data.length > at) fs.writeSync(fd, data.subarray(at));
    return data.length;
  } catch { return at; }
}
function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}
function cancel() {
  if (finished) return;
  try { fs.writeFileSync(path.join(root, id + ".cancel"), "cancel\\n"); } catch {}
}
process.on("SIGINT", () => cancel());
process.on("SIGTERM", () => cancel());
const timer = setInterval(() => {
  outAt = copyNew(path.join(root, id + ".stdout"), 1, outAt);
  errAt = copyNew(path.join(root, id + ".stderr"), 2, errAt);
  try {
    const resultPath = path.join(root, id + ".result.json");
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const stdoutSize = fileSize(path.join(root, id + ".stdout"));
    const stderrSize = fileSize(path.join(root, id + ".stderr"));
    if (stdoutSize < (result.stdoutBytes || 0) || stderrSize < (result.stderrBytes || 0)) return;
    finished = true;
    clearInterval(timer);
    outAt = copyNew(path.join(root, id + ".stdout"), 1, outAt);
    errAt = copyNew(path.join(root, id + ".stderr"), 2, errAt);
    if (result.error && errAt === 0) fs.writeSync(2, "bumper: " + result.error + "\\n");
    process.exitCode = Number.isInteger(result.exitCode) ? result.exitCode : 125;
  } catch {}
}, 75);
`;
}

/** Pure argv composer so mount/network invariants stay regression-testable. */
export function buildDockerEngineRunArgs(opts: DockerEngineRunOptions): string[] {
  const args = [
    "run", "--name", opts.engineName,
    "--cap-add", "ALL",
    "--workdir", "/workspace",
  ];
  for (const door of opts.workspaceDoors) {
    const readOnly = door.access === "read-only" ? ",readonly" : "";
    args.push("--mount", `type=bind,source=${door.hostPath},target=${door.roomPath}${readOnly}`);
  }
  for (const door of opts.preview?.doors ?? []) {
    const readOnly = door.access === "read-only" ? ",readonly" : "";
    args.push("--mount", `type=bind,source=${door.hostPath},target=${door.roomPath}${readOnly}`);
  }
  if (opts.preview) {
    args.push("--publish-socket", `${opts.preview.socket.hostPath}:${opts.preview.socket.roomPath}`);
    args.push("--entrypoint", "/bin/sh");
  }
  if (opts.egress.mode === "blocked") args.push("--network", "none");
  if (opts.egress.mode === "allowlist") {
    if (!opts.egress.network) throw new Error("Docker allowlist requires the Project host-only network.");
    args.push("--network", opts.egress.network);
  }
  for (const [key, value] of Object.entries(opts.proxyEnv ?? {})) args.push("--env", `${key}=${value}`);
  if (opts.preview) {
    args.push(
      DOCKER_ENGINE_IMAGE,
      "-c",
      "BUMPER_PREVIEW_DOCKER=1 node /bumper-development-helper/preview-relay.mjs </dev/null >/bumper-development-state/preview-relay.log 2>&1 & while [ ! -S /tmp/bumper-preview.sock ]; do sleep 0.05; done; exec /usr/local/bin/dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --storage-driver=vfs",
    );
  } else {
    args.push(
      DOCKER_ENGINE_IMAGE,
      "dockerd",
      "--host=unix:///var/run/docker.sock",
      "--storage-driver=vfs",
    );
  }
  return args;
}

function dockerLauncherSource(): string {
  return `#!/bin/sh
exec node /bumper-docker-helper/docker-wrapper.mjs "$@"
`;
}

export class DockerBroker {
  private timer?: NodeJS.Timeout;
  private engineName: string;
  private engineReady = false;
  private starting?: Promise<void>;
  private engineProcess?: ReturnType<typeof spawn>;
  private engineLog = "";
  private stoppingEngine = false;
  private active = new Map<string, ReturnType<typeof spawn>>();
  private handled = new Set<string>();
  readonly requestDir: string;
  readonly helperDir: string;

  constructor(
    private opts: {
      dir: string;
      sessionId: string;
      projectName: string;
      /** Exact Project Doors under /workspace; selected-share projects stay selected. */
      workspaceDoors: Door[];
      egress: Egress;
      proxyEnv?: Record<string, string>;
      preview?: PreviewBrokerParts;
      onEvent?: (event: DockerBrokerEvent) => void;
    },
  ) {
    this.requestDir = join(opts.dir, "requests");
    this.helperDir = join(opts.dir, "helper");
    this.engineName = `bumper-docker-${opts.sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}`;
  }

  setup(): DockerBrokerParts {
    mkdirSync(this.requestDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.helperDir, "bin"), { recursive: true, mode: 0o700 });
    writeFileSync(join(this.helperDir, "docker-wrapper.mjs"), dockerWrapperSource(), { mode: 0o500 });
    writeFileSync(join(this.helperDir, "bin", "docker"), dockerLauncherSource(), { mode: 0o500 });
    return {
      doors: [
        { hostPath: this.requestDir, roomPath: "/bumper-docker-requests", access: "read-write" },
        { hostPath: this.helperDir, roomPath: "/bumper-docker-helper", access: "read-only" },
      ],
      env: {
        BUMPER_DOCKER_REQUESTS: "/bumper-docker-requests",
        PATH: "/bumper-docker-helper/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      },
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.reconcile(); }, REQUEST_POLL_MS);
    this.timer.unref?.();
    void this.reconcile();
  }

  private event(event: DockerBrokerEvent): void {
    this.opts.onEvent?.(event);
  }

  private engineRunArgs(): string[] {
    return buildDockerEngineRunArgs({
      engineName: this.engineName,
      workspaceDoors: this.opts.workspaceDoors,
      egress: this.opts.egress,
      proxyEnv: this.opts.proxyEnv,
      preview: this.opts.preview,
    });
  }

  private async ensureEngineImage(): Promise<void> {
    try {
      await exec(CONTAINER_BIN, ["image", "inspect", DOCKER_ENGINE_IMAGE], { timeout: 10_000 });
      return;
    } catch { /* build the pinned Bumper engine image */ }
    const buildDir = join(this.opts.dir, "engine-image");
    mkdirSync(buildDir, { recursive: true, mode: 0o700 });
    const containerfile = join(buildDir, "Containerfile");
    writeFileSync(containerfile, [
      `FROM ${DOCKER_ENGINE_BASE_IMAGE}`,
      "RUN apk add --no-cache nodejs",
      "",
    ].join("\n"), { mode: 0o600 });
    this.event({
      decision: "allowed",
      target: "Docker Engine component setup",
      reason: "building pinned Bumper engine image with the Local Preview relay runtime",
    });
    try {
      await exec(CONTAINER_BIN, [
        "build", "--progress", "plain", "-t", DOCKER_ENGINE_IMAGE, "-f", containerfile, buildDir,
      ], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    } catch (cause) {
      throw new Error(`Docker Engine component setup failed: ${(cause as Error).message}`);
    }
  }

  private async ensureEngine(): Promise<void> {
    if (this.engineReady) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      updateDevelopmentSessionRuntime(this.opts.sessionId, { dockerStatus: "starting", dockerError: "" });
      try {
        await this.ensureEngineImage();
        try { await exec(CONTAINER_BIN, ["delete", "--force", this.engineName], { timeout: 5_000 }); }
        catch { /* no stale Engine Room */ }
        this.engineLog = "";
        const engineProcess = spawn(CONTAINER_BIN, this.engineRunArgs(), {
          stdio: ["ignore", "pipe", "pipe"],
        });
        this.engineProcess = engineProcess;
        const collect = (chunk: Buffer) => {
          this.engineLog = `${this.engineLog}${chunk.toString()}`.slice(-16_000);
        };
        engineProcess.stdout?.on("data", collect);
        engineProcess.stderr?.on("data", collect);
        engineProcess.on("error", (error) => collect(Buffer.from(`${error.message}\n`)));
        engineProcess.on("exit", (code) => {
          if (this.engineProcess === engineProcess) this.engineProcess = undefined;
          if (!this.engineReady || this.stoppingEngine) return;
          this.engineReady = false;
          const reason = `Docker Engine Room exited unexpectedly (${code ?? "signal"}).`;
          updateDevelopmentSessionRuntime(this.opts.sessionId, {
            dockerStatus: "failed",
            dockerError: reason,
          });
          this.event({ decision: "failed", target: "Docker Engine Sandbox stopped", reason });
        });
        let last = "";
        for (let attempt = 0; attempt < 80; attempt++) {
          try {
            const result = await exec(CONTAINER_BIN, [
              "exec", this.engineName, "docker", "info", "--format", "{{.ServerVersion}}",
            ], { timeout: 2_000 });
            if (result.stdout.trim()) {
              this.engineReady = true;
              updateDevelopmentSessionRuntime(this.opts.sessionId, { dockerStatus: "ready", dockerError: "" });
              this.event({
                decision: "allowed",
                target: "Docker Engine Sandbox started",
                reason: `Project-scoped engine ${result.stdout.trim()}`,
              });
              return;
            }
          } catch (cause) {
            last = (cause as Error).message;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(last || "Docker Engine did not become ready.");
      } catch (cause) {
        let message = (cause as Error).message;
        if (this.engineLog.trim()) message = `${message}\n${this.engineLog.trim().slice(-4_000)}`;
        try {
          const logs = await exec(CONTAINER_BIN, ["logs", this.engineName], { maxBuffer: 2 * 1024 * 1024 });
          const detail = `${logs.stdout}\n${logs.stderr}`.trim().slice(-4_000);
          if (detail) message = `${message}\n${detail}`;
        } catch { /* container may have exited before logs */ }
        await this.stopEngine();
        updateDevelopmentSessionRuntime(this.opts.sessionId, { dockerStatus: "failed", dockerError: message });
        this.event({ decision: "failed", target: "Docker Engine Sandbox failed", reason: message });
        throw cause;
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  private readRequests(): DockerRequest[] {
    let names: string[] = [];
    try { names = readdirSync(this.requestDir); } catch { return []; }
    const requests: DockerRequest[] = [];
    for (const name of names.filter((value) => value.endsWith(".request.json"))) {
      const path = join(this.requestDir, name);
      try {
        const info = lstatSync(path);
        if (!info.isFile() || info.size > MAX_REQUEST_BYTES) continue;
        const parsed = JSON.parse(readFileSync(path, "utf8")) as DockerRequest;
        if (!requestId(parsed.id) || !Array.isArray(parsed.args) || parsed.args.some((arg) => typeof arg !== "string" || arg.length > 64 * 1024)) continue;
        if (this.handled.has(parsed.id)) continue;
        requests.push(parsed);
      } catch { /* writer may still be renaming */ }
    }
    return requests;
  }

  private resultPath(id: string, suffix: string): string {
    return join(this.requestDir, `${id}.${suffix}`);
  }

  /**
   * The request Door is writable by the Room. Open output files without
   * following symlinks, then keep the fd: replacing the directory entry later
   * cannot redirect host writes.
   */
  private safeOutput(id: string, suffix: "stdout" | "stderr"): number {
    const path = this.resultPath(id, suffix);
    try { rmSync(path, { force: true }); } catch { /* best effort */ }
    return openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  }

  private writeResult(id: string, exitCode: number, error = "", stdoutBytes = 0, stderrBytes = 0): void {
    const target = this.resultPath(id, "result.json");
    const tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({
      exitCode,
      error,
      stdoutBytes,
      stderrBytes,
      finishedAt: new Date().toISOString(),
    }));
    renameSync(tmp, target);
  }

  private reject(request: DockerRequest, reason: string): void {
    this.handled.add(request.id);
    const stderr = this.safeOutput(request.id, "stderr");
    const message = `bumper: ${reason}\n`;
    writeSync(stderr, message);
    closeSync(stderr);
    this.writeResult(request.id, 125, reason, 0, Buffer.byteLength(message));
    this.event({ decision: "blocked", target: `docker ${commandFamily(request.args)}`, reason });
  }

  private async execute(request: DockerRequest): Promise<void> {
    this.handled.add(request.id);
    const lease = readDevelopmentSessionLease(this.opts.sessionId);
    if (!lease?.live || !lease.control.dockerEnabled) {
      this.reject(request, "Docker is Off for this Session.");
      return;
    }
    const family = commandFamily(request.args);
    try {
      await this.ensureEngine();
    } catch {
      this.writeResult(request.id, 125, "Docker Engine Sandbox failed to start.");
      return;
    }
    const cwd = request.cwd === "/workspace" || request.cwd.startsWith("/workspace/")
      ? posix.normalize(request.cwd)
      : "/workspace";
    let stdout = -1;
    let stderr = -1;
    try {
      stdout = this.safeOutput(request.id, "stdout");
      stderr = this.safeOutput(request.id, "stderr");
    } catch {
      closeFd(stdout);
      closeFd(stderr);
      this.writeResult(request.id, 125, "Docker response channel was modified by the Sandbox.");
      this.event({ decision: "blocked", target: `docker ${family}`, reason: "unsafe response channel rejected" });
      return;
    }
    const child = spawn(CONTAINER_BIN, [
      "exec", "--workdir", cwd, this.engineName, "docker", ...request.args,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    this.active.set(request.id, child);
    child.stdout?.on("data", (chunk) => writeSync(stdout, chunk));
    child.stderr?.on("data", (chunk) => writeSync(stderr, chunk));
    const started = Date.now();
    let spawnError = "";
    child.on("error", (cause) => {
      spawnError = (cause as Error).message;
      writeSync(stderr, `${(cause as Error).message}\n`);
    });
    // `close`, not `exit`: all stdout/stderr data has reached the safe host fds
    // before the wrapper observes the result file.
    child.on("close", (code, signal) => {
      this.active.delete(request.id);
      let stdoutBytes = 0;
      let stderrBytes = 0;
      try { stdoutBytes = lstatSync(this.resultPath(request.id, "stdout")).size; } catch { /* empty */ }
      try { stderrBytes = lstatSync(this.resultPath(request.id, "stderr")).size; } catch { /* empty */ }
      closeFd(stdout);
      closeFd(stderr);
      const exitCode = spawnError ? 125 : (code ?? (signal ? 130 : 125));
      this.writeResult(request.id, exitCode, spawnError, stdoutBytes, stderrBytes);
      this.event({
        decision: exitCode === 0 ? "allowed" : "failed",
        target: `docker ${family}`,
        reason: spawnError ? "broker process failed" : `exit ${exitCode}; ${Date.now() - started} ms`,
      });
    });
  }

  async reconcile(): Promise<void> {
    const lease = readDevelopmentSessionLease(this.opts.sessionId);
    if (!lease?.live || !lease.control.dockerEnabled) {
      for (const [id, child] of this.active) {
        child.kill("SIGTERM");
        this.writeResult(id, 130, "Docker disabled or Session ended.");
      }
      this.active.clear();
      if (this.engineReady || this.starting) await this.stopEngine();
    }
    for (const request of this.readRequests()) {
      if (!lease?.live || !lease.control.dockerEnabled) this.reject(request, "Docker is Off for this Session.");
      else void this.execute(request);
    }
    for (const [id, child] of this.active) {
      try {
        if (lstatSync(this.resultPath(id, "cancel")).isFile()) child.kill("SIGINT");
      } catch { /* no cancellation */ }
    }
  }

  private async stopEngine(): Promise<void> {
    if (!this.engineReady && !this.starting) return;
    this.stoppingEngine = true;
    updateDevelopmentSessionRuntime(this.opts.sessionId, { dockerStatus: "stopping" });
    try { await exec(CONTAINER_BIN, ["stop", this.engineName], { timeout: 15_000 }); }
    catch { /* it may already be gone */ }
    this.engineProcess?.kill("SIGTERM");
    this.engineProcess = undefined;
    try { await exec(CONTAINER_BIN, ["delete", "--force", this.engineName], { timeout: 15_000 }); }
    catch { /* it may already be removed */ }
    this.engineReady = false;
    this.stoppingEngine = false;
    updateDevelopmentSessionRuntime(this.opts.sessionId, { dockerStatus: "idle", dockerError: "" });
    this.event({ decision: "blocked", target: "Docker Engine Sandbox stopped", reason: "Session control or lifecycle cleanup" });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const child of this.active.values()) child.kill("SIGTERM");
    this.active.clear();
    await this.stopEngine();
    try { rmSync(this.opts.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
