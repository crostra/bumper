/**
 * Project → AI tools / Overview ledger: which tool×account facts to show.
 *
 * Terminal-login-canonical §4: fact rows only for **in-use instances**, never the
 * full agent catalog ("Claude · not set yet" × 5). Shared pure helper so tests
 * can assert exact row counts (Phase 9-6 F1/A8) and UI keeps the same rules.
 */
export type AiFactAgent = {
  id: string;
  name?: string;
  shortName?: string;
  roomCommand?: string[] | null;
  /** A credential file exists for the profile this Project would mount. */
  signedIn?: boolean;
};

export type ProjectAiFact = {
  agentId: string;
  shortName: string;
  /** Raw profile id (may be "default") — never print raw to UI without mapping. */
  accountId: string;
  /**
   * Display label for the account. Callers map "default" → locale
   * "Existing login" / project.ai.account_existing. Named ids are returned as-is.
   */
  accountLabelKey: "existing" | "named";
  accountLabel: string;
};

/**
 * In-use AI fact rows for a Project.
 * Include a tool when the Project binds loginProfiles[tool] OR host auth is present
 * for the default shared login (signedIn).
 */
export function projectAiFactRows(
  project: { loginProfiles?: Record<string, string> | null },
  agents: AiFactAgent[],
): ProjectAiFact[] {
  const loginProfiles = project.loginProfiles ?? {};
  const rows: ProjectAiFact[] = [];
  for (const agent of agents) {
    if (!Array.isArray(agent.roomCommand) || agent.roomCommand.length === 0) continue;
    const bound = loginProfiles[agent.id];
    const hasBind = typeof bound === "string" && bound.length > 0;
    const persisted = agent.signedIn === true;
    if (!hasBind && !persisted) continue;
    const accountId = hasBind ? bound : "default";
    const isDefault = accountId === "default";
    rows.push({
      agentId: agent.id,
      shortName: agent.shortName || agent.name || agent.id,
      accountId,
      accountLabelKey: isDefault ? "existing" : "named",
      accountLabel: isDefault ? "Existing login" : accountId,
    });
  }
  return rows;
}
