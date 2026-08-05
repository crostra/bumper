/**
 * Room Git credential broker.
 *
 * The Room never sends a git argv.  Its helper can only put protocol, host and
 * path into a file queue.  Project policy is the sole source of a token scope.
 */
import {
  closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Door, RoomSpec } from "./room/backend.js";
import { readGitSessionLease } from "./git-session-lease.js";
import {
  allowsWrite,
  describeGitCapability,
  maxGitCapability,
  minGitCapability,
  normalizeGitCapability,
  type GitCapability,
} from "./git-capability.js";
import { projectGitBindings } from "./git-repositories.js";

export const ROOM_GIT_MOUNT = "/bumper-git";
export const ROOM_GIT_CONTEXT = `${ROOM_GIT_MOUNT}/context.json`;
export type GitAccess = "none" | "read" | "write";

export interface GitCredentialRequest {
  protocol?: string;
  host?: string;
  path?: string;
}

/** One repository the Room may reach, and the rung it is bound at. */
export interface GitRepositoryPolicy {
  repository: string;
  capability: GitCapability;
}

export interface ProjectGitPolicy {
  /**
   * Every repository this Project binds, each at its own rung. A repository
   * absent from this list is not reachable — the broker refuses the credential
   * request rather than falling back to a Project-wide setting.
   */
  repositories: GitRepositoryPolicy[];
  host: string;
  /** Live temporary elevation from read to write, applied to read bindings. */
  writeUntil?: string;
}

export interface IssuedGitToken {
  token: string;
  expiresAt: string;
  scope: "read" | "write";
  capability?: GitCapability;
  /** Routes revocation back to the Keychain namespace that issued the token. */
  connectionId?: string;
}

export interface GitTokenIssuer {
  /** Mint a token covering `repository` at exactly `capability`. */
  issue(request: { repository: string; capability: GitCapability }): Promise<IssuedGitToken>;
  revoke?(token: IssuedGitToken): Promise<void>;
}

export type GitBrokerEvent = (event: {
  decision: "allowed" | "blocked" | "failed";
  target: string;
  reason: string;
}) => void;

function normalizedRepo(path: unknown): string {
  return String(path ?? "")
    .trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").toLowerCase();
}

function normalizedHost(host: unknown): string {
  return String(host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

/**
 * A live "write for 15 minutes" raises read bindings to write and leaves
 * everything else alone: a repository the Project deliberately bound read-only
 * is the one the elevation exists for, while pr/workflow rungs are already
 * above write and must not be quietly narrowed to it.
 */
export function effectiveRepositoryCapability(
  capability: GitCapability,
  writeUntil: string | undefined,
  now = Date.now(),
): GitCapability {
  if (capability !== "read") return capability;
  const until = Date.parse(String(writeUntil ?? ""));
  return Number.isFinite(until) && until > now ? "write" : "read";
}

function effectivePolicy(policy: ProjectGitPolicy, now = Date.now()): ProjectGitPolicy {
  return {
    ...policy,
    repositories: policy.repositories.map((row) => ({
      ...row,
      capability: effectiveRepositoryCapability(row.capability, policy.writeUntil, now),
    })),
  };
}

/** The strongest rung this policy grants anywhere. Banners and Overview only. */
export function policyCeiling(policy: ProjectGitPolicy): GitCapability {
  return policy.repositories.reduce<GitCapability>(
    (top, row) => maxGitCapability(top, row.capability),
    "none",
  );
}

/** Fixed helper protocol: no argv and no operation type cross the boundary. */
export function gitCredentialHelperScript(mountRoot = ROOM_GIT_MOUNT): string {
  const queue = `${mountRoot}/queue`;
  return `#!/bin/sh
# Bumper Git credential helper. It forwards only Git's credential fields.
Q="${queue}"
op="$1"
[ "$op" = get ] || exit 0
protocol="" host="" path=""
while IFS='=' read -r key value; do
  [ -z "$key" ] && break
  case "$key" in protocol) protocol="$value";; host) host="$value";; path) path="$value";; esac
done
stem="$(mktemp -u "$Q/git.XXXXXXXX" 2>/dev/null || echo "$Q/git.$$.$(date +%s)")"
printf '{"protocol":"%s","host":"%s","path":"%s"}\n' "$protocol" "$host" "$path" > "$stem.req.tmp"
mv "$stem.req.tmp" "$stem.req"
i=0
while [ ! -f "$stem.res" ] && [ "$i" -lt 100 ]; do i=$((i + 1)); sleep 0.1; done
if [ -f "$stem.res" ]; then
  # Response is already a fixed credential protocol, never evaluated as shell.
  cat "$stem.res"
fi
rm -f "$stem.req" "$stem.res"
exit 0
`;
}

/** Environment form avoids config files and ensures useHttpPath is always set. */
export function roomGitCredentialEnv(): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: `${ROOM_GIT_MOUNT}/git-credential-bumper`,
    GIT_CONFIG_KEY_1: "credential.useHttpPath",
    GIT_CONFIG_VALUE_1: "true",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    BUMPER_GIT_CONTEXT: ROOM_GIT_CONTEXT,
  };
}

/** Stable identity for one policy, used to detect live changes. */
function policyFingerprint(policy: ProjectGitPolicy): string {
  return policy.repositories
    .map((row) => `${row.repository.toLowerCase()}=${row.capability}`)
    .sort()
    .join(" ");
}

export class RoomGitBroker {
  private readonly queueDir: string;
  private readonly inFlight = new Set<string>();
  private timer?: NodeJS.Timeout;
  /**
   * One cached token per repository+rung. A Project can bind repositories at
   * different rungs, and an installation token carries a single permission set,
   * so a single cached token would either be too wide for one repository or too
   * narrow for another.
   */
  private readonly cache = new Map<string, IssuedGitToken>();
  private draining?: Promise<void>;
  private stopping = false;
  private previousPolicy?: ProjectGitPolicy;
  private readonly policyProvider: () => ProjectGitPolicy;

  constructor(
    private readonly dir: string,
    policy: ProjectGitPolicy | (() => ProjectGitPolicy),
    private readonly issuer: GitTokenIssuer,
    private readonly event: GitBrokerEvent = () => {},
  ) {
    this.queueDir = join(dir, "queue");
    this.policyProvider = typeof policy === "function" ? policy : () => policy;
  }

  /**
   * Resolved policy — for banners/tests. Never re-derive access elsewhere.
   * `access` is the coarse ceiling across every bound repository.
   */
  get access(): GitAccess {
    const ceiling = policyCeiling(this.policy());
    return ceiling === "none" ? "none" : (allowsWrite(ceiling) ? "write" : "read");
  }
  get capability(): GitCapability { return policyCeiling(this.policy()); }
  get repositories(): GitRepositoryPolicy[] { return this.policy().repositories; }
  /** First bound repository. Kept for single-repository banners and tests. */
  get repository(): string { return this.policy().repositories[0]?.repository ?? ""; }

  setup(): { door: Door } {
    mkdirSync(this.queueDir, { recursive: true });
    writeFileSync(
      join(this.dir, "README.txt"),
      "Bumper Git access. Read context.json for the Project repository and access. This door contains no saved token or host credential.\n",
      { mode: 0o644 },
    );
    writeFileSync(join(this.dir, "git-credential-bumper"), gitCredentialHelperScript(), { mode: 0o755 });
    this.writeContext(this.policy());
    return { door: { hostPath: this.dir, roomPath: ROOM_GIT_MOUNT, access: "read-write" } };
  }

  start(intervalMs = 120): void {
    if (this.timer) return;
    this.stopping = false;
    this.previousPolicy = this.policy();
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      await this.draining;
      return;
    }
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
    await this.revokeCached(undefined, "Sandbox session ended");
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  async drain(): Promise<void> {
    if (this.stopping) return;
    if (this.draining) return this.draining;
    this.draining = this.drainOnce().finally(() => { this.draining = undefined; });
    return this.draining;
  }

  private async drainOnce(): Promise<void> {
    await this.reconcilePolicy();
    let names: string[];
    try { names = readdirSync(this.queueDir); } catch { return; }
    await Promise.all(names.filter((name) => name.endsWith(".req")).map(async (name) => {
      const stem = name.slice(0, -4);
      if (this.inFlight.has(stem) || existsSync(join(this.queueDir, `${stem}.res`))) return;
      this.inFlight.add(stem);
      try { await this.answer(join(this.queueDir, name), join(this.queueDir, `${stem}.res`)); }
      finally { this.inFlight.delete(stem); }
    }));
  }

  private async answer(requestPath: string, responsePath: string): Promise<void> {
    let request: GitCredentialRequest;
    let requestFd: number | undefined;
    try {
      requestFd = openSync(requestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      request = JSON.parse(readFileSync(requestFd, "utf8")) as GitCredentialRequest;
    }
    catch {
      this.event({ decision: "blocked", target: "Git credential", reason: "invalid Sandbox request" });
      this.publish(responsePath, "quit=1\n\n");
      return;
    }
    finally { if (requestFd !== undefined) try { closeSync(requestFd); } catch { /* closed */ } }
    const policy = this.policy();
    const resolved = this.resolve(request, policy);
    if ("denial" in resolved) {
      this.event({ decision: "blocked", target: "Git credential", reason: resolved.denial });
      this.publish(responsePath, "quit=1\n\n");
      return;
    }
    const { repository, capability } = resolved.match;
    const key = `${repository.toLowerCase()} ${capability}`;
    try {
      const cached = this.cache.get(key);
      if (!cached || Date.parse(cached.expiresAt) <= Date.now() + 15_000) {
        if (cached) await this.revokeCached(key, "Git token rotated before replacement");
        /*
         * The request's own values were only used to select which binding
         * applies. The rung handed to issue() comes from Project config, never
         * from the Room — the Room cannot ask for more than it was granted.
         */
        const issued = await this.issuer.issue({ repository, capability });
        this.cache.set(key, issued);
        this.event({
          decision: "allowed",
          target: `Git token ${repository}`,
          reason: `${describeGitCapability(capability)} issued on first credential request; expires ${issued.expiresAt}`,
        });
      }
      this.publish(responsePath, `username=x-access-token\npassword=${this.cache.get(key)!.token}\n\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "token could not be issued";
      this.event({ decision: "failed", target: "Git credential", reason });
      this.publish(responsePath, "quit=1\n\n");
    }
  }

  /**
   * Which binding, if any, answers this credential request.
   *
   * Matching is on the repository path git asked for, so a Project binding ten
   * repositories still hands each one only its own token. An unbound repository
   * is refused here rather than being answered with some other repository's
   * credential.
   */
  private resolve(
    request: GitCredentialRequest,
    policy: ProjectGitPolicy,
  ): { match: GitRepositoryPolicy } | { denial: string } {
    if (!policy.repositories.length) return { denial: "this Project binds no repository" };
    if (String(request.protocol ?? "").toLowerCase() !== "https") return { denial: "protocol is not HTTPS" };
    if (normalizedHost(request.host) !== normalizedHost(policy.host)) return { denial: "host does not match Project repositories" };
    const wanted = normalizedRepo(request.path);
    if (!wanted) return { denial: "request named no repository" };
    const match = policy.repositories.find((row) => normalizedRepo(row.repository) === wanted);
    if (!match) return { denial: "repository is not bound to this Project" };
    if (match.capability === "none") return { denial: `${match.repository} is bound with no access` };
    return { match };
  }

  private policy(): ProjectGitPolicy {
    return effectivePolicy(this.policyProvider());
  }

  private async reconcilePolicy(): Promise<void> {
    const policy = this.policy();
    const previous = this.previousPolicy;
    this.previousPolicy = policy;
    const before = previous ? policyFingerprint(previous) : undefined;
    const after = policyFingerprint(policy);
    if (before !== after || previous?.writeUntil !== policy.writeUntil) this.writeContext(policy);
    if (previous && before !== after) {
      const temporaryEnded = allowsWrite(policyCeiling(previous))
        && !allowsWrite(policyCeiling(policy))
        && Boolean(policy.writeUntil)
        && Date.parse(policy.writeUntil ?? "") <= Date.now();
      this.event({
        decision: "allowed",
        target: temporaryEnded ? "Temporary Git write access ended" : "Git access changed",
        reason: `${before || "no repository"} → ${after || "no repository"}`,
      });
    }
    /*
     * Any token whose repository+rung is no longer exactly what the policy says
     * must go back before the next request can be answered — that is what makes
     * a live change in the Control Plane real rather than advisory.
     */
    const valid = new Set(policy.repositories
      .filter((row) => row.capability !== "none")
      .map((row) => `${row.repository.toLowerCase()} ${row.capability}`));
    for (const key of [...this.cache.keys()]) {
      if (!valid.has(key)) await this.revokeCached(key, "Project Git access changed");
    }
  }

  /**
   * The Sandbox's only description of its Git access. Contains no secret: it names
   * repositories and rungs so an AI can see what it may attempt instead of
   * discovering the boundary through a confusing failure.
   */
  private writeContext(policy: ProjectGitPolicy): void {
    const rows = policy.repositories.filter((row) => row.capability !== "none");
    const first = rows[0];
    const context = {
      provider: "github",
      // Singular fields kept so an older in-room reader still works.
      repository: first?.repository ?? "",
      access: first ? (allowsWrite(first.capability) ? "write" : "read") : "none",
      httpsUrl: first ? `https://github.com/${first.repository}` : "",
      cloneUrl: first ? `https://github.com/${first.repository}.git` : "",
      repositories: rows.map((row) => ({
        repository: row.repository,
        capability: row.capability,
        access: allowsWrite(row.capability) ? "write" : "read",
        can: describeGitCapability(row.capability),
        httpsUrl: `https://github.com/${row.repository}`,
        cloneUrl: `https://github.com/${row.repository}.git`,
      })),
      instruction: rows.length
        ? "Use the canonical HTTPS URL. Git asks Bumper for a token automatically, scoped per repository to the access listed here. Any repository not listed is unreachable."
        : "This Project has no GitHub repository access.",
    };
    try {
      writeFileSync(join(this.dir, "context.json"), `${JSON.stringify(context, null, 2)}\n`, { mode: 0o644 });
    } catch { /* diagnostics are non-authoritative; broker policy still fails closed */ }
  }

  /** Give back one cached token. Pass no key to give back all of them. */
  private async revokeCached(key: string | undefined, reason: string): Promise<void> {
    const keys = key === undefined ? [...this.cache.keys()] : [key];
    for (const item of keys) {
      const cached = this.cache.get(item);
      this.cache.delete(item);
      if (!cached || !this.issuer.revoke) continue;
      try {
        await this.issuer.revoke(cached);
        this.event({ decision: "allowed", target: "Git token revoked", reason });
      } catch {
        this.event({ decision: "failed", target: "Git token revocation", reason: `${reason}; best-effort revocation failed` });
      }
    }
  }

  private publish(path: string, text: string): void {
    let fd: number | undefined;
    const tmp = `${path}.tmp`;
    try {
      fd = openSync(
        tmp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, text, { encoding: "utf8" });
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, path);
    } catch {
      if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
      try { rmSync(tmp, { force: true }); } catch { /* helper fails closed */ }
    }
  }
}

/**
 * Build a Room git broker for a Project.
 *
 * Both launch paths must go through this: the GUI `SessionManager` and the CLI
 * `bumper <cli>` attach. The first implementation wired the broker into
 * SessionManager only — and SessionManager has no entry point any more, so the
 * whole feature was unreachable from the path users actually run. Keeping the
 * policy resolution in one place is what stops that recurring.
 *
 * Scope is derived from Project config here and nowhere else (decision §7,
 * invariant R4): the caller supplies no scope and the Room supplies none either.
 */
interface GitProjectContext {
  gitAccess?: string | null; gitRepository?: string | null; gitWriteUntil?: string | null;
  gitProviderConnectionId?: string | null; gitInstallationId?: number | null; gitRepositoryId?: number | null;
  gitRepositories?: unknown;
}

type GitInstallations = Array<{
  connectionId: string;
  id: number | string;
  repositories: Array<{ id: number; fullName: string }>;
}>;

export function projectGitBroker(opts: {
  dir: string;
  /** Live host-side lease. Missing/stale lease fails this broker closed. */
  sessionId?: string;
  projectName: string;
  context: GitProjectContext;
  installations: GitInstallations;
  resolveState?: () => { context: GitProjectContext; installations: GitInstallations };
  github: {
    issue(
      connectionId: string,
      installationId: string,
      repos: Array<{ id: number; fullName: string; owner: string; name: string }>,
      capability: GitCapability,
      context?: { projectName?: string; repository?: string; sessionId?: string; purpose?: "git" | "repository-listing" },
    ): Promise<IssuedGitToken>;
    revoke(connectionId: string, token: string): Promise<void>;
  };
  onEvent: GitBrokerEvent;
}): RoomGitBroker {
  const state = () => opts.resolveState?.() ?? {
    context: opts.context,
    installations: opts.installations,
  };

  const policy = (): ProjectGitPolicy => {
    const current = state().context;
    const bindings = projectGitBindings(current as never);
    /*
     * The live Session lease is a ceiling over every binding, not a separate
     * setting: turning a Session off must take away all of its repositories,
     * and a lease that is missing or stale fails the whole broker closed.
     */
    const ceiling = bindings.reduce<GitCapability>(
      (top, row) => maxGitCapability(top, row.capability),
      "none",
    );
    const lease = opts.sessionId ? readGitSessionLease(opts.sessionId, ceiling === "none" ? "none" : "read") : undefined;
    const live = !opts.sessionId || Boolean(lease?.live && lease.control.enabled);
    return {
      repositories: live
        ? bindings.map((row) => ({ repository: row.fullName, capability: row.capability }))
        : [],
      host: "github.com",
      writeUntil: opts.sessionId
        ? String(lease?.control.writeUntil ?? "")
        : String(current.gitWriteUntil ?? ""),
    };
  };

  return new RoomGitBroker(opts.dir, policy, {
    issue: async ({ repository, capability }) => {
      const { installations, context } = state();
      const binding = projectGitBindings(context as never)
        .find((row) => row.fullName.toLowerCase() === repository.toLowerCase());
      if (!binding) throw new Error("Repository is not bound to this Project.");
      const installation = installations.find((item) =>
        item.connectionId === binding.connectionId
        && Number(item.id) === binding.installationId);
      const selected = installation?.repositories.find((repo) =>
        repo.id === binding.repositoryId
        && repo.fullName.toLowerCase() === repository.toLowerCase());
      if (!installation || !selected) {
        throw new Error("Project repository is not installed for its bound GitHub connection.");
      }
      const [owner, name] = selected.fullName.split("/", 2);
      /*
       * The rung is capped by the binding even though the caller already
       * resolved it: a temporary elevation must never exceed what the Project
       * granted plus write, and this is the last place before the network.
       */
      const granted = minGitCapability(
        capability,
        maxGitCapability(binding.capability, "write"),
      );
      return opts.github.issue(
        installation.connectionId,
        String(installation.id),
        [{ id: selected.id, fullName: selected.fullName, owner: owner ?? "", name: name ?? "" }],
        granted,
        {
          projectName: opts.projectName,
          repository: selected.fullName,
          sessionId: opts.sessionId,
          purpose: "git",
        },
      );
    },
    revoke: async (token) => opts.github.revoke(String(token.connectionId ?? ""), token.token),
  }, opts.onEvent);
}

/** Launch-banner line. Honest: Bumper issues a token, it does not police git. */
export function describeGitAccess(
  broker: Pick<RoomGitBroker, "access" | "repository" | "repositories">,
): string {
  const rows = broker.repositories ?? [];
  if (!rows.length) return "no access token is configured";
  if (rows.length === 1) {
    const only = rows[0]!;
    return `GitHub issues a token for ${only.repository} scoped to "${describeGitCapability(only.capability)}" when git first asks (Bumper does not inspect git commands)`;
  }
  const listed = rows
    .map((row) => `${row.repository} (${describeGitCapability(row.capability)})`)
    .join(", ");
  return `GitHub issues a separate token per repository when git first asks — ${listed} — and nothing else is reachable (Bumper does not inspect git commands)`;
}

/**
 * Attach the broker door and the fixed git config env to a launch spec.
 *
 * Both launch paths must compose through this single function. The first
 * revision hand-assembled the door and env inside SessionManager only, so
 * `bumper <cli>` — the path users actually run — silently had no git access at
 * all. A shared composer plus the convergence test in test/git-broker.test.mjs
 * is what makes that failure impossible to reintroduce quietly.
 */
export function withGitBroker(spec: RoomSpec, door: Door): RoomSpec {
  return {
    ...spec,
    doors: [...spec.doors, door],
    env: { ...spec.env, ...roomGitCredentialEnv() },
  };
}
