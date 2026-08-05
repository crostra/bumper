/**
 * macOS RoomBackend backed by Apple's `container` (Containerization framework).
 *
 * Each room is a lightweight Linux virtual machine (its own microVM), so the
 * boundary is a hypervisor boundary — structurally un-bypassable from inside.
 * This backend only translates a capability-level RoomSpec into `container run`
 * flags; it holds no policy of its own.
 *
 * Validated on this host (P0 spike, macOS 26.4.1 / Apple Silicon, container
 * 1.1.0): guest boots (kernel 6.18), unmounted host paths are absent, readonly
 * mounts reject writes, and `--network none` leaves only loopback (egress hard
 * blocked). See docs/ARCHITECTURE.md.
 */
import { execFile, spawn as spawnProcess } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import type { Availability, RoomBackend, RoomProcess, RoomSpec, RunResult } from "./backend.js";

const exec = promisify(execFile);

/**
 * node-pty is the only native module Bumper depends on, and only `spawn()` —
 * the GUI's attached-terminal path — needs it. Importing it at module scope
 * made every CLI command require a working native build: `bumper doctor`,
 * which never opens a pty, failed outright when node-pty was missing.
 *
 * That is the whole `npm i -g` install surface hanging off a module the CLI
 * does not use, so the require is deferred to first use. `createRequire`
 * (not `await import`) keeps `spawn()` synchronous, which its callers need.
 */
type PtyModule = { spawn: typeof import("node-pty").spawn };
let ptyModule: PtyModule | undefined;

function loadPty(): PtyModule {
  if (!ptyModule) {
    ptyModule = createRequire(import.meta.url)("node-pty") as PtyModule;
  }
  return ptyModule;
}

/** The signed pkg installs the CLI here (installRoot=/usr/local). */
const CONTAINER_BIN = "/usr/local/bin/container";

function egressArgs(spec: RoomSpec): string[] {
  switch (spec.egress.mode) {
    case "blocked":
      return ["--network", "none"];
    case "open":
      return []; // attaches the default network
    case "allowlist":
      /*
       * Attach the host-only network the session layer prepared. On it the only
       * reachable address is the host, where Bumper's filtering proxy listens —
       * so a direct-IP connection has nowhere to go and the allowlist holds
       * structurally (see egress-network.ts for the measurements).
       *
       * Without a network name we would silently fall back to the default
       * network, where any IP is reachable and the allowlist is decorative.
       * Refuse instead: a boundary that quietly degrades is worse than an error.
       */
      if (!spec.egress.network) {
        throw new Error("Allowlist rooms require a host-only egress network. Bumper did not prepare one.");
      }
      return ["--network", spec.egress.network];
  }
}

function doorArgs(spec: RoomSpec): string[] {
  const args: string[] = [];
  for (const door of spec.doors) {
    const readonly = door.access === "read-only" ? ",readonly" : "";
    args.push("--mount", `type=bind,source=${door.hostPath},target=${door.roomPath}${readonly}`);
  }
  return args;
}

function publishedSocketArgs(spec: RoomSpec): string[] {
  const args: string[] = [];
  for (const socket of spec.publishSockets ?? []) {
    args.push("--publish-socket", `${socket.hostPath}:${socket.roomPath}`);
  }
  return args;
}

/** Translate a capability-level RoomSpec into `container run` arguments. */
export function buildRunArgs(spec: RoomSpec, command: string[], interactive = false): string[] {
  const args = ["run", "--rm"];
  if (interactive) args.push("--interactive", "--tty");
  if (spec.name) args.push("--name", spec.name);
  if (spec.dropCapabilities !== false) args.push("--cap-drop", "ALL");
  if (spec.workdir) args.push("--workdir", spec.workdir);
  if (spec.cpus) args.push("--cpus", String(spec.cpus));
  if (spec.memoryMiB) args.push("--memory", `${spec.memoryMiB}M`);
  for (const [key, value] of Object.entries(spec.env ?? {})) args.push("--env", `${key}=${value}`);
  args.push(...doorArgs(spec), ...publishedSocketArgs(spec), ...egressArgs(spec));
  args.push(spec.image, ...command);
  return args;
}

export class AppleContainerBackend implements RoomBackend {
  readonly id = "apple-container";
  readonly label = "Apple container (macOS)";

  async check(): Promise<Availability> {
    if (process.platform !== "darwin") {
      return { usable: false, detail: "Apple container requires macOS." };
    }
    try {
      const { stdout } = await exec(CONTAINER_BIN, ["--version"]);
      return { usable: true, detail: stdout.trim() };
    } catch {
      return { usable: false, detail: "`container` CLI not found — install Apple container 1.1.0+." };
    }
  }

  async run(spec: RoomSpec, command: string[]): Promise<RunResult> {
    const args = buildRunArgs(spec, command);
    try {
      const { stdout, stderr } = await exec(CONTAINER_BIN, args, { maxBuffer: 64 * 1024 * 1024 });
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
      };
    }
  }

  spawn(spec: RoomSpec, command: string[], options: { cols: number; rows: number }): RoomProcess {
    const term = loadPty().spawn(CONTAINER_BIN, buildRunArgs(spec, command, true), {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      env: { ...process.env, TERM: "xterm-256color", NO_COLOR: "1" } as Record<string, string>,
    });
    return {
      pid: term.pid,
      write: (data) => term.write(data),
      resize: (cols, rows) => term.resize(cols, rows),
      kill: (signal) => {
        try { term.kill(signal); } catch { /* already gone */ }
        // `container run --rm` leaves the room running when only the client
        // process is signalled — Stop must actually stop the microVM.
        if (spec.name) {
          try {
            spawnProcess(CONTAINER_BIN, ["stop", spec.name], { stdio: "ignore", detached: true }).unref();
          } catch { /* best effort */ }
        }
      },
      onData: (callback) => { term.onData(callback); },
      onExit: (callback) => { term.onExit(({ exitCode }) => callback({ exitCode })); },
    };
  }
}
