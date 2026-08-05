import { appendFileSync, readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { stateFilePath } from "./paths.js";
import { readPrefs, readSessionStartedAt, type EventRetention } from "./prefs.js";

export type Surface = "mcp" | "native" | "network" | "session" | "sandbox";
export type Decision = "allowed" | "blocked" | "failed";
/** Where the boundary decision originated (ui-control-plane §5.3 / §11). */
export type EventSource = "room" | "external-mcp" | "app";
/** Coarse type filter (Files / Network / Git / MCP / System). */
export type EventType = "files" | "network" | "git" | "mcp" | "system";

/** Project dialog tab for Blocked → settings deep link (Phase 4). */
export type FixTab = "access" | "room" | "commands" | "connections" | "ai-tools";

export interface LogEvent {
  ts: string; // ISO timestamp
  context: string;
  surface: Surface;
  decision: Decision;
  access?: "none" | "read" | "write";
  /**
   * The exact rung of the Git capability ladder this event is about.
   * `access` stays as the coarse read/write summary older readers understand.
   */
  capability?: "none" | "read" | "write" | "pr" | "workflow";
  /** Safe correlation id for one live Git/Room Session. Never a credential. */
  sessionId?: string;
  /** Safe structured Git metadata for export/diagnostics. */
  repository?: string;
  expiresAt?: string;
  target: string; // tool name, command, or destination
  reason: string;
  /** Phase 4: Project settings tab for GUI Blocked deep link. */
  fixTab?: FixTab;
  /** Phase 4: button / next-action label in Blocked / Activity. */
  fixLabel?: string;
  /** Phase 6: origin of the decision. Inferred when omitted. */
  source?: EventSource;
  /** Phase 6: coarse type. Inferred from surface/target when omitted. */
  type?: EventType;
}

export function eventLogPath(): string {
  return join(dirname(stateFilePath()), "log", "events.jsonl");
}

export function inferEventSource(e: Pick<LogEvent, "surface" | "source">): EventSource {
  if (e.source) return e.source;
  if (e.surface === "mcp") return "external-mcp";
  if (e.surface === "session") return "app";
  return "room";
}

export function inferEventType(e: Pick<LogEvent, "surface" | "target" | "type" | "fixTab">): EventType {
  if (e.type) return e.type;
  if (e.fixTab === "connections" || e.surface === "mcp") return "mcp";
  if (e.surface === "sandbox") return "files";
  if (e.surface === "network") {
    const t = e.target.toLowerCase();
    if (t.includes("git") || t.includes("github") || t.includes("gitlab") || t.includes("repo")) return "git";
    return "network";
  }
  if (e.surface === "native") {
    const t = e.target.toLowerCase();
    if (/\bgit\b/.test(t)) return "git";
    return "system";
  }
  return "system";
}

/** Normalize a stored/legacy event for filters and UI. */
export function normalizeEvent(e: LogEvent): LogEvent & { source: EventSource; type: EventType } {
  return {
    ...e,
    source: inferEventSource(e),
    type: inferEventType(e),
  };
}

/** Append one enforcement event. Best-effort: logging must never break enforcement. */
export function logEvent(e: Omit<LogEvent, "ts">): void {
  try {
    if (readPrefs().eventRetention === "off") return;
    const path = eventLogPath();
    mkdirSync(dirname(path), { recursive: true });
    const row: LogEvent = {
      ts: new Date().toISOString(),
      ...e,
      source: inferEventSource(e),
      type: inferEventType(e),
    };
    appendFileSync(path, JSON.stringify(row) + "\n");
  } catch {
    /* ignore */
  }
}

export interface ReadOptions {
  limit?: number;
  context?: string;
  decision?: Decision;
  since?: Date;
  until?: Date;
  surface?: Surface;
  source?: EventSource;
  type?: EventType;
}

function retentionCutoff(retention: EventRetention = readPrefs().eventRetention): Date | null {
  if (retention === "off") return null;
  if (retention === "session") {
    return readSessionStartedAt() ?? new Date(0);
  }
  const days = retention === "30d" ? 30 : 7;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/** Drop events outside the active retention window. Metadata only — never payloads. */
export function pruneEvents(retention: EventRetention = readPrefs().eventRetention): { kept: number; removed: number } {
  const path = eventLogPath();
  if (!existsSync(path)) return { kept: 0, removed: 0 };
  if (retention === "off") {
    // Off = do not retain across reads; clear file.
    try {
      writeFileSync(path, "", { mode: 0o600 });
    } catch {
      /* ignore */
    }
    return { kept: 0, removed: -1 };
  }
  const cutoff = retentionCutoff(retention);
  if (!cutoff) return { kept: 0, removed: 0 };
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return { kept: 0, removed: 0 };
  }
  const keptLines: string[] = [];
  let removed = 0;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as LogEvent;
      if (new Date(ev.ts) < cutoff) {
        removed++;
        continue;
      }
      keptLines.push(line);
    } catch {
      removed++;
    }
  }
  if (removed === 0) return { kept: keptLines.length, removed: 0 };
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, keptLines.length ? `${keptLines.join("\n")}\n` : "", { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* ignore */
  }
  return { kept: keptLines.length, removed };
}

/** Read recent events, newest first. Applies retention cutoff automatically (except off→empty). */
export function readEvents(opts: ReadOptions = {}): LogEvent[] {
  const retention = readPrefs().eventRetention;
  if (retention === "off") return [];
  const path = eventLogPath();
  if (!existsSync(path)) return [];
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const autoSince = retentionCutoff(retention) ?? undefined;
  const since = opts.since && autoSince
    ? (opts.since > autoSince ? opts.since : autoSince)
    : (opts.since ?? autoSince);
  const out: LogEvent[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev: LogEvent;
    try {
      ev = JSON.parse(lines[i]) as LogEvent;
    } catch {
      continue;
    }
    const norm = normalizeEvent(ev);
    if (opts.context && norm.context !== opts.context) continue;
    if (opts.decision && norm.decision !== opts.decision) continue;
    if (opts.surface && norm.surface !== opts.surface) continue;
    if (opts.source && norm.source !== opts.source) continue;
    if (opts.type && norm.type !== opts.type) continue;
    if (since && new Date(norm.ts) < since) {
      // Append-only jsonl: once we pass the cutoff walking newest→oldest, stop.
      break;
    }
    if (opts.until && new Date(norm.ts) > opts.until) continue;
    out.push(norm);
    if (opts.limit && out.length >= opts.limit) break;
  }
  return out;
}

export interface GroupedEvent {
  key: string;
  context: string;
  type: EventType;
  source: EventSource;
  decision: Decision;
  /** Representative destination / operation label. */
  target: string;
  count: number;
  latestTs: string;
  reason: string;
  /** Newest-first raw members for expansion. */
  events: LogEvent[];
}

/** Group by Project + destination + operation + decision (ui-control-plane §5.3). */
export function groupEvents(events: LogEvent[]): GroupedEvent[] {
  const map = new Map<string, GroupedEvent>();
  for (const raw of events) {
    const e = normalizeEvent(raw);
    const key = `${e.context}\0${e.type}\0${e.target}\0${e.decision}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        context: e.context,
        type: e.type,
        source: e.source,
        decision: e.decision,
        target: e.target,
        count: 1,
        latestTs: e.ts,
        reason: e.reason,
        events: [e],
      });
    } else {
      existing.count++;
      existing.events.push(e);
      if (e.ts > existing.latestTs) {
        existing.latestTs = e.ts;
        existing.reason = e.reason;
        existing.source = e.source;
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.latestTs < b.latestTs ? 1 : -1));
}

/** Counts for "today" (local midnight) in a context — for the Now screen. */
export function todayCounts(context: string): { blocked: number; allowed: number } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const evs = readEvents({ context, since: start });
  let blocked = 0, allowed = 0;
  for (const e of evs) {
    if (e.decision === "blocked" || e.decision === "failed") blocked++;
    else allowed++;
  }
  return { blocked, allowed };
}

/**
 * Newest event timestamp per Project (retention window).
 * Walks the jsonl newest→oldest once; first hit for each name is its last activity.
 * Used by Projects list sort (Event time, then config order).
 */
export function latestEventAtByContext(contextNames: string[]): Record<string, string> {
  const want = new Set(contextNames.filter(Boolean));
  const found: Record<string, string> = {};
  if (!want.size) return found;

  const retention = readPrefs().eventRetention;
  if (retention === "off") return found;
  const path = eventLogPath();
  if (!existsSync(path)) return found;

  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return found;
  }

  const since = retentionCutoff(retention) ?? undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev: LogEvent;
    try {
      ev = JSON.parse(lines[i]!) as LogEvent;
    } catch {
      continue;
    }
    const ts = String(ev.ts ?? "");
    const context = String(ev.context ?? "");
    if (!ts || !context || !want.has(context) || found[context]) continue;
    if (since && new Date(ts) < since) break;
    found[context] = ts;
    if (Object.keys(found).length >= want.size) break;
  }
  return found;
}
