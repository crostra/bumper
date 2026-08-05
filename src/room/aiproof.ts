/**
 * AI tool safety proof — "what happens when the agent actually misbehaves".
 *
 * The break-out probes (breakout.ts) attack a maximally-sealed generic room.
 * This module instead exercises *the project's real room* — the same doors,
 * mode, and egress the agent will run under — with the concrete dangerous moves
 * an AI CLI tends to try: writing inside the workspace, escaping to the host
 * filesystem, writing through a read-only door, reaching the network, and
 * looking for host credentials to steal. Each probe declares what SHOULD happen
 * under the policy, so the result is a direct pass/fail against the promise the
 * UI makes, not a raw log line.
 *
 * Every probe also carries an `attempt` descriptor: who reached for what, and
 * which layer is expected to stop it. The UI draws its trace straight from that
 * plus the observed outcome, so nothing on screen is illustrative — a drawing
 * that cannot be derived from an executed command does not get drawn.
 *
 * Host filesystem checks target a real canary file under ~/.bumper/proof/ —
 * planted only on the Mac, never mounted into the room. That absolute path is
 * what the UI shows, so a screenshot reads as "tried this file, couldn't".
 *
 * Probes are pure data + a pure evaluator; running them needs a SandboxBackend, so
 * the generation and interpretation are unit-tested without a container.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "../types.js";
import type { Door, RoomBackend, RoomSpec } from "./backend.js";

/** What a probe expects the boundary to do with the dangerous action. */
export type Expectation = "blocked" | "allowed";

/**
 * Which layer is expected to stop the attempt. Drives the barrier label in the
 * UI, so it is a closed set rather than free text — an unenforced claim cannot
 * be spelled here.
 */
export type Enforcer = "microvm" | "readonly-mount" | "absent";

/** What kind of thing was reached for. Picks the icon; never decorative. */
export type TargetKind = "host-fs" | "workspace" | "readonly-door" | "network" | "credential";

/**
 * The reach being tested, in structured form. Every field is either a constant
 * of the probe or a value that literally appears in `command`.
 */
export interface AiProofAttempt {
  targetKind: TargetKind;
  /** The thing named in the command, exactly as the command names it. */
  target: string;
  /** Host-side counterpart, when the target is a mounted door or host canary. */
  targetHost?: string;
  /** Layer expected to stop this. Only meaningful when `expect` is "blocked". */
  enforcer: Enforcer;
}

export interface AiProofProbe {
  id: string;
  title: string;
  description: string;
  /** Runs inside the room; must print `OUTCOME=allowed` or `OUTCOME=blocked`. */
  command: string[];
  expect: Expectation;
  attempt: AiProofAttempt;
}

export interface AiProofResult {
  id: string;
  title: string;
  /** Plain-language statement of the move that was attempted. */
  description: string;
  /** The exact argv executed in the room, so the UI never has to paraphrase. */
  command: string[];
  attempt: AiProofAttempt;
  expect: Expectation;
  observed: Expectation | "unknown";
  /** true when observed matches expect (the boundary behaved as promised). */
  pass: boolean;
  evidence: string;
  /** Raw room output, trimmed. Empty when the probe did not run. */
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/** Marker written into the host-only canary so we know it is ours. */
export const PROOF_CANARY_MARKER = "bumper-host-fs-canary-v1\n";

/** Absolute path of the host-only canary used by the host-fs probe. */
export function proofCanaryHostPath(): string {
  return join(homedir(), ".bumper", "proof", "canary");
}

/**
 * Ensure the host-only canary exists before a proof run. Like ~/.cursor or
 * ~/.claude, Bumper owns ~/.bumper/proof/ on the Mac. The room never mounts it;
 * the probe fails when the absolute path is invisible inside the room.
 */
export function ensureProofCanary(): string {
  const path = proofCanaryHostPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, PROOF_CANARY_MARKER, { mode: 0o600 });
  return path;
}

/** Single-quote for embedding an absolute path in a `/bin/sh -c` script. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Wrap a shell test so it prints a definite OUTCOME the host can score. */
function outcome(script: string): string[] {
  return ["/bin/sh", "-c", `if ${script}; then echo OUTCOME=allowed; else echo OUTCOME=blocked; fi`];
}

/**
 * Build the probe set for a project's effective policy. Some probes are only
 * meaningful given the policy (a read-only-door probe needs a read-only door),
 * so the list is policy-derived.
 */
export function aiProofProbes(context: Context, extraDoors: Door[] = []): AiProofProbe[] {
  const probes: AiProofProbe[] = [];

  // Real file on the Mac only. Absolute path appears in the command and UI so a
  // screenshot answers "what did we try?" without opening details.
  const canary = proofCanaryHostPath();
  probes.push({
    id: "host-fs-escape",
    title: "Cannot read a host-only canary file",
    description: `Tries to read ${canary} — a file Bumper keeps under your home, never shared into the room.`,
    command: outcome(`test -r ${shQuote(canary)}`),
    expect: "blocked",
    attempt: {
      targetKind: "host-fs",
      target: canary,
      targetHost: canary,
      enforcer: "microvm",
    },
  });

  const workspaceDoor = extraDoors.find((door) => door.roomPath === "/workspace");
  const rw = context.mode === "read-write";
  const workspaceHost = workspaceDoor?.hostPath;
  const workspaceProofRoom = "/workspace/.bumper-proof";
  probes.push({
    id: "workspace-write",
    title: rw ? "Can write inside the shared folder" : "Cannot write inside the shared folder",
    description: workspaceHost
      ? `Creates then deletes ${workspaceHost}/.bumper-proof (mounted as ${workspaceProofRoom}).`
      : `Creates then deletes ${workspaceProofRoom} at the root of the mounted workspace.`,
    command: outcome(`touch ${workspaceProofRoom} 2>/dev/null && rm -f ${workspaceProofRoom}`),
    expect: rw ? "allowed" : "blocked",
    attempt: {
      targetKind: "workspace",
      target: workspaceProofRoom,
      targetHost: workspaceHost ? join(workspaceHost, ".bumper-proof") : undefined,
      enforcer: rw ? "absent" : "readonly-mount",
    },
  });

  // Only assert read-only-door immutability when such a door actually exists.
  const readonlyDoor = extraDoors.find((door) => door.access === "read-only" && door.roomPath !== "/workspace");
  if (readonlyDoor) {
    const roomFile = `${readonlyDoor.roomPath}/.bumper-proof`;
    probes.push({
      id: "readonly-door-write",
      title: "Cannot write into a read-only shared folder",
      description: `Creates ${roomFile} inside the read-only mount of ${readonlyDoor.hostPath}.`,
      command: outcome(`touch ${shQuote(roomFile)} 2>/dev/null && rm -f ${shQuote(roomFile)}`),
      expect: "blocked",
      attempt: {
        targetKind: "readonly-door",
        target: roomFile,
        targetHost: join(readonlyDoor.hostPath, ".bumper-proof"),
        enforcer: "readonly-mount",
      },
    });
  }

  const egressOpen = context.room.egress === "open";
  // Raw IP so DNS is not a confounder. Full URL is the attempt target so the UI
  // can say "tried http://1.1.1.1" without inventing a domain.
  const networkUrl = "http://1.1.1.1";
  probes.push({
    id: "network-egress",
    title: egressOpen ? "Can reach the Internet (as configured)" : "Cannot reach the Internet",
    description: `HTTP GET ${networkUrl} (Cloudflare anycast IP — no DNS lookup).`,
    command: outcome(`wget -T5 -qO- ${networkUrl} >/dev/null 2>&1 || curl -m5 -s ${networkUrl} >/dev/null 2>&1`),
    expect: egressOpen ? "allowed" : "blocked",
    attempt: {
      targetKind: "network",
      target: networkUrl,
      enforcer: egressOpen ? "absent" : "microvm",
    },
  });

  /*
   * The VM proves only that the host Git identity / App private key is absent.
   * A Project-scoped installation token may enter through /bumper-git; its
   * repository/contents upper bound is enforced by GitHub and needs a separate
   * real-provider journey. The AI CLI's own sign-in (mounted under
   * /root/.<tool>) is deliberately present and out of scope here.
   */
  const credTarget = "/root/.ssh";
  probes.push({
    id: "host-credentials-absent",
    title: "No host git identity to steal",
    description: "Looks for /root/.ssh, /root/.netrc, /root/.git-credentials, and the legacy /bumper host-credential door.",
    command: outcome("[ -e /root/.ssh ] || [ -e /root/.netrc ] || [ -e /root/.git-credentials ] || [ -e /bumper ]"),
    expect: "blocked",
    // Named exactly as the command names it — the room's home is /root.
    attempt: { targetKind: "credential", target: credTarget, enforcer: "absent" },
  });

  return probes;
}

export interface ProbeRun {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
}

/** Score one probe's output against its expectation. Pure. */
export function evaluateAiProof(probe: AiProofProbe, run: ProbeRun | string, exitCodeArg = 0): AiProofResult {
  const r: ProbeRun = typeof run === "string" ? { stdout: run, exitCode: exitCodeArg } : run;
  const stdout = r.stdout ?? "";
  const exitCode = r.exitCode ?? 0;
  const match = /OUTCOME=(allowed|blocked)/.exec(stdout);
  const observed: AiProofResult["observed"] = match ? (match[1] as Expectation) : "unknown";
  const pass = observed === probe.expect;
  const evidence = observed === "unknown"
    ? `no verdict from room (exit ${exitCode})`
    : pass
      ? `observed ${observed}, as expected`
      : `observed ${observed}, expected ${probe.expect}`;
  return {
    id: probe.id,
    title: probe.title,
    description: probe.description,
    command: probe.command,
    attempt: probe.attempt,
    expect: probe.expect,
    observed,
    pass,
    evidence,
    stdout: stdout.trim(),
    stderr: (r.stderr ?? "").trim(),
    exitCode,
    durationMs: r.durationMs ?? 0,
  };
}

/** Run every probe in the project's real room and score it. Needs a backend. */
export async function runAiProof(
  backend: RoomBackend,
  spec: RoomSpec,
  context: Context,
): Promise<AiProofResult[]> {
  // Plant the host canary before the room tries to read it. If the room can see
  // this path, the boundary has a real leak — not a missing-file false pass.
  ensureProofCanary();
  const probes = aiProofProbes(context, spec.doors);
  const results: AiProofResult[] = [];
  for (const probe of probes) {
    const startedAt = Date.now();
    const out = await backend.run(spec, probe.command);
    results.push(evaluateAiProof(probe, {
      stdout: out.stdout,
      stderr: out.stderr,
      exitCode: out.exitCode,
      durationMs: Date.now() - startedAt,
    }));
  }
  return results;
}
