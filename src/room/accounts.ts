/**
 * Phase 9-3 account model (CLI-owned).
 *
 * Unit: (Project, tool) → one account id stored in Context.loginProfiles[tool].
 * Account inventory is derived from on-disk room-auth + every Project's
 * loginProfiles — no separate store. Naming is automatic (first Project slug).
 *
 * Login storage is a host-side Door, not a Sandbox credential mount.
 */
import type { AgentId } from "../agents.js";
import type { Config } from "../types.js";
import {
  DEFAULT_AUTH_PROFILE,
  agentIdentityIdsOnDisk,
  normalizeAuthProfileId,
  roomAuthCredentialPresent,
} from "./auth.js";

export interface AccountChoice {
  id: string;
  /** User-visible label — "Existing login" for default, else the id. */
  label: string;
  signedIn: boolean;
  projectCount: number;
  /** Project names that bind this account for the tool. */
  projectNames: string[];
}

/** Display name for default profile — path is never renamed (R4). */
export function accountDisplayLabel(accountId: string): string {
  const id = normalizeAuthProfileId(accountId);
  if (id === DEFAULT_AUTH_PROFILE) return "Existing login";
  return id;
}

/**
 * Slug a Project name into a safe account id segment.
 * Collision handling is done by allocateAccountId.
 */
export function slugAccountId(projectName: string): string {
  const raw = String(projectName || "project")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const slug = raw || "project";
  // Avoid colliding with the reserved default profile id.
  if (slug === DEFAULT_AUTH_PROFILE) return "project";
  return slug.slice(0, 48);
}

/** Projects that bind this agent → account id (from loginProfiles only). */
export function projectsUsingAccount(
  config: Pick<Config, "contexts">,
  agentId: AgentId,
  accountId: string,
): string[] {
  const target = normalizeAuthProfileId(accountId);
  const names: string[] = [];
  for (const [name, ctx] of Object.entries(config.contexts ?? {})) {
    const raw = ctx?.loginProfiles?.[agentId];
    if (!raw) continue;
    try {
      if (normalizeAuthProfileId(raw) === target) names.push(name);
    } catch { /* skip invalid */ }
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/**
 * All known accounts for one tool: disk credentials and/or Project binds.
 * default is included when it has credential or any bind.
 */
export function listAccountsForAgent(
  config: Pick<Config, "contexts" | "authProfiles">,
  agentId: AgentId,
): AccountChoice[] {
  const ids = new Set<string>();
  for (const id of agentIdentityIdsOnDisk(agentId)) {
    try {
      ids.add(normalizeAuthProfileId(id));
    } catch { /* skip */ }
  }
  for (const raw of config.authProfiles ?? []) {
    try {
      ids.add(normalizeAuthProfileId(raw));
    } catch { /* skip */ }
  }
  for (const ctx of Object.values(config.contexts ?? {})) {
    const raw = ctx?.loginProfiles?.[agentId];
    if (!raw) continue;
    try {
      ids.add(normalizeAuthProfileId(raw));
    } catch { /* skip */ }
  }

  const rows: AccountChoice[] = [];
  for (const id of ids) {
    const signedIn = roomAuthCredentialPresent(agentId, id);
    const projectNames = projectsUsingAccount(config, agentId, id);
    // Skip empty default with no binds and no credential — not a real account.
    if (id === DEFAULT_AUTH_PROFILE && !signedIn && projectNames.length === 0) continue;
    // Skip named profiles with neither credential nor binds (stale empty dirs).
    if (id !== DEFAULT_AUTH_PROFILE && !signedIn && projectNames.length === 0) {
      // Keep if directory exists with any content via agentIdentityIdsOnDisk —
      // already in set from disk; if only empty, roomAuthCredentialPresent false
      // and no bind → skip to avoid noise.
      continue;
    }
    rows.push({
      id,
      label: accountDisplayLabel(id),
      signedIn,
      projectCount: projectNames.length,
      projectNames,
    });
  }

  return rows.sort((a, b) => {
    if (a.id === DEFAULT_AUTH_PROFILE) return -1;
    if (b.id === DEFAULT_AUTH_PROFILE) return 1;
    return a.id.localeCompare(b.id);
  });
}

/** Pick a free account id from the Project name (slug + optional -2, -3…). */
export function allocateAccountId(
  config: Pick<Config, "contexts" | "authProfiles">,
  agentId: AgentId,
  projectName: string,
): string {
  const base = slugAccountId(projectName);
  const taken = new Set(listAccountsForAgent(config, agentId).map((a) => a.id));
  // Also reserve any profile dir name even if not yet a "login"
  for (const id of agentIdentityIdsOnDisk(agentId)) taken.add(id);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Bind Project.loginProfiles[agent] = accountId (mutates config in place). */
export function bindProjectAccount(
  config: Config,
  projectName: string,
  agentId: AgentId,
  accountId: string,
): void {
  const ctx = config.contexts[projectName];
  if (!ctx) throw new Error(`Unknown project "${projectName}"`);
  const id = normalizeAuthProfileId(accountId);
  if (!ctx.loginProfiles) ctx.loginProfiles = {};
  ctx.loginProfiles[agentId] = id;
  // Keep authProfiles catalog in sync for Library/Settings lists.
  if (!config.authProfiles) config.authProfiles = [DEFAULT_AUTH_PROFILE];
  if (!config.authProfiles.includes(id) && id !== DEFAULT_AUTH_PROFILE) {
    config.authProfiles = [...config.authProfiles, id];
  }
}

export function projectBoundAccountId(
  config: Pick<Config, "contexts">,
  projectName: string,
  agentId: AgentId,
): string | undefined {
  const raw = config.contexts[projectName]?.loginProfiles?.[agentId];
  if (!raw) return undefined;
  try {
    return normalizeAuthProfileId(raw);
  } catch {
    return undefined;
  }
}

/** One line for the select prompt (ttyProjectAsk shape). */
export function formatAccountChoiceLine(account: AccountChoice): string {
  const status = account.signedIn ? "signed in" : "not signed in";
  const n = account.projectCount;
  const used =
    n === 0 ? "used by 0 Projects" : n === 1 ? "used by 1 Project" : `used by ${n} Projects`;
  return `${account.label}  ${status} · ${used}`;
}

export type AccountPromptResult =
  | { action: "select"; accountId: string }
  | { action: "new" }
  | { action: "cancel" };

/**
 * Pure decision for tests: parse the answer line given account choices.
 * Same shape as ttyProjectAsk select: 1..N, n/new, q/cancel.
 */
export function parseAccountPromptAnswer(
  answer: string,
  accounts: AccountChoice[],
): AccountPromptResult {
  const a = answer.trim().toLowerCase();
  if (a === "" || a === "q") return { action: "cancel" };
  if (a === "n" || a === "new") return { action: "new" };
  const asNum = Number(a);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= accounts.length) {
    return { action: "select", accountId: accounts[asNum - 1]!.id };
  }
  // allow typing the id directly
  const byId = accounts.find((x) => x.id === answer.trim() || x.label.toLowerCase() === a);
  if (byId) return { action: "select", accountId: byId.id };
  return { action: "cancel" };
}
