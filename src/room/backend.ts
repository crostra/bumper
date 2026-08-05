/**
 * The "sealed room" abstraction — the Backend Interface (P0).
 *
 * A room is a disposable, structurally-isolated environment an AI agent runs
 * inside. It has NOTHING except what is explicitly granted: some folders shared
 * in as "doors" (read-only or read-write) and an egress policy. Everything
 * outside — the rest of the host disk, the network — simply does not exist for
 * the process in the room. Containment is by construction (allow-list), not by
 * enumerating what to forbid (deny-list).
 *
 * This file describes rooms purely in terms of *capabilities*, never in terms of
 * any single OS mechanism. A RoomBackend translates a RoomSpec into whatever the
 * host OS provides — Apple `container` on macOS, namespaces/seccomp/Landlock on
 * Linux, WSL2 on Windows. Everything ABOVE this interface (policy, GUI,
 * templates, audit, evidence) is written once and shared across OSes; only
 * implementations of this interface are per-OS. Keep OS specifics out of this
 * file: that separation is the whole point of the seam.
 */

/** A folder shared into the room. The room sees only what is mounted here. */
export interface Door {
  /** Absolute path on the host. */
  hostPath: string;
  /** Where it appears inside the room (absolute path). */
  roomPath: string;
  access: "read-only" | "read-write";
}

/** A private Unix socket projected between the host and one Room. */
export interface PublishedSocket {
  /** Absolute socket path on the host. */
  hostPath: string;
  /** Absolute socket path inside the Room. */
  roomPath: string;
}

/** Where the room is allowed to talk to. */
export type Egress =
  /** No network at all — only loopback exists inside the room (hard block). */
  | { mode: "blocked" }
  /** Unrestricted network. Use only for rooms you explicitly trust. */
  | { mode: "open" }
  /**
   * Only these hosts, via a filtering proxy on the host.
   *
   * `network` is what makes the allowlist a boundary rather than a convention:
   * it names a host-only container network whose only reachable address is the
   * host running the proxy. Without it the room can still open a raw socket to
   * any IP, so a spec that omits `network` is honest about being unenforced.
   */
  | { mode: "allowlist"; hosts: string[]; network?: string };

/** A sealed room, described purely by capability. OS-independent. */
export interface RoomSpec {
  /** Base image: the room's toolchain and nothing more. */
  image: string;
  /** Folders shared in. Anything not listed is unreachable by construction. */
  doors: Door[];
  /** Egress policy. The safe default is "blocked". */
  egress: Egress;
  /** Working directory inside the room. */
  workdir?: string;
  /** Environment variables to set inside the room. */
  env?: Record<string, string>;
  /**
   * Private host↔Room Unix sockets. Unlike a TCP publish this does not add a
   * network interface and therefore can coexist with egress mode "blocked".
   */
  publishSockets?: PublishedSocket[];
  /** Drop all Linux capabilities inside the room (hardening). Default: true. */
  dropCapabilities?: boolean;
  /** CPU ceiling (cores). */
  cpus?: number;
  /** Memory ceiling (MiB). */
  memoryMiB?: number;
  /**
   * Stable identity for this room instance. Killing the client process only
   * detaches the terminal; the backend needs a handle to stop the room itself.
   */
  name?: string;
}

/** Result of a one-shot command run in a room. */
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Minimal PTY surface used by SessionManager. */
export interface RoomProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number }) => void): void;
}

/** Whether a backend can run on this host right now, and why not if it can't. */
export interface Availability {
  usable: boolean;
  /** Human-readable detail: a version string when usable, a reason when not. */
  detail: string;
}

/**
 * An OS-swappable enforcement backend.
 *
 * `run` is the P0 primitive: spin up a fresh room, run one command, dispose it.
 * It is enough to prove the boundary and to power the verification/"break-out"
 * tests. Interactive, streamed sessions (a live terminal into a long-lived room)
 * arrive as a `spawn` method in P1 — they layer on the same RoomSpec.
 */
export interface RoomBackend {
  /** Stable identifier, e.g. "apple-container". */
  readonly id: string;
  /** Human-readable name for the UI. */
  readonly label: string;
  /** Is this backend usable on the current host right now? */
  check(): Promise<Availability>;
  /** Run a single command inside a fresh room, then dispose it. */
  run(spec: RoomSpec, command: string[]): Promise<RunResult>;
  /** Start a long-lived interactive process inside a fresh room. */
  spawn?(spec: RoomSpec, command: string[], options: { cols: number; rows: number }): RoomProcess;
}
