import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { existsSync } from "node:fs";

/**
 * Config resolution order:
 *   1. $BUMPER_CONFIG (explicit)
 *   2. ./bumper.config.json (project-local)
 *   3. ~/.bumper/config.json (user-global)
 */
export function resolveConfigPath(explicit?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.BUMPER_CONFIG) return resolve(process.env.BUMPER_CONFIG);
  const local = resolve(process.cwd(), "bumper.config.json");
  if (existsSync(local)) return local;
  return join(homedir(), ".bumper", "config.json");
}

/** State (active context) lives in ~/.bumper, or $BUMPER_STATE if set. */
export function stateFilePath(): string {
  if (process.env.BUMPER_STATE) return resolve(process.env.BUMPER_STATE);
  return join(homedir(), ".bumper", "state.json");
}

export function stateDir(): string {
  return dirname(stateFilePath());
}
