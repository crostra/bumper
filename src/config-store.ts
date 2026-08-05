/**
 * Atomic bumper.config writes with rotating backups and Recovery mode.
 *
 * Contract (ui-control-plane §11–12):
 * - write via temp file + rename
 * - keep the last 5 backups under <stateDir>/config-backups/
 * - corruption → Recovery mode (marker + backup listing); never invent Projects
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveConfigPath, stateDir } from "./paths.js";

export const MAX_CONFIG_BACKUPS = 5;
export const RECOVERY_MARKER = "recovery-mode";

export interface ConfigBackup {
  id: string;
  path: string;
  mtimeMs: number;
  size: number;
}

function backupsDir(): string {
  return join(stateDir(), "config-backups");
}

function recoveryMarkerPath(): string {
  return join(stateDir(), RECOVERY_MARKER);
}

/** Atomic write of UTF-8 text (mode 0600). */
export function writeFileAtomic(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

function rotateBackups(configPath: string): void {
  if (!existsSync(configPath)) return;
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(dir, `config.${stamp}.json`);
  try {
    copyFileSync(configPath, dest);
  } catch {
    return;
  }
  const listed = listConfigBackups();
  for (const extra of listed.slice(MAX_CONFIG_BACKUPS)) {
    try {
      unlinkSync(extra.path);
    } catch {
      /* ignore */
    }
  }
}

/** List backups newest first. */
export function listConfigBackups(): ConfigBackup[] {
  const dir = backupsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("config.") && name.endsWith(".json"))
    .map((name) => {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        return { id: name, path, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        return { id: name, path, mtimeMs: 0, size: 0 };
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Write JSON config atomically after rotating a backup of the previous file. */
export function writeConfigJson(path: string, value: unknown): void {
  rotateBackups(path);
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
  clearRecoveryMode();
}

/**
 * Read → mutate → atomic write for bumper.config.json.
 * Mutator receives a plain object parsed from disk (not Zod-validated).
 */
export function mutateRawConfig(mutator: (raw: Record<string, unknown>) => void, explicit?: string): string {
  const path = resolveConfigPath(explicit);
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}.`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    enterRecoveryMode(`Config is not valid JSON: ${(err as Error).message}`);
    throw err;
  }
  mutator(raw);
  writeConfigJson(path, raw);
  return path;
}

export function isRecoveryMode(): boolean {
  return existsSync(recoveryMarkerPath());
}

export function enterRecoveryMode(reason: string): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileAtomic(
    recoveryMarkerPath(),
    `${JSON.stringify({ reason, at: new Date().toISOString() }, null, 2)}\n`,
  );
}

export function clearRecoveryMode(): void {
  const marker = recoveryMarkerPath();
  if (existsSync(marker)) {
    try {
      unlinkSync(marker);
    } catch {
      /* ignore */
    }
  }
}

export function readRecoveryReason(): string | undefined {
  const marker = recoveryMarkerPath();
  if (!existsSync(marker)) return undefined;
  try {
    const data = JSON.parse(readFileSync(marker, "utf8")) as { reason?: string };
    return data.reason;
  } catch {
    return "Config recovery required.";
  }
}

/** Restore a named backup over the live config (atomic). */
export function restoreConfigBackup(backupId: string, explicit?: string): string {
  const path = resolveConfigPath(explicit);
  const safe = basename(backupId);
  if (safe !== backupId || !safe.startsWith("config.") || !safe.endsWith(".json")) {
    throw new Error("Invalid backup id.");
  }
  const backupPath = join(backupsDir(), safe);
  if (!existsSync(backupPath)) throw new Error("Backup not found.");
  let text: string;
  try {
    text = readFileSync(backupPath, "utf8");
    JSON.parse(text);
  } catch (err) {
    throw new Error(`Backup is not valid JSON: ${(err as Error).message}`);
  }
  rotateBackups(path);
  writeFileAtomic(path, text.endsWith("\n") ? text : `${text}\n`, 0o600);
  clearRecoveryMode();
  return path;
}

export interface UninstallPlan {
  /** Always: the Bumper.app bundle path when known (Electron); optional for HTTP mode. */
  appBundlePath?: string;
  /** Local Bumper state under ~/.bumper (or BUMPER_STATE dir) — never a Project workspace. */
  localDataPaths: string[];
  /** Config file path (may live inside localDataPaths). */
  configPath: string;
  /** Explicit note: host workspaces are never deleted. */
  neverDeletes: string[];
}

/** Describe uninstall targets. Does not delete anything. */
export function describeUninstall(opts: { includeLocalData: boolean; appBundlePath?: string } = { includeLocalData: false }): UninstallPlan {
  const configPath = resolveConfigPath();
  const localRoot = stateDir();
  const localDataPaths = opts.includeLocalData
    ? [localRoot, configPath].filter((p, i, arr) => arr.indexOf(p) === i)
    : [];
  return {
    appBundlePath: opts.appBundlePath,
    localDataPaths,
    configPath,
    neverDeletes: [
      "Project workspace folders on disk",
      "Reusable Library contents outside Bumper state",
      "Host git remotes / Keychain items other apps own",
    ],
  };
}

/**
 * Execute uninstall assistant choices.
 * - appOnly: caller removes the .app; we do nothing destructive here unless includeLocalData.
 * - includeLocalData: remove Bumper state dir + config if it lives there. Never touch workspaces.
 */
export function executeUninstallCleanup(opts: { includeLocalData: boolean }): { removed: string[]; skipped: string[] } {
  const removed: string[] = [];
  const skipped: string[] = [];
  if (!opts.includeLocalData) {
    return { removed, skipped: ["App bundle removal is performed by the OS / user after quit."] };
  }
  const root = stateDir();
  const configPath = resolveConfigPath();
  // Never delete a project-local bumper.config.json sitting in a workspace cwd.
  const safeConfig = configPath.startsWith(root + "/") || configPath === join(root, "config.json");
  if (existsSync(root)) {
    rmSync(root, { recursive: true, force: true });
    removed.push(root);
  } else {
    skipped.push(root);
  }
  if (safeConfig && existsSync(configPath) && !configPath.startsWith(root)) {
    try {
      unlinkSync(configPath);
      removed.push(configPath);
    } catch {
      skipped.push(configPath);
    }
  } else if (!safeConfig) {
    skipped.push(`${configPath} (not under Bumper state — left intact)`);
  }
  return { removed, skipped };
}
