/**
 * Phase 4 — standardized boundary-denial copy for AI-facing errors and GUI Blocked.
 *
 * Bumper does not steal the CLI conversation UX. When a security boundary refuses
 * an action, these helpers produce a single shape of message:
 *   - Bumper is the security boundary
 *   - what was attempted
 *   - why it was denied
 *   - which Project setting to change
 *   - settings take effect on new sessions only
 *
 * Used by legacy git credential refuse helpers, egress proxy refuse, and logEvent → Blocked deep links.
 */

/** Project dialog tab ids — keep in sync with assets/app.js openProject tabs. */
export type ProjectSettingsTab = "access" | "room" | "commands" | "connections" | "ai-tools";

export type BoundaryDenialKind = "git-broker" | "egress-proxy";

export interface BoundaryDenial {
  kind: BoundaryDenialKind;
  /** Full multi-line text for AI/process (HTTP body, credential helper stderr). */
  aiMessage: string;
  /** Compact reason for Activity / Blocked log rows. */
  reason: string;
  /** Log target (git host/path or METHOD host). */
  target: string;
  /** Project dialog tab for GUI deep link. */
  fixTab: ProjectSettingsTab;
  /** Button / action label for GUI. */
  fixLabel: string;
}

const NEW_SESSION_NOTE =
  "Takes effect on new sessions only (new bumper <cli> / Launch protected). The current session is unchanged.";

function lines(parts: Array<string | false | undefined | null>): string {
  return parts.filter(Boolean).join("\n");
}

/** Format a consistent AI-facing denial. Errors only — no conversation hijack. */
export function formatBoundaryAiMessage(opts: {
  what: string;
  why: string;
  fix: string;
}): string {
  return lines([
    "bumper: security boundary refusal",
    `What: ${opts.what}`,
    `Why: ${opts.why}`,
    `Fix: ${opts.fix}`,
    NEW_SESSION_NOTE,
  ]);
}

/**
 * HTTPS git credential refused. Repository/scope changes happen in Project → Git;
 * an Events Allow rule can never broaden a provider token.
 */
export function formatGitBrokerDenial(opts: {
  project: string;
  host: string;
  path: string;
}): BoundaryDenial {
  const host = (opts.host || "").trim() || "(unknown host)";
  const path = (opts.path || "").replace(/^\/+/, "").trim();
  const repo = path ? `${host}/${path}` : host;
  const project = opts.project || "(unknown project)";
  const what = `HTTPS git for ${repo}`;
  const why = `Project "${project}" did not issue a GitHub token for this repository and scope`;
  const fix =
    "Choose an installed repository and No access / Read / Read and write in Project → Git";
  return {
    kind: "git-broker",
    aiMessage: formatBoundaryAiMessage({ what, why, fix }),
    reason: why,
    target: `git ${repo}`,
    fixTab: "connections",
    fixLabel: "Open Project → Git",
  };
}

/**
 * Egress proxy refused a host (allowlist miss). Body is the AI-facing error for
 * clients that honor HTTP(S)_PROXY (AI CLIs, git).
 */
export function formatEgressDenial(opts: {
  project?: string;
  host: string;
  method: string;
}): BoundaryDenial {
  const host = (opts.host || "").trim() || "(unknown host)";
  const method = (opts.method || "GET").toUpperCase();
  const project = opts.project?.trim();
  const what = `network ${method} to ${host}`;
  const why = project
    ? `host is not on Project "${project}" Sandbox egress allowlist — Bumper filtering proxy refused`
    : "host is not on this Project's Sandbox egress allowlist — Bumper filtering proxy refused";
  const fix =
    "Project settings → Sandbox → Network egress (add the host, pick a vendor template, or change mode)";
  return {
    kind: "egress-proxy",
    aiMessage: formatBoundaryAiMessage({ what, why, fix }),
    reason: why,
    target: `${method} ${host}`,
    fixTab: "room",
    fixLabel: "Open Project → Sandbox egress",
  };
}

/** Shared honesty string for GUI Blocked / Activity next-action notes. */
export function newSessionEffectNote(): string {
  return NEW_SESSION_NOTE;
}
