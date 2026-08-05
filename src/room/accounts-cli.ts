/**
 * CLI side of Phase 9-3 account binding (TTY prompt + config write).
 * Pure helpers live in accounts.ts so unit tests need no readline.
 */
import { writeFileSync } from "node:fs";
import type { AgentId } from "../agents.js";
import { getAgent } from "../agents.js";
import type { Config } from "../types.js";
import {
  allocateAccountId,
  bindProjectAccount,
  listAccountsForAgent,
  projectBoundAccountId,
} from "./accounts.js";
import { normalizeAuthProfileId } from "./auth.js";

export type EnsureAccountResult =
  | { ok: true; accountId: string; created: boolean }
  | { ok: false; message: string };

export async function ensureProjectAccountForLaunch(opts: {
  config: Config;
  configPath: string;
  projectName: string;
  agentId: AgentId;
  /** --account <id>: rebind only (or bind when unbound). */
  accountFlag?: string | null;
  interactive: boolean;
  /** Inject prompt for tests. */
  ask?: (accounts: import("./accounts.js").AccountChoice[]) => Promise<
    import("./accounts.js").AccountPromptResult
  >;
}): Promise<EnsureAccountResult> {
  const agent = getAgent(opts.agentId);
  const toolLabel = agent?.shortName || agent?.name || opts.agentId;
  const bound = projectBoundAccountId(opts.config, opts.projectName, opts.agentId);

  // --account: rebind / explicit bind (no name invention by user — they pick known id).
  if (opts.accountFlag?.trim()) {
    let accountId: string;
    try {
      accountId = normalizeAuthProfileId(opts.accountFlag.trim());
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
    bindProjectAccount(opts.config, opts.projectName, opts.agentId, accountId);
    persistConfig(opts.configPath, opts.config);
    return { ok: true, accountId, created: false };
  }

  // Already bound → silent.
  if (bound) {
    return { ok: true, accountId: bound, created: false };
  }

  const accounts = listAccountsForAgent(opts.config, opts.agentId).filter((a) => a.signedIn);
  // Case 1: zero signed-in accounts → create id from Project name, bind, launch.
  if (accounts.length === 0) {
    const accountId = allocateAccountId(opts.config, opts.agentId, opts.projectName);
    bindProjectAccount(opts.config, opts.projectName, opts.agentId, accountId);
    persistConfig(opts.configPath, opts.config);
    return { ok: true, accountId, created: true };
  }

  // Case 2: existing accounts, Project unbound → select prompt.
  if (!opts.interactive && !opts.ask) {
    return {
      ok: false,
      message:
        `This Project has no ${toolLabel} account yet, and stdin is not a TTY.\n` +
        `Run from a terminal to pick an account, or pass --account <id>.\n` +
        `Known: ${accounts.map((a) => a.id).join(", ")}.`,
    };
  }

  const { ttyAccountAsk } = await import("../cli-room.js");
  const result = opts.ask
    ? await opts.ask(accounts)
    : await ttyAccountAsk({ toolLabel, accounts });

  if (result.action === "cancel") {
    return { ok: false, message: "Cancelled." };
  }
  if (result.action === "new") {
    const accountId = allocateAccountId(opts.config, opts.agentId, opts.projectName);
    bindProjectAccount(opts.config, opts.projectName, opts.agentId, accountId);
    persistConfig(opts.configPath, opts.config);
    return { ok: true, accountId, created: true };
  }
  bindProjectAccount(opts.config, opts.projectName, opts.agentId, result.accountId);
  persistConfig(opts.configPath, opts.config);
  return { ok: true, accountId: result.accountId, created: false };
}

function persistConfig(path: string, config: Config): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
