/**
 * In-room authentication persistence (free-tier flow).
 *
 * A room's $HOME is a fresh, disposable microVM filesystem, and the macOS login
 * Keychain does not exist inside it — so if nothing is persisted, every launch
 * starts logged-out. Rather than smuggle host credentials in (that's the paid
 * broker/gateway story), the free tier gives each AI CLI a small, persistent
 * host directory mounted at the exact path the CLI keeps its own login state.
 * The user signs in once, in an explicit "sign-in" room session where egress is
 * open; the token the CLI writes lands in that mounted directory and is present
 * on every later launch.
 *
 * This is deliberately the CLI's *own* auth, done by the user — Bumper never
 * sees the token. Mounts are per-agent (and optionally per login profile) under
 * Bumper state so one project's sign-in can be shared or isolated by profile.
 *
 * ## Auth path vs binary install path (Phase 0)
 *
 * Auth doors overlay host state onto vendor *login* trees. CLI binaries must
 * remain on the image PATH outside those overlays (typically
 * `/root/.local/bin` or `/usr/local/bin`). If a vendor also unpacks binaries
 * under its home tree (e.g. grok under `/root/.grok/bin`), the recommended
 * image recipe materializes a real binary on PATH so an empty auth overlay
 * cannot hide the executable. Preflight uses the same auth mounts as launch
 * so a broken overlay fails before session creation.
 *
 * ## Login profiles (Phase 3)
 *
 * Default profile id is `default` and keeps the legacy host layout
 * `room-auth/<agent>/<path>` so existing sign-ins continue to work.
 * Named profiles use `room-auth/<agent>/profiles/<profileId>/<path>` so a
 * Project can mount e.g. personal vs work without sharing tokens.
 */
import {
  existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { stateDir } from "../paths.js";
import type { AgentId } from "../agents.js";
import type { Door } from "./backend.js";

export const DEFAULT_AUTH_PROFILE = "default";

/** Honest login status for Library / Project AI tools (not a launch hard gate). */
export type ProfileAuthStatus = "verified" | "needs-signin" | "unknown" | "checking";

/**
 * Where each CLI stores login/config state inside the room (HOME=/root in the
 * recommended image). Best-effort per vendor; mounting the directory persists
 * whatever the CLI writes there without Bumper needing to understand the format.
 *
 * These paths must NOT be the image PATH dirs that hold installed binaries.
 * See ROOM_IMAGE_BIN_DIRS and authDoorOverlapsBinaryInstall().
 */
const ROOM_AUTH_PATHS: Record<AgentId, string[]> = {
  claude: ["/root/.claude"],
  codex: ["/root/.codex"],
  // Linux: $XDG_CONFIG_HOME/cursor/auth.json (decompile of cursor-agent
  // getAuthFilePath). cursor-agent chmods that directory, and **a bind-mount root
  // cannot be chmodded** (virtiofs → EPERM), so mounting /root/.config/cursor made
  // login fail with "Failed to store authentication tokens: EPERM ... chmod".
  // Instead mount a private XDG root and point XDG_CONFIG_HOME at it: cursor then
  // creates /root/.cursor-xdg/cursor itself, which it *can* chmod. Using a fresh
  // path (not /root/.config) keeps image content unshadowed.
  // Do not reintroduce /root/.config/cursor or the older wrong /root/.config/cursor-agent.
  cursor: ["/root/.cursor", "/root/.cursor-xdg"],
  // Measured 2026-07-25 in bumper/ai-room: agy writes under ~/.gemini/
  // (antigravity-cli + config). Wrong guesses .antigravity / .config/antigravity
  // never received state. Exact OAuth token filename still 未検証 — see markers.
  antigravity: ["/root/.gemini"],
  // Login/config only at vendor home; binaries must live on PATH outside this tree
  // (see recommendedRoomDockerfile materializing /root/.local/bin/grok).
  grok: ["/root/.grok"],
};

/**
 * Image directories that carry CLI executables on PATH. Auth doors must never
 * mount over these (or mount a parent that replaces them wholesale).
 */
export const ROOM_IMAGE_BIN_DIRS = [
  "/root/.local/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
] as const;

export function normalizeAuthProfileId(profileId?: string | null): string {
  const id = String(profileId ?? DEFAULT_AUTH_PROFILE).trim();
  if (!id) return DEFAULT_AUTH_PROFILE;
  // Disallow path separators / traversal in profile segment.
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`Invalid auth profile id "${profileId}" — use a short name like "default" or "work".`);
  }
  return id;
}

function sanitizeRoomPathLeaf(roomPath: string): string {
  return roomPath.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+/, "");
}

function sanitizeProfileSegment(profileId: string): string {
  return profileId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "") || "profile";
}

/** Host directory backing one in-room auth path for an agent × profile slot. */
export function hostAuthDir(agentId: AgentId, roomPath: string, profileId?: string | null): string {
  const profile = normalizeAuthProfileId(profileId);
  const leaf = sanitizeRoomPathLeaf(roomPath);
  if (profile === DEFAULT_AUTH_PROFILE) {
    // Legacy layout — preserves existing free-tier sign-ins.
    return join(stateDir(), "room-auth", agentId, leaf);
  }
  return join(stateDir(), "room-auth", agentId, "profiles", sanitizeProfileSegment(profile), leaf);
}

/**
 * True when an auth roomPath would overlay (equal or parent/child) a PATH bin dir.
 * Used by regressions so we never reintroduce "empty auth mount hides grok".
 */
export function authDoorOverlapsBinaryInstall(roomPath: string): boolean {
  const auth = roomPath.replace(/\/+$/, "") || "/";
  for (const bin of ROOM_IMAGE_BIN_DIRS) {
    if (auth === bin) return true;
    if (bin.startsWith(`${auth}/`)) return true;
    if (auth.startsWith(`${bin}/`)) return true;
  }
  return false;
}

/**
 * The doors that persist a CLI's login across room launches. Created on demand
 * (empty dirs are harmless) and mounted read-write so the CLI can write tokens.
 * profileId defaults to "default" (legacy host path).
 */
export function roomAuthDoors(agentId: AgentId, profileId?: string | null): Door[] {
  const paths = ROOM_AUTH_PATHS[agentId] ?? [];
  const profile = normalizeAuthProfileId(profileId);
  return paths.map((roomPath) => {
    if (authDoorOverlapsBinaryInstall(roomPath)) {
      throw new Error(
        `Sandbox auth path ${roomPath} for ${agentId} overlaps an image binary install dir; ` +
          "login state and CLI binaries must stay on separate mount trees.",
      );
    }
    const host = hostAuthDir(agentId, roomPath, profile);
    mkdirSync(host, { recursive: true });
    return { hostPath: host, roomPath, access: "read-write" as const };
  });
}

export function roomAuthPaths(agentId: AgentId): string[] {
  return ROOM_AUTH_PATHS[agentId] ?? [];
}

/**
 * Env vars that relocate vendor config files into auth doors.
 *
 * Claude Code stores login state in both `~/.claude/` and `~/.claude.json`.
 * Apple container cannot bind-mount a single file, and mounting `/root` would
 * hide PATH binaries — so we point CLAUDE_CONFIG_DIR at the auth door. Measured
 * 2026-07-25 in bumper/ai-room: with CLAUDE_CONFIG_DIR=/root/.claude, doctor
 * writes `/root/.claude/.claude.json` (host-persisted) and leaves no
 * `/root/.claude.json` outside the door.
 */
export function roomAuthEnv(agentId: AgentId): Record<string, string> {
  if (agentId === "claude") {
    return { CLAUDE_CONFIG_DIR: "/root/.claude" };
  }
  if (agentId === "cursor") {
    // Must match the /root/.cursor-xdg door. cursor-agent resolves
    // $XDG_CONFIG_HOME/cursor/auth.json and chmods that dir, which only works
    // when the dir lives *inside* a mount rather than being the mount root.
    return { XDG_CONFIG_HOME: "/root/.cursor-xdg" };
  }
  return {};
}

/** Host roots for every auth door of an agent × profile (may not exist yet). */
export function hostAuthRoots(agentId: AgentId, profileId?: string | null): string[] {
  return (ROOM_AUTH_PATHS[agentId] ?? []).map((roomPath) => hostAuthDir(agentId, roomPath, profileId));
}

/**
 * Wipe persisted login data for an agent × profile. Does not touch Project × Tool
 * history/resume state under project-agent-state/.
 */
export function resetRoomAuth(agentId: AgentId, profileId?: string | null): { cleared: string[] } {
  const profile = normalizeAuthProfileId(profileId);
  const cleared: string[] = [];
  for (const host of hostAuthRoots(agentId, profile)) {
    if (!existsSync(host)) continue;
    rmSync(host, { recursive: true, force: true });
    cleared.push(host);
  }
  clearProfileVerifiedAt(agentId, profile);
  return { cleared };
}

function verifyStorePath(): string {
  return join(stateDir(), "auth-profile-verify.json");
}

interface VerifyStore {
  /** agentId\0profileId → ISO timestamp of last successful verify. */
  verifiedAt: Record<string, string>;
}

function readVerifyStore(): VerifyStore {
  try {
    const raw = JSON.parse(readFileSync(verifyStorePath(), "utf8")) as VerifyStore;
    return { verifiedAt: raw.verifiedAt && typeof raw.verifiedAt === "object" ? raw.verifiedAt : {} };
  } catch {
    return { verifiedAt: {} };
  }
}

function writeVerifyStore(store: VerifyStore): void {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(verifyStorePath(), JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
}

function verifyKey(agentId: AgentId, profileId: string): string {
  return `${agentId}\0${normalizeAuthProfileId(profileId)}`;
}

export function getProfileVerifiedAt(agentId: AgentId, profileId?: string | null): string | undefined {
  return readVerifyStore().verifiedAt[verifyKey(agentId, normalizeAuthProfileId(profileId))];
}

export function markProfileVerified(agentId: AgentId, profileId?: string | null, at = new Date().toISOString()): string {
  const store = readVerifyStore();
  const key = verifyKey(agentId, normalizeAuthProfileId(profileId));
  store.verifiedAt[key] = at;
  writeVerifyStore(store);
  return at;
}

export function clearProfileVerifiedAt(agentId: AgentId, profileId?: string | null): void {
  const store = readVerifyStore();
  delete store.verifiedAt[verifyKey(agentId, normalizeAuthProfileId(profileId))];
  writeVerifyStore(store);
}

/**
 * Derive UI status. Auth is never a hard launch gate for `bumper <cli>`.
 * - verified: credential present and last verify succeeded
 * - needs-signin: no credential file
 * - unknown: credential exists but never verified in this app
 * - checking: reserved for in-flight UI (callers may pass temporarily)
 *
 * Uses `roomAuthCredentialPresent`: presence must mean a credential *file*, not just
 * bytes in the tree. `roomAuthDoors` mkdirs the tree itself, so an "any entry counts"
 * heuristic made a tool that merely launched once claim "Existing login" on Project →
 * AI tools and the Overview ledger. That loose helper has been deleted.
 */
export function profileAuthStatus(
  agentId: AgentId,
  profileId?: string | null,
  options: { checking?: boolean } = {},
): { status: ProfileAuthStatus; verifiedAt?: string; persisted: boolean } {
  if (options.checking) {
    return { status: "checking", persisted: roomAuthCredentialPresent(agentId, profileId) };
  }
  const persisted = roomAuthCredentialPresent(agentId, profileId);
  if (!persisted) return { status: "needs-signin", persisted: false };
  const verifiedAt = getProfileVerifiedAt(agentId, profileId);
  if (verifiedAt) return { status: "verified", verifiedAt, persisted: true };
  return { status: "unknown", persisted: true };
}

/**
 * Re-check host auth dirs and update verify stamp when login looks present.
 * Never reads token contents — only presence of files.
 */
export function verifyProfileAuth(
  agentId: AgentId,
  profileId?: string | null,
): { status: ProfileAuthStatus; verifiedAt?: string; persisted: boolean } {
  // Strict, same reason as profileAuthStatus — never stamp "verified" for a tree
  // that only holds directories Bumper created itself.
  const persisted = roomAuthCredentialPresent(agentId, profileId);
  if (!persisted) {
    clearProfileVerifiedAt(agentId, profileId);
    return { status: "needs-signin", persisted: false };
  }
  const verifiedAt = markProfileVerified(agentId, profileId);
  return { status: "verified", verifiedAt, persisted: true };
}

/**
 * Project × Tool history/resume state — separate from credential storage under room-auth/.
 * Seatbelt runtime and future Room resume doors use this tree.
 */
export function projectAgentStatePath(project: string, agentId: string): string {
  const safeProject = String(project || "_").replace(/[^a-zA-Z0-9._-]+/g, "_") || "_";
  const safeAgent = String(agentId || "agent").replace(/[^a-zA-Z0-9._-]+/g, "_") || "agent";
  return join(stateDir(), "project-agent-state", safeProject, safeAgent);
}

/**
 * In-room paths that hold conversation history / memories / project transcripts
 * (not credentials). Mounted as Project-scoped overlays on top of the account
 * auth door so credential stays account-level while history is isolated (9-4).
 *
 * Only paths measured or documented in room-auth-vendor-paths.md. Nested bind
 * mounts on Apple container hide the parent auth door's same subpath.
 */
const ROOM_HISTORY_SUBPATHS: Partial<Record<AgentId, string[]>> = {
  // Measured: projects/ holds workspace conversation buckets.
  claude: ["/root/.claude/projects"],
  // Measured: projects/ under ~/.cursor (darwin path; also used on Linux by agent).
  cursor: ["/root/.cursor/projects"],
  // Codex keeps sessions/logs/memories under the same home tree as auth.json.
  codex: ["/root/.codex/sessions", "/root/.codex/memories", "/root/.codex/logs"],
  // Grok sessions sqlite / logs (size sheet §6).
  grok: ["/root/.grok/sessions", "/root/.grok/logs"],
  // Measured: conversations under antigravity-cli tree.
  antigravity: ["/root/.gemini/antigravity-cli/conversations"],
};

/**
 * Project-scoped history overlays for an agent. Empty when project is missing.
 * Host dirs are created on demand under project-agent-state/.
 */
export function roomHistoryDoors(agentId: AgentId, projectName?: string | null): Door[] {
  const project = String(projectName ?? "").trim();
  if (!project) return [];
  const paths = ROOM_HISTORY_SUBPATHS[agentId] ?? [];
  const base = hostProjectAgentStateDir(project, agentId);
  return paths.map((roomPath) => {
    const leaf = sanitizeRoomPathLeaf(roomPath);
    const host = join(base, "history", leaf);
    mkdirSync(host, { recursive: true });
    return { hostPath: host, roomPath, access: "read-write" as const };
  });
}

export function roomHistoryPaths(agentId: AgentId): string[] {
  return ROOM_HISTORY_SUBPATHS[agentId] ?? [];
}

export function hostProjectAgentStateDir(project: string, agentId: string): string {
  const root = projectAgentStatePath(project, agentId);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Public Library / Privacy row: one tool × identity login instance. */
export interface AiLoginPublic {
  /** Stable UI key: `${agentId}:${identityId}`. */
  key: string;
  agentId: AgentId;
  agentName: string;
  shortName: string;
  identityId: string;
  /** Display label — tool name when identity is default, else identity id. */
  identityLabel: string;
  status: ProfileAuthStatus;
  verifiedAt?: string;
  persisted: boolean;
  /** Approximate on-disk size of auth doors for this tool×identity (bytes). */
  storageBytes: number;
  /** Project names that bind this account (derived from loginProfiles). */
  usedByProjects: string[];
}

/** Recursive byte size of a directory tree (best-effort). */
export function directoryByteSize(root: string): number {
  if (!existsSync(root)) return 0;
  let total = 0;
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else total += st.size;
      } catch { /* skip */ }
    }
  };
  try {
    const st = statSync(root);
    if (st.isFile()) return st.size;
  } catch {
    return 0;
  }
  walk(root);
  return total;
}

/**
 * Filenames that only appear once a vendor CLI has actually stored a login, per
 * auth door. Presence of *any* file is too loose for the Library list: several
 * CLIs write settings/telemetry caches into the same tree on first run, which
 * would surface a "login" the user never created.
 *
 * This is filename-level knowledge only — we never open or parse these files
 * (see the account-name rule in the connection-model decision). Doors with no
 * entry here fall back to any file at any depth (not directory presence alone).
 */
const ROOM_AUTH_CREDENTIAL_MARKERS: Partial<Record<AgentId, Record<string, string[]>>> = {
  // Measured 2026-07-25 — filename-level only; never open these files.
  claude: { "/root/.claude": [".credentials.json"] },
  codex: { "/root/.codex": ["auth.json"] },
  grok: { "/root/.grok": ["auth.json"] },
  // Linux login lands at $XDG_CONFIG_HOME/cursor/auth.json — inside the
  // /root/.cursor-xdg door. /root/.cursor holds darwin-path settings only.
  cursor: {
    "/root/.cursor": [],
    "/root/.cursor-xdg": ["cursor/auth.json"],
  },
  // antigravity: door is /root/.gemini (measured). OAuth token filename 未検証
  // — omit entry so doorHasCredentialMarker falls back to "any file in tree".
};

/**
 * True when `root` contains at least one regular file (any depth).
 * Empty dirs and dir-only trees (roomAuthDoors mkdirSync, vendor empty leaves)
 * do NOT count — those produced phantom aiLogins with storageBytes: 0 (Phase 9-6 F3).
 */
function hostTreeHasFile(root: string): boolean {
  try {
    if (!existsSync(root)) return false;
    const st = statSync(root);
    if (st.isFile()) return true;
    if (!st.isDirectory()) return false;
    for (const name of readdirSync(root)) {
      if (hostTreeHasFile(join(root, name))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function doorHasCredentialMarker(agentId: AgentId, roomPath: string, profileId: string): boolean {
  const markers = ROOM_AUTH_CREDENTIAL_MARKERS[agentId]?.[roomPath];
  const host = hostAuthDir(agentId, roomPath, profileId);
  try {
    if (!existsSync(host)) return false;
    if (markers === undefined) {
      // Unknown vendor layout — any real file counts; empty/dir-only trees do not.
      return hostTreeHasFile(host);
    }
    if (markers.length === 0) return false; // door known to hold settings only
    return markers.some((name) => existsSync(join(host, name)));
  } catch {
    return false;
  }
}

/**
 * Whether this agent × identity looks like a login the user actually created.
 * Doors are always mounted regardless, so launch does not consult this — it exists
 * for what a user reads (Project → AI tools, Overview, Settings → Privacy).
 */
export function roomAuthCredentialPresent(agentId: AgentId, profileId?: string | null): boolean {
  const profile = normalizeAuthProfileId(profileId);
  return (ROOM_AUTH_PATHS[agentId] ?? []).some((roomPath) =>
    doorHasCredentialMarker(agentId, roomPath, profile),
  );
}

/** Agent ids that still hold on-disk auth state for this identity. */
export function agentsWithIdentityOnDisk(profileId: string, agentIds: AgentId[]): AgentId[] {
  const profile = normalizeAuthProfileId(profileId);
  return agentIds.filter((agentId) =>
    hostAuthRoots(agentId, profile).some((host) => hostTreeHasFile(host)),
  );
}

export function agentIdentityIdsOnDisk(agentId: AgentId): string[] {
  const ids = new Set<string>([DEFAULT_AUTH_PROFILE]);
  // Named profiles under room-auth/<agent>/profiles/<id>/
  const profilesRoot = join(stateDir(), "room-auth", agentId, "profiles");
  try {
    if (existsSync(profilesRoot)) {
      for (const name of readdirSync(profilesRoot)) {
        if (name.startsWith(".")) continue;
        try {
          ids.add(normalizeAuthProfileId(name));
        } catch { /* skip invalid segment names */ }
      }
    }
  } catch { /* ignore */ }
  return [...ids];
}

/**
 * Library AI list: only real tool×identity instances (persisted on disk and/or
 * bound by a Project). Never expands the full agent catalog under each profile.
 */
export function listAiLogins(
  config: {
    authProfiles?: string[];
    contexts?: Record<string, { loginProfiles?: Record<string, string> }>;
  },
  agents: Array<{ id: string; name: string; shortName?: string; roomCommand?: string[] | null }>,
): AiLoginPublic[] {
  const roomAgents = agents.filter((a) => Array.isArray(a.roomCommand) && a.roomCommand.length > 0);
  const catalogIds = new Set<string>([DEFAULT_AUTH_PROFILE]);
  for (const raw of config.authProfiles ?? []) {
    try {
      catalogIds.add(normalizeAuthProfileId(raw));
    } catch { /* skip */ }
  }

  // Project binds: agentId → identity ids
  const referenced = new Map<string, Set<string>>();
  for (const ctx of Object.values(config.contexts ?? {})) {
    for (const [agentId, profileRaw] of Object.entries(ctx.loginProfiles ?? {})) {
      try {
        const pid = normalizeAuthProfileId(profileRaw);
        if (!referenced.has(agentId)) referenced.set(agentId, new Set());
        referenced.get(agentId)!.add(pid);
        catalogIds.add(pid);
      } catch { /* skip */ }
    }
  }

  const rows: AiLoginPublic[] = [];
  for (const agent of roomAgents) {
    const agentId = agent.id as AgentId;
    const identityIds = new Set<string>([
      ...catalogIds,
      ...agentIdentityIdsOnDisk(agentId),
      ...(referenced.get(agentId) ?? []),
    ]);
    for (const identityId of identityIds) {
      const bound = referenced.get(agentId)?.has(identityId) === true;
      // Real instance only — no empty catalog expansion, and no row for a tree
      // that holds settings/telemetry but no login the user created.
      if (!roomAuthCredentialPresent(agentId, identityId) && !bound) continue;
      const auth = profileAuthStatus(agentId, identityId);
      const identityLabel = identityId === DEFAULT_AUTH_PROFILE
        ? (agent.shortName || agent.name || agentId)
        : identityId;
      const storageBytes = hostAuthRoots(agentId, identityId).reduce(
        (sum, host) => sum + directoryByteSize(host),
        0,
      );
      const usedByProjects: string[] = [];
      for (const [name, ctx] of Object.entries(config.contexts ?? {})) {
        const raw = ctx?.loginProfiles?.[agentId];
        if (!raw) continue;
        try {
          if (normalizeAuthProfileId(raw) === identityId) usedByProjects.push(name);
        } catch { /* skip */ }
      }
      usedByProjects.sort((a, b) => a.localeCompare(b));
      rows.push({
        key: `${agentId}:${identityId}`,
        agentId,
        agentName: agent.name || agentId,
        shortName: agent.shortName || agent.name || agentId,
        identityId,
        identityLabel,
        status: auth.status,
        verifiedAt: auth.verifiedAt,
        persisted: auth.persisted,
        storageBytes,
        usedByProjects,
      });
    }
  }
  return rows.sort((a, b) => {
    const byAgent = a.agentName.localeCompare(b.agentName);
    if (byAgent !== 0) return byAgent;
    if (a.identityId === DEFAULT_AUTH_PROFILE) return -1;
    if (b.identityId === DEFAULT_AUTH_PROFILE) return 1;
    return a.identityId.localeCompare(b.identityId);
  });
}
