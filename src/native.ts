import { Context } from "./types.js";

/**
 * Enforcement for a CLIENT'S NATIVE tools (Claude Code / Codex built-ins like
 * Write, Edit, Bash) — the actions that do NOT go through MCP and therefore
 * bypass the proxy. bumper decides here; a thin client hook delegates to it.
 *
 * Design: this only ever BLOCKS. In a read-only context, write/mutating actions
 * are denied; everything else defers to the client's own permission flow. We
 * never loosen the client's security, only tighten it per work-context.
 */

export type NativeAccess = "read" | "write";
export type NativeDecision = { decision: "deny" | "defer"; access: NativeAccess; reason: string };
export type CommandCategory = "gitRead" | "gitLocalWrite" | "gitRemoteRead" | "gitRemoteWrite" | "shellRead" | "shellWrite" | "unknown";

// Client tools that always mutate.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Create"]);
// Client tools that only read / are harmless.
const READ_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite",
]);

// Only commands that cannot write / cannot execute arbitrary programs. Ambiguous
// "power" commands (find -exec, env <cmd>, awk system(), sort -o, xargs …) are
// deliberately NOT here — they fall through to unknown → write → blocked in
// read-only, and the user can allow-list a specific safe invocation if needed.
const BASH_READ = new Set([
  "ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "rg",
  "pwd", "echo", "printf", "which", "type", "whoami", "wc", "stat", "file", "date",
  "ps", "df", "du", "tree", "hostname", "uname", "id", "history",
  "jq", "uniq", "diff", "true", "basename", "dirname", "realpath", "readlink",
]);
const BASH_WRITE = new Set([
  "rm", "mv", "cp", "touch", "mkdir", "rmdir", "ln", "tee", "dd", "truncate", "chmod",
  "chown", "kill", "killall", "pkill", "shutdown", "reboot", "npm", "npx", "pnpm",
  "yarn", "pip", "pip3", "brew", "apt", "apt-get", "yum", "dnf", "docker", "make",
  "cargo", "go", "gcc", "clang", "curl", "wget", "ssh", "scp", "rsync", "python",
  "python3", "node", "bash", "sh", "zsh", "eval", "sed", "tar", "unzip", "zip", "git",
]);

const GIT_WRITE = new Set([
  "push", "commit", "merge", "reset", "rebase", "pull", "clone", "fetch", "checkout",
  "add", "rm", "mv", "stash", "cherry-pick", "revert", "apply", "am", "init", "gc",
  "prune", "tag", "config",
]);
const GIT_READ = new Set([
  "status", "log", "diff", "show", "branch", "remote", "blame", "rev-parse",
  "describe", "ls-files", "ls-remote", "shortlog", "reflog",
]);

function basename(cmd: string): string {
  return cmd.split("/").pop() ?? cmd;
}

function classifyBashSegment(seg: string): NativeAccess {
  const parts = seg.trim().split(/\s+/);
  const first = basename((parts[0] ?? "").toLowerCase());
  if (!first) return "read";
  if (first === "git") {
    const sub = (parts[1] ?? "").toLowerCase();
    if (GIT_WRITE.has(sub)) return "write";
    if (GIT_READ.has(sub)) return "read";
    return "write";
  }
  if (BASH_READ.has(first)) return "read";
  if (BASH_WRITE.has(first)) return "write";
  return "write"; // unknown command → safe default
}

export function classifyCommand(command: string): CommandCategory {
  const segments = command.split(/&&|\|\||;|\|/).map((part) => part.trim()).filter(Boolean);
  if (segments.length !== 1 || /(^|[^0-9&])>>?(?![&])/.test(command) || /\|\s*tee\b/.test(command)) return "shellWrite";
  const parts = segments[0].split(/\s+/);
  const first = basename((parts[0] ?? "").toLowerCase());
  if (!first) return "shellRead";
  if (first === "git") {
    const sub = (parts[1] ?? "").toLowerCase();
    if (["status", "log", "diff", "show", "branch", "remote", "blame", "rev-parse", "describe", "ls-files", "ls-remote", "shortlog", "reflog"].includes(sub)) return "gitRead";
    if (["fetch", "pull", "clone"].includes(sub)) return "gitRemoteRead";
    if (["push"].includes(sub)) return "gitRemoteWrite";
    if (GIT_WRITE.has(sub)) return "gitLocalWrite";
    return "unknown";
  }
  if (BASH_READ.has(first)) return "shellRead";
  if (BASH_WRITE.has(first)) return "shellWrite";
  return "unknown";
}

export function classifyBash(command: string): NativeAccess {
  // Any output redirection to a file is a write.
  if (/(^|[^0-9&])>>?(?![&])/.test(command) || /\|\s*tee\b/.test(command)) return "write";
  // A chain is read-only only if every segment is read-only.
  const segments = command.split(/&&|\|\||;|\|/);
  for (const seg of segments) {
    if (seg.trim() && classifyBashSegment(seg) === "write") return "write";
  }
  return "read";
}

export function classifyNative(toolName: string, toolInput: unknown): NativeAccess {
  if (WRITE_TOOLS.has(toolName)) return "write";
  if (READ_TOOLS.has(toolName)) return "read";
  if (toolName === "Bash") {
    const cmd = (toolInput as { command?: string } | undefined)?.command ?? "";
    return classifyBash(cmd);
  }
  return "write"; // unknown tool → safe default
}

/** Does an allow/deny entry match this native call? Entries: "Write", "Bash", or "Bash:git push" (prefix). */
function matches(entry: string, toolName: string, toolInput: unknown): boolean {
  const colon = entry.indexOf(":");
  if (colon === -1) return entry === toolName;
  const tool = entry.slice(0, colon);
  const prefix = entry.slice(colon + 1).trim();
  if (tool !== toolName) return false;
  const cmd = (toolInput as { command?: string } | undefined)?.command ?? "";
  return cmd.trim().startsWith(prefix);
}

export function decideNative(
  context: Context,
  toolName: string,
  toolInput: unknown,
): NativeDecision {
  const native = context.native ?? { allow: [], deny: [] };
  const access = classifyNative(toolName, toolInput);

  if (native.deny.some((e) => matches(e, toolName, toolInput))) {
    return { decision: "deny", access, reason: `blocked by native deny list in context "${context.description ?? ""}"`.trim() };
  }
  if (native.allow.some((e) => matches(e, toolName, toolInput))) {
    return { decision: "defer", access, reason: "allowed by native allow list" };
  }
  const category: CommandCategory = toolName === "Bash"
    ? classifyCommand((toolInput as { command?: string } | undefined)?.command ?? "")
    : access === "read" ? "shellRead" : WRITE_TOOLS.has(toolName) ? "shellWrite" : "unknown";
  if (context.commands?.[category] === "block") {
    return { decision: "deny", access, reason: `${category} is blocked by the effective command policy` };
  }
  if (context.mode === "read-write") {
    return { decision: "defer", access, reason: "read-write context (client decides)" };
  }
  // read-only
  if (access === "read") {
    return { decision: "defer", access, reason: "read operation (client decides)" };
  }
  return {
    decision: "deny",
    access,
    reason: `write/mutating action blocked in read-only context`,
  };
}
