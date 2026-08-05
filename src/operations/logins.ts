/**
 * Stored AI logins.
 *
 * Signing in happens in the terminal already ([terminal-login-canonical]), but
 * signing *out* only existed in the GUI. That is the wrong asymmetry for
 * credentials: the thing a user most wants to do without hunting for an app is
 * remove a login they no longer want on disk.
 *
 * Removing one really unbinds the Projects that used it. Silently repointing
 * them at another login would hand a Sandbox an identity nobody chose.
 */
import type { Config } from "../types.js";
import { detectAgents, getAgent, type AgentId } from "../agents.js";
import {
  listAiLogins,
  normalizeAuthProfileId,
  resetRoomAuth,
  roomAuthCredentialPresent,
} from "../room/auth.js";
import { OperationError } from "./error.js";

export const DEFAULT_AUTH_PROFILE = "default";

export interface AiLoginView {
  agentId: string;
  agentName: string;
  identityId: string;
  identityLabel: string;
  present: boolean;
  usedBy: string[];
}

export function listStoredLogins(config: Config): AiLoginView[] {
  return listAiLogins(config, detectAgents()).map((login) => ({
    agentId: login.agentId,
    agentName: login.agentName,
    identityId: login.identityId,
    identityLabel: login.identityLabel,
    present: login.persisted && roomAuthCredentialPresent(login.agentId, login.identityId),
    usedBy: Object.entries(config.contexts)
      .filter(([, context]) =>
        normalizeAuthProfileId(String(context.loginProfiles?.[login.agentId] ?? "")) === login.identityId)
      .map(([name]) => name),
  }));
}

export interface RemoveLoginResult {
  agentId: string;
  agentName: string;
  identityId: string;
  cleared: number;
  /** Projects that were bound to it and are now unbound. */
  unbound: string[];
}

/** Mutates config in memory (unbinding Projects); the caller persists. */
export function removeStoredLogin(input: {
  config: Config;
  agentId: string;
  identityId?: string;
}): RemoveLoginResult {
  const agent = getAgent(input.agentId as AgentId);
  if (!agent) {
    throw new OperationError("not-found", `Unknown AI tool "${input.agentId}".`, [
      "bumper login list",
    ]);
  }
  const identityId = normalizeAuthProfileId(input.identityId ?? DEFAULT_AUTH_PROFILE);

  const cleared = resetRoomAuth(agent.id, identityId).cleared.length;

  const unbound: string[] = [];
  for (const [name, context] of Object.entries(input.config.contexts)) {
    const bindings = context.loginProfiles;
    if (!bindings) continue;
    if (normalizeAuthProfileId(String(bindings[agent.id] ?? "")) !== identityId) continue;
    // Real unbind — never repoint the Project at some other login.
    delete bindings[agent.id];
    unbound.push(name);
  }

  return { agentId: agent.id, agentName: agent.name, identityId, cleared, unbound };
}
