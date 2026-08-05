import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type { Context } from "./types.js";
import { resolveConfigPath } from "./paths.js";

function expand(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

/** System temp dirs a process needs to function. */
function tempSubpaths(): string[] {
  return ["/private/tmp", "/tmp", "/private/var/folders", "/dev"];
}

/**
 * Home-level names the AI clients legitimately use for their own state.
 * Bumper's own directory is deliberately absent because it may contain scoped
 * credentials. Everything else in $HOME stays inaccessible. Matched as prefixes,
 * so both `~/.claude.json` (file) and `~/.claude/…` (dir) are covered.
 */
const HOME_STATE_PREFIXES = [
  ".claude", // covers ~/.claude.json and ~/.claude/
  ".codex",
  ".cursor",
  ".gemini",
  ".grok",
  ".cache",
  ".npm",
  "Library/Caches",
  "Library/Application Support/claude",
  "Library/Application Support/Claude",
  "Library/Application Support/ChatGPT",
  "Library/Application Support/Cursor",
  "Library/Application Support/Antigravity",
  "Library/Application Support/Code",
  // Vendor CLIs such as Cursor can store login state in the user's login
  // keychain. This intentionally supports normal auth; it is not hostile-user
  // isolation. See docs/SECURITY_MODEL.md.
  "Library/Keychains",
  "Library/Preferences/com.apple.security",
  ".zsh_history",
  ".zsh_sessions",
  ".zcompdump",
  ".bash_history",
  ".bash_sessions",
  ".lesshst",
  ".node_repl_history",
  ".viminfo",
  ".DS_Store",
];

export interface SandboxOptions {
  /** The selected workspace. It is always both readable and writable. */
  workspace?: string;
  /** Runtime/install locations required to start a particular agent. */
  runtimeReadPaths?: string[];
  /** Narrow per-agent state directories required for caches and auth. */
  runtimeWritePaths?: string[];
  /** Session-derived exceptions such as paths currently matched by .gitignore. */
  deniedReadPaths?: string[];
  deniedWritePaths?: string[];
}

/** Resolve current ignored files/directories without pretending .gitignore itself is a security boundary. */
export function gitIgnoredPaths(workspace: string): string[] {
  const root = resolve(workspace);
  const commands = [
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    ["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"],
  ];
  const found = new Set<string>();
  for (const args of commands) {
    try {
      const output = execFileSync("/usr/bin/git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000 });
      for (const entry of output.split("\0").filter(Boolean)) {
        const path = resolve(root, entry);
        if (!isAbsolute(entry) && (path === root || path.startsWith(root + sep))) found.add(path);
      }
    } catch { /* not a Git workspace, or Git unavailable */ }
  }
  return [...found];
}

/** Escape a string for use inside an SBPL regex literal. */
function reEsc(s: string): string {
  return s.replace(/[.\\+*?()[\]{}^$|/]/g, "\\$&");
}

/**
 * Build a macOS Seatbelt profile. Reads under the user's home and all writes
 * are denied first, then the selected workspace, explicit context paths, agent
 * runtime/state, and temporary directories are re-allowed. The kernel applies
 * the same boundary to the agent and every subprocess it creates.
 */
export function buildProfile(context: Context, options: SandboxOptions = {}): string {
  const home = homedir();
  const writeSubpaths = [
    ...tempSubpaths(),
    ...(context.writePaths ?? []).map(expand),
    ...(options.workspace && context.mode === "read-write" ? [expand(options.workspace)] : []),
    ...(options.runtimeWritePaths ?? []).map(expand),
  ];
  const writeRules = [...new Set(writeSubpaths)]
    .map((p) => `(allow file-write* (subpath ${JSON.stringify(p)}))`)
    .join("\n");
  const stateRules = HOME_STATE_PREFIXES
    .map((name) => `(allow file-read* file-write* (regex #"^${reEsc(home + "/" + name)}"))`)
    .join("\n");
  const readSubpaths = [
    ...(context.readPaths ?? []).map(expand),
    ...(context.writePaths ?? []).map(expand),
    ...(options.workspace ? [expand(options.workspace)] : []),
    ...(options.runtimeReadPaths ?? []).map(expand),
    ...(options.runtimeWritePaths ?? []).map(expand),
  ];
  const readRules = [...new Set(readSubpaths)]
    .map((p) => `(allow file-read* (subpath ${JSON.stringify(p)}))`)
    .join("\n");
  const denyWriteRules = [...new Set([...(context.denyWritePaths ?? []), ...(options.deniedWritePaths ?? [])].map(expand))]
    .map((p) => `(deny file-write* (subpath ${JSON.stringify(p)}))`)
    .join("\n");
  const denyReadRules = [...new Set([...(context.denyReadPaths ?? []), ...(options.deniedReadPaths ?? [])].map(expand))]
    .map((p) => `(deny file-read* (subpath ${JSON.stringify(p)}))`)
    .join("\n");
  return [
    "(version 1)",
    "(allow default)",
    `(deny file-read* (subpath ${JSON.stringify(home)}))`,
    "(deny file-write*)",
    `(allow file-read-metadata (subpath ${JSON.stringify(home)}))`,
    readRules,
    `(allow file-read* (literal ${JSON.stringify(resolveConfigPath())}))`,
    writeRules,
    stateRules,
    denyWriteRules,
    denyReadRules,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper"))',
  ].join("\n");
}

export interface RunResult { code: number; }

/** Run a command inside the sandbox for the given context. Inherits stdio so the client is interactive. */
export function runSandboxed(
  context: Context,
  command: string[],
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  const profile = buildProfile(context);
  return new Promise((resolvePromise) => {
    const child = spawn("/usr/bin/sandbox-exec", ["-p", profile, ...command], {
      stdio: "inherit",
      env,
    });
    child.on("exit", (code) => resolvePromise({ code: code ?? 0 }));
    child.on("error", (err) => {
      console.error(`bumper run: failed to start sandbox: ${err.message}`);
      resolvePromise({ code: 1 });
    });
  });
}
