/**
 * Protection mismatch gate (ui-control-plane §9–10).
 * When Security diagnostics Expected ≠ Observed, new Protected launches are blocked
 * until the operator re-runs diagnostics successfully or explicitly clears the gate.
 * Running sessions are not auto-killed.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.js";
import { writeFileAtomic } from "./config-store.js";

export interface ProtectionMismatch {
  context: string;
  at: string;
  failedIds: string[];
  summary: string;
}

interface Store {
  mismatches: Record<string, ProtectionMismatch>;
}

function storePath(): string {
  return join(stateDir(), "protection-status.json");
}

function readStore(): Store {
  const path = storePath();
  if (!existsSync(path)) return { mismatches: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Store;
    return { mismatches: raw.mismatches && typeof raw.mismatches === "object" ? raw.mismatches : {} };
  } catch {
    return { mismatches: {} };
  }
}

function writeStore(store: Store): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileAtomic(storePath(), `${JSON.stringify(store, null, 2)}\n`);
}

export function getProtectionMismatch(context: string): ProtectionMismatch | undefined {
  return readStore().mismatches[context];
}

export function listProtectionMismatches(): ProtectionMismatch[] {
  return Object.values(readStore().mismatches);
}

export function setProtectionMismatch(context: string, failedIds: string[], summary: string): ProtectionMismatch {
  const store = readStore();
  const entry: ProtectionMismatch = {
    context,
    at: new Date().toISOString(),
    failedIds,
    summary,
  };
  store.mismatches[context] = entry;
  writeStore(store);
  return entry;
}

export function clearProtectionMismatch(context: string): void {
  const store = readStore();
  delete store.mismatches[context];
  writeStore(store);
}

/** True when a new Protected Room launch must be refused for this Project. */
export function blocksProtectedLaunch(context: string): boolean {
  return Boolean(getProtectionMismatch(context));
}
