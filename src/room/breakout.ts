/**
 * Break-out probes — the "prove it" engine (felt trust).
 *
 * Trust is demonstrated, not asserted. Each probe is a real escape attempt run
 * inside a maximally-sealed room against the actual boundary; the room stays
 * contained if the attempt fails. This is the engine behind the app's future
 * "prove it" screen and its verification tests — it exercises the true
 * enforcement boundary, never a staged one.
 *
 * Probes decide inside the guest and echo CONTAINED / ESCAPED, so the host-side
 * check stays trivial and unambiguous.
 */
import type { RoomBackend, RoomSpec } from "./backend.js";

export interface BreakoutProbe {
  id: string;
  /** Short, human-readable claim being tested (surfaces in the "prove it" UI). */
  title: string;
  /** What the probe attempts. */
  description: string;
  /** The escape attempt, run inside the sealed room. */
  command: string[];
}

export interface BreakoutResult {
  id: string;
  title: string;
  /** true = the boundary held (good); false = the room escaped (bad). */
  contained: boolean;
  /** Short line for the UI / audit log. */
  evidence: string;
}

/** Path inside the room where the single read-only door is mounted for probes. */
export const PROBE_DOOR = "/work";

/**
 * A maximally-sealed room: one read-only door, egress fully blocked, all Linux
 * capabilities dropped. This is the strongest boundary — what the probes attack.
 */
export function sealedRoomSpec(doorHostPath: string, image = "docker.io/library/alpine:3.20"): RoomSpec {
  return {
    image,
    doors: [{ hostPath: doorHostPath, roomPath: PROBE_DOOR, access: "read-only" }],
    egress: { mode: "blocked" },
    dropCapabilities: true,
  };
}

const decided = (stdout: string) => stdout.includes("CONTAINED") && !stdout.includes("ESCAPED");

export const PROBES: BreakoutProbe[] = [
  {
    id: "host-fs-invisible",
    title: "The host disk is invisible",
    description: "Tries to reach the host's home and system folders from inside the room.",
    command: ["sh", "-c", "test -e /Users && echo ESCAPED || echo CONTAINED"],
  },
  {
    id: "readonly-door-immutable",
    title: "A read-only door cannot be written",
    description: "Tries to create a file inside a folder shared in read-only.",
    command: ["sh", "-c", `touch ${PROBE_DOOR}/__breakout__ 2>/dev/null && echo ESCAPED || echo CONTAINED`],
  },
  {
    id: "egress-blocked",
    title: "Network egress is blocked",
    description: "Tries to reach an external IP directly (no DNS needed).",
    command: ["sh", "-c", "wget -T5 -qO- http://1.1.1.1 >/dev/null 2>&1 && echo ESCAPED || echo CONTAINED"],
  },
  {
    id: "dns-blocked",
    title: "Name resolution is blocked",
    description: "Tries to resolve an external hostname.",
    command: ["sh", "-c", "nslookup example.com >/dev/null 2>&1 && echo ESCAPED || echo CONTAINED"],
  },
];

/** Run every probe against the sealed room and report whether the boundary held. */
export async function runBreakout(
  backend: RoomBackend,
  spec: RoomSpec,
  probes: BreakoutProbe[] = PROBES,
): Promise<BreakoutResult[]> {
  const results: BreakoutResult[] = [];
  for (const probe of probes) {
    const out = await backend.run(spec, probe.command);
    const contained = decided(out.stdout);
    results.push({
      id: probe.id,
      title: probe.title,
      contained,
      evidence: contained
        ? "boundary held"
        : `ESCAPED — stdout=${out.stdout.trim().slice(0, 80)} exit=${out.exitCode}`,
    });
  }
  return results;
}
