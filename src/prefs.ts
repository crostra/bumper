/**
 * Local app preferences (not Project boundary config).
 * Lives beside state.json under ~/.bumper (or $BUMPER_STATE dir).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.js";
import { writeFileAtomic } from "./config-store.js";

export type EventRetention = "off" | "session" | "7d" | "30d";

export interface AppPrefs {
  /** Local event metadata retention. Default 7d. */
  eventRetention: EventRetention;
  /** Semantic UI language when set; otherwise renderer localStorage. */
  language?: "en" | "ja";
}

const DEFAULTS: AppPrefs = { eventRetention: "7d" };

function prefsPath(): string {
  return join(stateDir(), "prefs.json");
}

export function readPrefs(): AppPrefs {
  const path = prefsPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppPrefs>;
    const retention = raw.eventRetention;
    const eventRetention: EventRetention =
      retention === "off" || retention === "session" || retention === "7d" || retention === "30d"
        ? retention
        : DEFAULTS.eventRetention;
    const language = raw.language === "ja" || raw.language === "en" ? raw.language : undefined;
    return { eventRetention, language };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePrefs(patch: Partial<AppPrefs>): AppPrefs {
  const next = { ...readPrefs(), ...patch };
  mkdirSync(stateDir(), { recursive: true });
  writeFileAtomic(prefsPath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Session start marker for "session" retention — events older than this boot are pruned. */
export function sessionStartedAtPath(): string {
  return join(stateDir(), "session-started-at");
}

export function markAppSessionStart(): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(sessionStartedAtPath(), new Date().toISOString(), { mode: 0o600 });
}

export function readSessionStartedAt(): Date | undefined {
  const path = sessionStartedAtPath();
  if (!existsSync(path)) return undefined;
  try {
    const ts = readFileSync(path, "utf8").trim();
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? undefined : d;
  } catch {
    return undefined;
  }
}
