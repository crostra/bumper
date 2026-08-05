/**
 * Getting Bumper off a Mac, and getting a broken config back.
 *
 * These are the operations a first-time user needs precisely when they are
 * least willing to open a GUI: the tool did not work out, or its config is
 * wrecked. Recovery is part of the supported product contract, and a
 * CLI-only install had neither.
 *
 * Nothing here removes a Project's folder. Bumper's own state is Bumper's to
 * clean up; the user's work is not.
 */
import {
  describeUninstall,
  executeUninstallCleanup,
  isRecoveryMode,
  listConfigBackups,
  readRecoveryReason,
  restoreConfigBackup,
  type ConfigBackup,
  type UninstallPlan,
} from "../config-store.js";
import { readEvents } from "../log.js";
import type { LogEvent } from "../log.js";
import { OperationError } from "./error.js";
import type { FolderSessionRef } from "../folders.js";

export interface UninstallPreview extends UninstallPlan {
  /** Sessions still running. Removing state under a live Sandbox is a mess. */
  liveSessions: FolderSessionRef[];
}

export function previewUninstall(input: {
  includeLocalData: boolean;
  runningSessions?: FolderSessionRef[];
}): UninstallPreview {
  const plan = describeUninstall({ includeLocalData: input.includeLocalData });
  const live = (input.runningSessions ?? []).filter(
    (session) => session.status === "running" || session.status === "starting",
  );
  return { ...plan, liveSessions: live };
}

export interface UninstallResult {
  removed: string[];
  skipped: string[];
  neverDeletes: string[];
}

export function performUninstall(input: {
  includeLocalData: boolean;
  runningSessions?: FolderSessionRef[];
}): UninstallResult {
  const preview = previewUninstall(input);
  if (preview.liveSessions.length > 0) {
    const labels = preview.liveSessions.map((s) => s.agentName || s.id).join(", ");
    throw new OperationError("conflict", `A Session is still running (${labels}).`, [
      "Exit the AI CLI in that terminal, then run this again.",
    ]);
  }
  const result = executeUninstallCleanup({ includeLocalData: input.includeLocalData });
  return { ...result, neverDeletes: preview.neverDeletes };
}

export interface RecoveryState {
  inRecovery: boolean;
  reason?: string;
  backups: ConfigBackup[];
}

export function describeRecovery(): RecoveryState {
  return {
    inRecovery: isRecoveryMode(),
    reason: readRecoveryReason(),
    backups: listConfigBackups(),
  };
}

export function restoreBackup(input: { backupId: string }): { restoredTo: string; backupId: string } {
  const id = input.backupId.trim();
  if (!id) {
    throw new OperationError("invalid", "A backup id is required.", ["bumper backup list"]);
  }
  const available = listConfigBackups();
  if (!available.some((backup) => backup.id === id)) {
    throw new OperationError("not-found", `No backup named "${id}".`, ["bumper backup list"]);
  }
  try {
    return { restoredTo: restoreConfigBackup(id), backupId: id };
  } catch (err) {
    throw new OperationError("invalid", (err as Error).message, ["bumper backup list"]);
  }
}

export interface ExportEventsInput {
  context?: string;
  decision?: string;
  limit?: number;
  since?: Date;
}

/** The audit record as data. `bumper log` prints; this is for keeping. */
export function exportEvents(input: ExportEventsInput = {}): LogEvent[] {
  return readEvents({
    limit: input.limit ?? 10_000,
    context: input.context,
    decision: input.decision as never,
    since: input.since,
  });
}

/** Where a user says what they hit. A URL, opened on request — never telemetry. */
export const FEEDBACK_URL = "https://github.com/crostra/bumper/discussions";
export const BUG_URL = "https://github.com/crostra/bumper/issues/new";

export interface FeedbackTarget {
  url: string;
  kind: "discussion" | "bug";
  /** Facts worth pasting in. Gathered locally; nothing is sent anywhere. */
  context: string[];
}

export function describeFeedback(input: {
  kind: "discussion" | "bug";
  bumperVersion: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  containerDetail?: string;
}): FeedbackTarget {
  return {
    url: input.kind === "bug" ? BUG_URL : FEEDBACK_URL,
    kind: input.kind,
    context: [
      `Bumper ${input.bumperVersion}`,
      `${input.platform}/${input.arch} · Node ${input.nodeVersion}`,
      ...(input.containerDetail ? [`Apple container: ${input.containerDetail}`] : []),
    ],
  };
}
