/**
 * Host-side read-only view of a Project workspace git repo.
 *
 * Used by Project → Git to answer: the AI worked in my folder, how do I get the
 * work out? Never writes. Never builds a shell string from user input for exec —
 * only argument arrays via execFile. The host push command string is for display
 * / copy only, built after structured status is known.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Per-call budget so a huge repo cannot hang the UI. */
const GIT_TIMEOUT_MS = 4_000;

export type GitWorkspaceKind =
  | "unbound"
  | "missing"
  | "git-missing"
  | "not-repo"
  | "empty"
  | "ready";

export interface GitWorkspaceCommit {
  sha: string;
  subject: string;
  relativeDate: string;
}

export interface GitWorkspaceStatus {
  kind: GitWorkspaceKind;
  workspace: string | null;
  /** Human-readable status for the UI (never invents repo names). */
  summary: string;
  branch: string | null;
  staged: number;
  unstaged: number;
  untracked: number;
  /** Commits ahead of upstream; null when no upstream or not measurable. */
  ahead: number | null;
  upstream: string | null;
  commits: GitWorkspaceCommit[];
  /**
   * Exact host shell command to run outside the room, or null when not a repo
   * / no branch yet (UI shows init guidance instead).
   */
  hostCommand: string | null;
  /** When kind is not-repo or empty, short guidance instead of a push command. */
  hostGuidance: string | null;
}

function shellQuote(value: string): string {
  // POSIX-safe single-quoted string for host copy/paste.
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; code: number | null; stderr: string; missing: boolean }> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout ?? "" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    if (e.code === "ENOENT") {
      return { ok: false, code: null, stderr: "git not found", missing: true };
    }
    const code = typeof e.code === "number" ? e.code : null;
    return {
      ok: false,
      code,
      stderr: String(e.stderr ?? e.message ?? ""),
      missing: false,
    };
  }
}

function countPorcelain(statusText: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of statusText.split("\n")) {
    if (!line || line.length < 2) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" && y === "?") {
      untracked += 1;
      continue;
    }
    // Index (staged) column
    if (x !== " " && x !== "?") staged += 1;
    // Worktree (unstaged) column
    if (y !== " " && y !== "?") unstaged += 1;
  }
  return { staged, unstaged, untracked };
}

function parseLog(stdout: string): GitWorkspaceCommit[] {
  const commits: GitWorkspaceCommit[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [sha, relativeDate, ...rest] = line.split("\t");
    if (!sha) continue;
    commits.push({
      sha: sha.trim(),
      relativeDate: (relativeDate ?? "").trim(),
      subject: rest.join("\t").trim(),
    });
  }
  return commits;
}

/**
 * Render the SSH key path for use inside GIT_SSH_COMMAND, which git executes via
 * a shell. Two rules:
 *
 * 1. **Fail closed.** Config on disk may predate `normalizeSshKeyPath` (or be
 *    hand-edited), so a value carrying shell syntax is dropped entirely rather
 *    than pasted into a command we tell the user to run.
 * 2. **Keep `~` expandable.** A leading `~/` must stay unquoted; only the
 *    remainder is quoted, and only when it needs it (spaces are legal in paths).
 */
function sshKeyArg(rawKey: string): string | null {
  const key = String(rawKey ?? "").trim();
  if (!key) return null;
  if (!(key.startsWith("/") || key.startsWith("~/"))) return null;
  if (/[;&|<>$`'"\\]/.test(key)) return null;
  if (/[\u0000-\u001f\u007f]/.test(key)) return null;
  if (key.includes("..")) return null;
  if (!/\s/.test(key)) return key;
  if (key.startsWith("~/")) return `~/${shellQuote(key.slice(2))}`;
  return shellQuote(key);
}

export interface HostGitCommandOpts {
  /** Host path to SSH private key — referenced only in GIT_SSH_COMMAND for copy/paste. */
  sshKeyPath?: string;
  userName?: string;
  userEmail?: string;
}

function buildHostCommand(
  workspace: string,
  branch: string | null,
  upstream: string | null,
  opts: HostGitCommandOpts = {},
): string | null {
  if (!branch || branch === "HEAD") return null;
  const cd = `cd ${shellQuote(workspace)}`;
  const envParts: string[] = [];
  const key = String(opts.sshKeyPath ?? "").trim();
  const keyArg = sshKeyArg(key);
  if (keyArg) {
    // Display-only. Never reads the key file. IdentitiesOnly avoids leaking other host keys.
    envParts.push(`GIT_SSH_COMMAND=${shellQuote(`ssh -i ${keyArg} -o IdentitiesOnly=yes`)}`);
  }
  const gitArgs: string[] = [];
  const userName = String(opts.userName ?? "").trim();
  const userEmail = String(opts.userEmail ?? "").trim();
  if (userName) gitArgs.push(`-c user.name=${shellQuote(userName)}`);
  if (userEmail) gitArgs.push(`-c user.email=${shellQuote(userEmail)}`);
  const git = gitArgs.length ? `git ${gitArgs.join(" ")}` : "git";
  const push = upstream
    ? `${git} push`
    : `${git} push --set-upstream origin ${shellQuote(branch)}`;
  const prefix = envParts.length ? `${envParts.join(" ")} ` : "";
  return `${cd} && ${prefix}${push}`;
}

/**
 * Read-only snapshot of git state for a Project workspace path.
 * `workspace` may be empty / missing — returned as first-class kinds.
 */
export async function readGitWorkspaceStatus(
  workspaceRaw: string | undefined | null,
  hostOpts: HostGitCommandOpts = {},
): Promise<GitWorkspaceStatus> {
  const workspace = String(workspaceRaw ?? "").trim() || null;

  const base = (): GitWorkspaceStatus => ({
    kind: "unbound",
    workspace,
    summary: "",
    branch: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: null,
    upstream: null,
    commits: [],
    hostCommand: null,
    hostGuidance: null,
  });

  if (!workspace) {
    return {
      ...base(),
      kind: "unbound",
      summary: "No folder is bound to this Project yet.",
      hostGuidance: "Bind a workspace under Project → Folders, then return here.",
    };
  }

  if (!existsSync(workspace)) {
    return {
      ...base(),
      kind: "missing",
      summary: "The bound folder is missing on this Mac.",
      hostGuidance: "Re-bind an existing folder under Project → Folders.",
    };
  }

  const inside = await git(workspace, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok && inside.missing) {
    return {
      ...base(),
      kind: "git-missing",
      summary: "Git is not installed (or not on PATH) on this Mac.",
      hostGuidance: "Install git on the host, then re-open this page.",
    };
  }
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      ...base(),
      kind: "not-repo",
      summary: "This folder is not a git repository.",
      hostGuidance: `On the host: cd ${shellQuote(workspace)} && git init`,
    };
  }

  const branchResult = await git(workspace, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let branch: string | null = null;
  if (branchResult.ok) {
    const b = branchResult.stdout.trim();
    branch = b || null;
  }

  // Empty repo: HEAD exists as symbolic ref but no commits yet → often "HEAD"
  const headOk = await git(workspace, ["rev-parse", "--verify", "HEAD"]);
  const empty = !headOk.ok;

  const statusResult = await git(workspace, ["status", "--porcelain"]);
  const counts = statusResult.ok
    ? countPorcelain(statusResult.stdout)
    : { staged: 0, unstaged: 0, untracked: 0 };

  let upstream: string | null = null;
  let ahead: number | null = null;
  if (!empty) {
    const up = await git(workspace, ["rev-parse", "--abbrev-ref", "@{u}"]);
    if (up.ok) {
      upstream = up.stdout.trim() || null;
      const aheadResult = await git(workspace, ["rev-list", "--count", "@{u}..HEAD"]);
      if (aheadResult.ok) {
        const n = Number.parseInt(aheadResult.stdout.trim(), 10);
        ahead = Number.isFinite(n) ? n : null;
      }
    } else {
      upstream = null;
      ahead = null;
    }
  }

  let commits: GitWorkspaceCommit[] = [];
  if (!empty) {
    const log = await git(workspace, ["log", "-5", "--format=%h\t%ar\t%s"]);
    if (log.ok) commits = parseLog(log.stdout);
  }

  if (empty) {
    return {
      ...base(),
      kind: "empty",
      summary: "Git repository with no commits yet.",
      branch: branch === "HEAD" ? null : branch,
      ...counts,
      hostCommand: null,
      hostGuidance: "Create a commit first; authenticated remote access follows Project → Git.",
    };
  }

  const hostCommand = buildHostCommand(workspace, branch, upstream, hostOpts);
  const parts: string[] = [];
  if (branch) parts.push(`On ${branch}`);
  if (upstream) {
    parts.push(ahead === 0 ? `up to date with ${upstream}` : `${ahead ?? "?"} commit(s) ahead of ${upstream}`);
  } else {
    parts.push("no upstream set");
  }
  const dirty = counts.staged + counts.unstaged + counts.untracked;
  if (dirty) {
    parts.push(`${counts.staged} staged · ${counts.unstaged} unstaged · ${counts.untracked} untracked`);
  } else {
    parts.push("clean working tree");
  }

  return {
    kind: "ready",
    workspace,
    summary: parts.join(" · "),
    branch,
    staged: counts.staged,
    unstaged: counts.unstaged,
    untracked: counts.untracked,
    ahead,
    upstream,
    commits,
    hostCommand,
    hostGuidance: hostCommand
      ? null
      : "No branch name is available yet — create a commit first, then use the Project's Git access.",
  };
}
