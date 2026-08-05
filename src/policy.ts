import { Access, Context, ToolDecision } from "./types.js";

/**
 * Tool-name heuristics. We deliberately do NOT trust MCP `readOnlyHint`
 * annotations as authoritative (the spec says clients must treat them as
 * untrusted). Instead we classify by name, and — this is the safety property —
 * anything we cannot confidently classify as read is treated as WRITE, so a
 * read-only context never leaks an unrecognized (possibly mutating) tool.
 */
const WRITE_PATTERNS = [
  "create", "update", "delete", "remove", "write", "put", "post", "set",
  "patch", "insert", "drop", "truncate", "append", "edit", "modify", "rename",
  "move", "copy", "upload", "push", "merge", "execute", "exec", "run", "send",
  "publish", "deploy", "revoke", "grant", "add", "clear", "reset", "kill",
  "stop", "start", "restart", "install", "uninstall", "close", "open", "cancel",
  "approve", "reject", "assign", "comment", "invite", "transfer", "pay",
];

const READ_PATTERNS = [
  "get", "list", "read", "search", "find", "fetch", "query", "describe",
  "show", "view", "inspect", "count", "lookup", "resolve", "status", "ping",
  "exists", "browse", "download", "tail", "head", "peek", "summary", "diff",
  "history", "log",
];

function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

interface Classification {
  access: Access;
  /** true when a name pattern (not a fallback) decided it. */
  confident: boolean;
}

function classifyAccess(
  toolName: string,
  readOnlyHint: boolean | undefined,
): Classification {
  const parts = tokens(toolName);
  // Leading verb is the strongest signal.
  for (const t of parts) {
    if (WRITE_PATTERNS.includes(t)) return { access: "write", confident: true };
    if (READ_PATTERNS.includes(t)) return { access: "read", confident: true };
  }
  // No verb matched. A read-only hint is a weak tiebreaker for the unknown case
  // only — never enough to override a write-verb above.
  if (readOnlyHint === true) return { access: "read", confident: false };
  // Unknown → treat as write so read-only contexts stay honest.
  return { access: "write", confident: false };
}

/** Namespace exposed to the client so tools from different backends never collide. */
export function exposedName(backend: string, toolName: string): string {
  return `${backend}__${toolName}`;
}

export function parseExposedName(
  exposed: string,
): { backend: string; toolName: string } | undefined {
  const idx = exposed.indexOf("__");
  if (idx <= 0) return undefined;
  return { backend: exposed.slice(0, idx), toolName: exposed.slice(idx + 2) };
}

/**
 * Decide whether a backend tool is exposed/allowed in the given context.
 * Assumes the backend is already part of the context (deny-by-default on
 * backends happens before this).
 */
export function decideTool(
  context: Context,
  backend: string,
  toolName: string,
  readOnlyHint: boolean | undefined,
): ToolDecision {
  const policy = context.policies[backend];
  const mode = policy?.mode ?? context.mode;
  const exposed = exposedName(backend, toolName);

  const base = (access: Access, allowed: boolean, reason: string): ToolDecision => ({
    backend,
    toolName,
    exposedName: exposed,
    access,
    allowed,
    reason,
  });

  if (policy?.deny?.includes(toolName)) {
    return base("write", false, `blocked by deny list in context "${contextLabel(context, backend)}"`);
  }

  const { access, confident } = classifyAccess(toolName, readOnlyHint);

  if (policy?.allow?.includes(toolName)) {
    return base(access, true, `explicitly allowed (allow list)`);
  }

  if (mode === "read-write") {
    return base(access, true, `read-write context`);
  }

  // read-only mode
  if (access === "read") {
    return base("read", true, confident ? `read operation` : `assumed read (readOnlyHint)`);
  }
  const why = confident
    ? `write operation blocked in read-only context`
    : `unrecognized tool treated as write and blocked (add to allow list if safe)`;
  return base("write", false, why);
}

function contextLabel(_context: Context, backend: string): string {
  return backend;
}
