/** GitHub App manifest and installation-token service. No user PATs are used. */
import {
  createHash, createPrivateKey, createSign, randomBytes,
} from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, constants, mkdirSync, openSync, statSync, unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { logEvent, type LogEvent } from "./log.js";
import { stateDir } from "./paths.js";
import {
  describeGitCapability,
  gitCapabilityPermissions,
  GITHUB_APP_PERMISSIONS,
  tokenMatchesCapability,
  type GitCapability,
} from "./git-capability.js";

export interface GitHubRepository {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  private?: boolean;
}
export interface GitHubInstallation {
  id: number;
  account: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  settingsUrl?: string;
  repositories: GitHubRepository[];
}
export interface GitHubAppPublic {
  id: string;
  appId: number;
  slug: string;
  ownerLogin?: string;
  ownerType?: string;
  repositories: GitHubRepository[];
}
export interface GitHubHttp {
  request(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
}
export interface SecretStore { get(name: string): string | undefined; set(name: string, value: string): void; delete(name: string): void; }
export interface ShortPasswordStore { get(name: string): string | undefined; set(name: string, value: string): void; delete(name: string): void; }

const SERVICE = "com.crostra.bumper.github-app";
const memory = new Map<string, string>();
const tokenStoreWait = new Int32Array(new SharedArrayBuffer(4));
const KEYCHAIN_CHUNK_CHARS = 80;

/** Keep password bytes off argv and detach from the AI CLI's controlling TTY. */
export function keychainPromptOptions(password: string) {
  return {
    encoding: "utf8" as const,
    input: `${password}\n${password}\n`,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    timeout: 15_000,
  };
}

/**
 * Git sessions are separate host processes. Serialize Keychain read/modify/write
 * so two sessions cannot overwrite each other's crash-sweep token record.
 */
function withTokenStoreLock<T>(action: () => T): T {
  mkdirSync(stateDir(), { recursive: true });
  const path = join(stateDir(), "github-token-store.lock");
  let fd: number | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 5_000) unlinkSync(path);
      } catch { /* another process released it */ }
      Atomics.wait(tokenStoreWait, 0, 0, 10);
    }
  }
  if (fd === undefined) throw new Error("Could not lock the GitHub token sweep store.");
  try {
    return action();
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(path); } catch { /* another cleanup won */ }
  }
}

/** One short macOS Keychain password. The `security` prompt truncates long lines. */
const shortPasswords: ShortPasswordStore = {
  get(name) {
    if (process.platform !== "darwin") return memory.get(name);
    const out = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"], { encoding: "utf8" });
    if (out.status !== 0) return undefined;
    return out.stdout.trim();
  },
  set(name, password) {
    if (process.platform !== "darwin") { memory.set(name, password); return; }
    /*
     * Never put a password in argv: a private key or token in the argument list is
     * readable from `ps` by anything running on this Mac. `security` documents the
     * prompt as the safe path ("Use of the -p or -w options is insecure"), and the
     * prompt asks twice, so the value is written twice on stdin.
     */
    const out = spawnSync(
      "security",
      ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-w"],
      keychainPromptOptions(password),
    );
    if (out.status !== 0) throw new Error("Could not save GitHub App secret in Keychain.");
  },
  delete(name) {
    if (process.platform !== "darwin") { memory.delete(name); return; }
    spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", name], { encoding: "utf8" });
  },
};

function decodeLegacy(value: string): string | undefined {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return decoded || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Store arbitrarily long values as short Keychain passwords.
 *
 * macOS `security add-generic-password -w` reads the password from a terminal-
 * style prompt whose input line is limited. A GitHub PEM was therefore silently
 * truncated to 128 base64 characters. Chunks stay well below that limit. A
 * generation-specific set is written first and a small manifest is committed
 * last, so interruption cannot replace a valid value with a partial one.
 */
export function createChunkedSecretStore(
  passwords: ShortPasswordStore,
  chunkChars = KEYCHAIN_CHUNK_CHARS,
): SecretStore {
  function readMeta(name: string): { generation: string; count: number; digest: string } | undefined {
    const raw = passwords.get(`${name}.meta`);
    if (!raw) return undefined;
    const match = /^v1\|([a-f0-9]+)\|([1-9]\d*)\|([a-f0-9]{64})$/.exec(raw);
    if (!match) return undefined;
    return { generation: match[1], count: Number(match[2]), digest: match[3] };
  }
  function chunkName(name: string, generation: string, index: number): string {
    return `${name}.${generation}.${index}`;
  }
  function deleteGeneration(name: string, meta: { generation: string; count: number } | undefined): void {
    if (!meta) return;
    for (let index = 0; index < meta.count; index += 1) {
      passwords.delete(chunkName(name, meta.generation, index));
    }
  }
  return {
    get(name) {
      const metaRaw = passwords.get(`${name}.meta`);
      const meta = readMeta(name);
      if (!meta) {
        // Versions before chunking stored one base64 password at the plain name.
        // A malformed manifest must fail closed instead of falling back.
        return metaRaw === undefined ? decodeLegacy(passwords.get(name) ?? "") : undefined;
      }
      let encoded = "";
      for (let index = 0; index < meta.count; index += 1) {
        const chunk = passwords.get(chunkName(name, meta.generation, index));
        if (chunk === undefined) return undefined;
        encoded += chunk;
      }
      if (createHash("sha256").update(encoded).digest("hex") !== meta.digest) return undefined;
      return decodeLegacy(encoded);
    },
    set(name, value) {
      if (!Number.isInteger(chunkChars) || chunkChars < 16 || chunkChars > 100) {
        throw new Error("Invalid Keychain chunk size.");
      }
      const previous = readMeta(name);
      const generation = randomBytes(8).toString("hex");
      const encoded = Buffer.from(value, "utf8").toString("base64");
      const chunks = encoded.match(new RegExp(`.{1,${chunkChars}}`, "g")) ?? [""];
      try {
        chunks.forEach((chunk, index) => passwords.set(chunkName(name, generation, index), chunk));
        const digest = createHash("sha256").update(encoded).digest("hex");
        passwords.set(`${name}.meta`, `v1|${generation}|${chunks.length}|${digest}`);
      } catch (error) {
        deleteGeneration(name, { generation, count: chunks.length });
        throw error;
      }
      deleteGeneration(name, previous);
      passwords.delete(name);
    },
    delete(name) {
      deleteGeneration(name, readMeta(name));
      passwords.delete(`${name}.meta`);
      passwords.delete(name);
    },
  };
}

/** macOS Keychain in production; non-macOS is process-memory for tests only. */
export const keychain: SecretStore = createChunkedSecretStore(shortPasswords);

export function githubAppManifest(
  callbackUrl: string,
  name = "Bumper Git access",
): Record<string, unknown> {
  return {
    name,
    url: "https://github.com/crostra/bumper",
    // Deliberately omit hook_attributes and default_events. A hook object makes
    // its URL mandatory and GitHub rejects loopback even when active is false.
    // Bumper receives no webhooks; redirect_url below is only the one-time
    // manifest conversion callback.
    redirect_url: callbackUrl,
    public: false,
    /*
     * The top of the capability ladder, not the middle.
     *
     * An App's permissions are fixed at creation: an issued token can only be
     * narrower than what the installation granted, and widening later forces
     * every existing installation through a re-approval. An App created with
     * `contents` alone can never issue a pull-request token — the Project would
     * hit a dead end that only a reinstall can clear.
     *
     * So the App is created able to reach the whole ladder, and every token
     * Bumper issues stays at the rung the Project chose (verified in issue()).
     * The distance between the two is shown in the UI rather than hidden.
     */
    default_permissions: GITHUB_APP_PERMISSIONS,
    // Deliberately absent: actions, deployments, packages, members, administration.
  };
}

function b64json(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
export function createAppJwt(appId: string, pem: string, now = Date.now()): string {
  const header = b64json({ alg: "RS256", typ: "JWT" });
  const payload = b64json({ iat: Math.floor(now / 1000) - 30, exp: Math.floor(now / 1000) + 9 * 60, iss: appId });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`); signer.end();
  return `${header}.${payload}.${signer.sign(createPrivateKey(pem)).toString("base64url")}`;
}

export class FetchGitHubHttp implements GitHubHttp {
  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2026-03-10", ...headers, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text(); let parsed: any = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text }; }
    return { status: res.status, body: parsed };
  }
}

export interface ManifestState {
  state: string;
  expiresAt: number;
  connectionId: string;
  organization?: string;
}
export interface InstallationToken {
  token: string;
  expiresAt: string;
  /** Coarse summary kept for banners and legacy readers. */
  scope: "read" | "write";
  /** The exact rung this token was minted at. */
  capability?: GitCapability;
  connectionId?: string;
}
export interface InstallationTokenContext {
  connectionId?: string;
  projectName?: string;
  repository?: string;
  sessionId?: string;
  purpose?: "git" | "repository-listing";
}

interface RememberedInstallationToken extends InstallationTokenContext {
  token: string;
  expiresAt?: string;
  scope?: "read" | "write";
}

export class GitHubAppService {
  private readonly connectionId: string;
  private readonly eventSink: (event: Omit<LogEvent, "ts">) => void;
  constructor(
    private readonly http: GitHubHttp = new FetchGitHubHttp(),
    private readonly secrets: SecretStore = keychain,
    connectionIdOrEventSink: string | ((event: Omit<LogEvent, "ts">) => void) = "",
    private readonly pending = new Map<string, ManifestState>(),
    eventSink: (event: Omit<LogEvent, "ts">) => void = logEvent,
  ) {
    this.connectionId = typeof connectionIdOrEventSink === "string" ? connectionIdOrEventSink : "";
    this.eventSink = typeof connectionIdOrEventSink === "function" ? connectionIdOrEventSink : eventSink;
  }
  forConnection(connectionId: string): GitHubAppService {
    if (!/^[a-zA-Z0-9_-]{1,96}$/.test(connectionId)) throw new Error("Invalid GitHub connection id.");
    return new GitHubAppService(this.http, this.secrets, connectionId, this.pending, this.eventSink);
  }
  private secretName(name: string): string {
    return this.connectionId ? `github-app:${this.connectionId}:${name}` : name;
  }
  beginManifest(state: string, organization: string | undefined, connectionId: string): ManifestState {
    const entry: ManifestState = {
      state,
      expiresAt: Date.now() + 60 * 60_000,
      connectionId,
      ...(organization ? { organization } : {}),
    };
    this.pending.set(state, entry);
    return entry;
  }
  manifestState(state?: string): ManifestState | undefined {
    return state ? this.pending.get(state) : this.pending.values().next().value;
  }
  async completeManifest(code: string, state: string): Promise<GitHubAppPublic> {
    const pending = this.pending.get(state);
    if (!pending || pending.expiresAt < Date.now()) throw new Error("GitHub App connection expired. Connect GitHub again.");
    const result = await this.http.request("POST", `/app-manifests/${encodeURIComponent(code)}/conversions`);
    if (result.status < 200 || result.status >= 300 || !result.body?.pem || !result.body?.id) throw new Error("GitHub App manifest exchange failed.");
    const scoped = this.forConnection(pending.connectionId);
    try {
      scoped.secrets.set(scoped.secretName("pem"), String(result.body.pem));
      scoped.secrets.set(scoped.secretName("app-id"), String(result.body.id));
    } catch {
      scoped.secrets.delete(scoped.secretName("pem"));
      scoped.secrets.delete(scoped.secretName("app-id"));
      throw new Error("Could not save the GitHub App key in Keychain.");
    }
    this.pending.delete(state);
    return {
      id: pending.connectionId,
      appId: Number(result.body.id),
      slug: String(result.body.slug ?? "bumper-git-access"),
      ownerLogin: String(result.body.owner?.login ?? pending.organization ?? "") || undefined,
      ownerType: String(result.body.owner?.type ?? (pending.organization ? "Organization" : "User")),
      repositories: [],
    };
  }
  async disconnect(): Promise<{ pendingRevocations: number }> {
    const { pending } = await this.revokeRemembered();
    for (const key of ["pem", "app-id"]) this.secrets.delete(this.secretName(key));
    if (pending === 0) this.secrets.delete(this.secretName("tokens"));
    return { pendingRevocations: pending };
  }
  migrateLegacySecrets(): boolean {
    if (!this.connectionId) return false;
    if (this.connected()) return true;
    const pem = this.secrets.get("pem");
    const appId = this.secrets.get("app-id");
    if (!pem || !appId) {
      // An incomplete legacy pair is unusable and cannot become complete later.
      // Move its public metadata into the plural model so the UI exposes the
      // broken connection and lets the user replace only that owner.
      this.secrets.delete("pem");
      this.secrets.delete("app-id");
      return true;
    }
    try {
      if (!/^\d+$/.test(appId)) throw new Error("invalid App id");
      createPrivateKey(pem);
    } catch {
      // A truncated legacy key can never authenticate again. Remove it and
      // migrate the public metadata so the UI can show "Key unavailable" and
      // offer an explicit reconnect instead of hiding a singular ghost record.
      this.secrets.delete("pem");
      this.secrets.delete("app-id");
      return true;
    }
    try {
      this.secrets.set(this.secretName("pem"), pem);
      this.secrets.set(this.secretName("app-id"), appId);
      if (!this.connected()) throw new Error("round-trip failed");
      this.secrets.delete("pem");
      this.secrets.delete("app-id");
      return true;
    } catch {
      this.secrets.delete(this.secretName("pem"));
      this.secrets.delete(this.secretName("app-id"));
      // Keep the valid legacy pair for a retry after a transient Keychain error.
      return false;
    }
  }
  connected(): boolean {
    const id = this.secrets.get(this.secretName("app-id"));
    const pem = this.secrets.get(this.secretName("pem"));
    if (!id || !pem || !/^\d+$/.test(id)) return false;
    try {
      createPrivateKey(pem);
      return true;
    } catch {
      return false;
    }
  }
  private auth(): Record<string, string> {
    const id = this.secrets.get(this.secretName("app-id"));
    const pem = this.secrets.get(this.secretName("pem"));
    if (!id || !pem) throw new Error("GitHub App is not connected.");
    try {
      return { authorization: `Bearer ${createAppJwt(id, pem)}` };
    } catch {
      throw new Error("GitHub App key is incomplete. Connect GitHub again.");
    }
  }
  /**
   * Installations and the repositories each one can reach.
   *
   * `/installation/repositories` authenticates with an **installation token**, not
   * the App JWT (GitHub Docs). An earlier revision sent the JWT, which GitHub
   * rejects — and the failure was swallowed into an empty array, so the repository
   * picker showed "no repositories" with no reason. Mint a short-lived token per
   * installation, list with it, then revoke it immediately: listing must not leave
   * a token alive.
   */
  async installations(): Promise<GitHubInstallation[]> {
    const result = await this.http.request("GET", "/app/installations", undefined, this.auth());
    if (result.status < 200 || result.status >= 300) throw new Error("Could not list GitHub App installations.");
    const rows = Array.isArray(result.body) ? result.body : [];
    const out: GitHubInstallation[] = [];
    for (const row of rows) {
      const id = String(row.id);
      const account = String(row.account?.login ?? "");
      const accountType = String(row.account?.type ?? "");
      const minted = await this.http.request(
        "POST", `/app/installations/${encodeURIComponent(id)}/access_tokens`,
        { permissions: { metadata: "read" } },
        this.auth(),
      );
      if (minted.status < 200 || minted.status >= 300 || !minted.body?.token) {
        throw new Error(`Could not read repositories for installation ${account || id}.`);
      }
      const listing = String(minted.body.token);
      try {
        this.remember({
          token: listing,
          expiresAt: String(minted.body.expires_at ?? ""),
          purpose: "repository-listing",
        });
      } catch {
        await this.http.request("DELETE", "/installation/token", undefined, { authorization: `token ${listing}` });
        throw new Error("Could not track the temporary GitHub repository-listing token.");
      }
      try {
        const repositoryRows: any[] = [];
        let page = 1;
        let total = 0;
        do {
          const repos = await this.http.request(
            "GET",
            `/installation/repositories?per_page=100&page=${page}`,
            undefined,
            { authorization: `token ${listing}` },
          );
          if (repos.status < 200 || repos.status >= 300) {
            throw new Error(`Could not read repositories for installation ${account || id}.`);
          }
          const rows = Array.isArray(repos.body?.repositories) ? repos.body.repositories : [];
          repositoryRows.push(...rows);
          total = Number(repos.body?.total_count ?? repositoryRows.length);
          page += 1;
          if (rows.length === 0) break;
        } while (repositoryRows.length < total);
        const repositories = repositoryRows.map((r: any) => ({
          id: Number(r.id),
          fullName: String(r.full_name),
          name: String(r.name),
          owner: String(r.owner?.login ?? ""),
          private: Boolean(r.private),
        }));
        if (repositories.some((repo) => !repo.id || !repo.fullName.includes("/"))) {
          throw new Error(`GitHub returned an invalid repository for installation ${account || id}.`);
        }
        out.push({
          id: Number(row.id),
          account,
          accountType,
          repositorySelection: row.repository_selection === "all" ? "all" : "selected",
          settingsUrl: /^https:\/\/github\.com\//.test(String(row.html_url ?? "")) ? String(row.html_url) : undefined,
          repositories,
        });
      } finally {
        // Listing is not access: never let this token outlive the call.
        try { await this.revoke(listing); } catch { /* expires within the hour anyway */ }
      }
    }
    return out;
  }

  /**
   * Mint one token for one rung of the ladder over one set of repositories.
   *
   * `repositories` is a list because an installation token carries a single
   * permission set: repositories that share a connection, installation and
   * capability share a token, and different rungs get different tokens. The
   * response is verified against both halves — the exact permission set and the
   * exact repository ids — because a token wider than the Project's choice must
   * never reach the Room.
   */
  async issue(
    installationId: string,
    repositories: GitHubRepository[],
    capability: GitCapability,
    context: InstallationTokenContext = {},
  ): Promise<InstallationToken> {
    const wanted = repositories.filter((repo) => Number(repo?.id) > 0);
    if (!wanted.length) throw new Error("No repository was selected for this GitHub token.");
    if (capability === "none") throw new Error("This Project does not grant access to that repository.");
    const result = await this.http.request("POST", `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
      repository_ids: wanted.map((repo) => repo.id),
      permissions: gitCapabilityPermissions(capability),
    }, this.auth());
    if (result.status < 200 || result.status >= 300 || !result.body?.token) throw new Error("GitHub could not issue an installation token.");
    const rawToken = String(result.body.token);
    if (!tokenMatchesCapability(capability, result.body?.permissions)) {
      await this.rejectUnexpectedToken(rawToken, context);
      throw new Error("GitHub token permissions did not match Project setting.");
    }
    const granted = Array.isArray(result.body?.repositories) ? result.body.repositories : [];
    const grantedIds = new Set(granted.map((repo: any) => Number(repo?.id)));
    if (grantedIds.size !== wanted.length || wanted.some((repo) => !grantedIds.has(repo.id))) {
      await this.rejectUnexpectedToken(rawToken, context);
      throw new Error("GitHub token repository did not match Project setting.");
    }
    const scope: "read" | "write" = capability === "read" ? "read" : "write";
    const token = {
      token: rawToken,
      expiresAt: String(result.body.expires_at),
      scope,
      capability,
      connectionId: this.connectionId || context.connectionId,
    };
    if (!Number.isFinite(Date.parse(token.expiresAt)) || Date.parse(token.expiresAt) <= Date.now()) {
      await this.rejectUnexpectedToken(rawToken, context);
      throw new Error("GitHub token expiry was invalid.");
    }
    const names = wanted.map((repo) => repo.fullName).join(", ");
    try {
      this.remember({
        ...token,
        ...context,
        connectionId: this.connectionId || context.connectionId,
        repository: names,
        purpose: "git",
      });
    } catch {
      await this.http.request("DELETE", "/installation/token", undefined, { authorization: `token ${token.token}` });
      throw new Error("Could not track the issued GitHub token for revocation.");
    }
    this.eventSink({
      context: context.projectName ?? "_system",
      surface: "session",
      source: "app",
      type: "git",
      decision: "allowed",
      target: `GitHub token ${names}`,
      reason: `${describeGitCapability(capability)} issued; expires ${token.expiresAt}`,
      sessionId: context.sessionId,
      access: scope,
      capability,
      repository: names,
      expiresAt: token.expiresAt,
    });
    return token;
  }
  /**
   * A token that fails response validation must never be handed into the Room.
   * Track it before best-effort revocation so an offline failure is retried by
   * the startup sweep; GitHub expiry remains the final one-hour upper bound.
   */
  private async rejectUnexpectedToken(
    token: string,
    context: InstallationTokenContext,
  ): Promise<void> {
    try {
      this.remember({ token, ...context, purpose: "git" });
    } catch { /* direct revocation may still succeed */ }
    try {
      await this.revoke(token);
    } catch { /* remembered token is retried by sweep */ }
  }
  async revoke(token: string): Promise<void> {
    const result = await this.http.request("DELETE", "/installation/token", undefined, { authorization: `token ${token}` });
    // 401/404 means GitHub no longer accepts the token (already revoked or
    // expired), which is the terminal state Bumper needs.
    if (![204, 401, 404].includes(result.status)) throw new Error("GitHub token revocation failed.");
    this.forget(token);
  }
  private readRememberedUnlocked(): RememberedInstallationToken[] {
    try {
      const rows = JSON.parse(this.secrets.get(this.secretName("tokens")) ?? "[]") as Array<string | RememberedInstallationToken>;
      return rows.map((row) => typeof row === "string" ? { token: row } : row)
        .filter((row) => Boolean(row?.token));
    } catch {
      return [];
    }
  }
  private remembered(): RememberedInstallationToken[] {
    return withTokenStoreLock(() => this.readRememberedUnlocked());
  }
  private remember(token: RememberedInstallationToken): void {
    withTokenStoreLock(() => {
      const rows = this.readRememberedUnlocked().filter((item) => item.token !== token.token);
      this.secrets.set(this.secretName("tokens"), JSON.stringify([...rows, token]));
    });
  }
  private forget(token: string): void {
    withTokenStoreLock(() => {
      this.secrets.set(this.secretName("tokens"), JSON.stringify(
        this.readRememberedUnlocked().filter((item) => item.token !== token),
      ));
    });
  }
  private async revokeRemembered(
    predicate: (token: RememberedInstallationToken) => boolean = () => true,
  ): Promise<{ revoked: number; pending: number }> {
    let revoked = 0;
    let pending = 0;
    for (const token of this.remembered().filter(predicate)) {
      try {
        await this.revoke(token.token);
        revoked += 1;
      } catch {
        pending += 1;
      }
    }
    return { revoked, pending };
  }
  async revokeProject(projectName: string): Promise<{ revoked: number; pending: number }> {
    return this.revokeRemembered((token) => token.projectName === projectName);
  }
  async revokeSession(sessionId: string): Promise<{ revoked: number; pending: number }> {
    return this.revokeRemembered((token) => token.sessionId === sessionId);
  }
  async sweep(): Promise<{ revoked: number; pending: number }> {
    const result = await this.revokeRemembered();
    if (result.pending === 0) this.secrets.delete(this.secretName("tokens"));
    return result;
  }
}
