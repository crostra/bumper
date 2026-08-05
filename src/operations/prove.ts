/**
 * Prove it — run the real Sandbox and try to get out of it.
 *
 * The README leads with "provable in one click", and until now that click only
 * existed in the GUI. A boundary product whose evidence is unreachable from the
 * terminal is asking to be taken on faith, which is the opposite of the claim.
 *
 * Two probes, both against a live microVM:
 *   sealed  — a disposable room that touches none of the user's folders
 *   project — this Project's actual spec, so the evidence is about their cage
 *
 * When Apple container is unavailable the result is an empty set marked
 * unavailable. A host-side stand-in scored as a boundary check would be a lie,
 * so there is deliberately no fallback.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../types.js";
import { effectiveContext } from "../effective.js";
import { AppleContainerBackend } from "../room/apple-container.js";
import { roomSpecForContext } from "../room/spec.js";
import { runBreakout, sealedRoomSpec, type BreakoutResult } from "../room/breakout.js";
import { runAiProof, type AiProofResult } from "../room/aiproof.js";
import {
  blocksProtectedLaunch,
  clearProtectionMismatch,
  getProtectionMismatch,
  setProtectionMismatch,
} from "../protection-status.js";
import { logEvent } from "../log.js";
import { OperationError } from "./error.js";

export interface SealedProofResult {
  available: boolean;
  detail: string;
  results: BreakoutResult[];
}

/**
 * The demo that touches nothing of the user's. Safe to run before a Project
 * exists, which is exactly when someone is deciding whether to trust this.
 */
export async function proveSealedRoom(): Promise<SealedProofResult> {
  const backend = new AppleContainerBackend();
  const availability = await backend.check();
  if (!availability.usable) {
    return { available: false, detail: availability.detail, results: [] };
  }
  const dir = mkdtempSync(join(tmpdir(), "bumper-room-probe-"));
  writeFileSync(join(dir, "client-secret.txt"), "SIMULATED CLIENT SECRET\n", { mode: 0o600 });
  try {
    return {
      available: true,
      detail: availability.detail,
      results: await runBreakout(backend, sealedRoomSpec(dir)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface ProjectProofResult {
  available: boolean;
  detail: string;
  projectName: string;
  workspace: string;
  image?: string;
  results: AiProofResult[];
  passed: number;
  total: number;
  allMatch: boolean;
  launchBlocked: boolean;
  mismatch: ReturnType<typeof getProtectionMismatch> | null;
}

/**
 * Run the boundary checks against this Project's real spec.
 *
 * A mismatch is recorded in protection-status, which is what blocks a
 * protected launch — so the CLI and the GUI cannot end up with different
 * opinions about whether this Project is still trustworthy.
 */
export async function proveProject(input: {
  config: Config;
  projectName: string;
  /** Defaults to the Project's bound workspace. */
  workspace?: string;
}): Promise<ProjectProofResult> {
  const projectName = input.projectName.trim();
  if (!input.config.contexts[projectName]) {
    throw new OperationError("not-found", `Unknown project "${projectName}".`, ["bumper project list"]);
  }
  const context = effectiveContext(input.config, projectName);
  if (!context.room.enabled) {
    throw new OperationError("conflict", "This Project has the Sandbox backend disabled.", [
      "Enable it in the Bumper app → Project → Overview.",
    ]);
  }

  const bound = (input.workspace ?? input.config.contexts[projectName]?.workspace ?? "").trim();
  if (!bound || !existsSync(bound)) {
    throw new OperationError("invalid", "This Project has no existing project folder to prove against.", [
      `bumper access set -p "${projectName}"   # bind a folder first`,
    ]);
  }
  const workspace = realpathSync(bound);

  const backend = new AppleContainerBackend();
  const availability = await backend.check();
  if (!availability.usable) {
    // No room, no evidence. An empty result set is honest.
    return {
      available: false, detail: availability.detail, projectName, workspace,
      results: [], passed: 0, total: 0, allMatch: false,
      launchBlocked: blocksProtectedLaunch(projectName),
      mismatch: getProtectionMismatch(projectName) ?? null,
    };
  }

  const spec = roomSpecForContext(context, workspace);
  const results = await runAiProof(backend, spec, context);
  const failed = results.filter((result) => !result.pass);
  const allMatch = failed.length === 0;

  if (allMatch) {
    clearProtectionMismatch(projectName);
  } else {
    setProtectionMismatch(
      projectName,
      failed.map((result) => result.id),
      `${failed.length} diagnostic check(s) did not match Expected vs Observed`,
    );
  }
  logEvent({
    context: projectName, surface: "session", source: "app", type: "system",
    decision: allMatch ? "allowed" : "failed",
    target: "Security diagnostics",
    reason: `${results.length - failed.length}/${results.length} checks matched the promised boundary`,
  });

  return {
    available: true, detail: availability.detail, projectName, workspace, image: spec.image,
    results, passed: results.length - failed.length, total: results.length, allMatch,
    launchBlocked: blocksProtectedLaunch(projectName),
    mismatch: getProtectionMismatch(projectName) ?? null,
  };
}
