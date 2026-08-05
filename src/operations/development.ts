/**
 * Local Preview and Docker, per live Session.
 *
 * These are capabilities the Sandbox borrows from the Mac — a relayed loopback
 * port, and a separate Engine Sandbox that holds only this Project's doors — so
 * turning one off has to reach a Session that is already running, not just the
 * next one. That is the whole point of a Session lease.
 */
import {
  listDevelopmentSessionLeases,
  readDevelopmentSessionLease,
  updateDevelopmentSessionControl,
} from "../development-session-lease.js";
import { logEvent } from "../log.js";
import { OperationError } from "./error.js";

export type DevelopmentCapability = "preview" | "docker";

export interface DevelopmentSessionView {
  id: string;
  projectName: string;
  agentName: string;
  live: boolean;
  previewEnabled: boolean;
  dockerEnabled: boolean;
}

export function listDevelopmentSessions(onlyProject?: string): DevelopmentSessionView[] {
  try {
    return listDevelopmentSessionLeases()
      .filter((lease) => (onlyProject ? lease.projectName === onlyProject : true))
      .map((lease) => ({
        id: lease.id,
        projectName: lease.projectName,
        agentName: lease.agentName,
        live: lease.live,
        previewEnabled: lease.control.previewEnabled,
        dockerEnabled: lease.control.dockerEnabled,
      }));
  } catch {
    return [];
  }
}

export interface SetDevelopmentAccessResult {
  sessionId: string;
  projectName: string;
  capability: DevelopmentCapability;
  enabled: boolean;
}

export function setDevelopmentSessionAccess(input: {
  sessionId: string;
  capability: DevelopmentCapability;
  enabled: boolean;
}): SetDevelopmentAccessResult {
  const sessionId = input.sessionId.trim();
  if (!/^[a-zA-Z0-9-]{8,96}$/.test(sessionId)) {
    throw new OperationError("invalid", "Invalid Development Session id.", ["bumper dev sessions"]);
  }
  if (input.capability !== "preview" && input.capability !== "docker") {
    throw new OperationError("invalid", "Unknown development capability.", [
      "bumper dev preview on|off <session-id>",
      "bumper dev docker on|off <session-id>",
    ]);
  }
  const lease = readDevelopmentSessionLease(sessionId);
  if (!lease?.live) {
    throw new OperationError("conflict", "This Development Session is no longer live.", [
      "bumper dev sessions",
    ]);
  }

  updateDevelopmentSessionControl(
    sessionId,
    input.capability === "preview" ? { previewEnabled: input.enabled } : { dockerEnabled: input.enabled },
  );

  // Same reason as the Git controls: the audit record must not depend on which
  // door the change came through.
  logEvent({
    context: lease.projectName,
    surface: "session",
    source: "app",
    type: "system",
    decision: "allowed",
    target: `${input.capability === "preview" ? "Local Preview" : "Docker"} ${input.enabled ? "enabled" : "disabled"}`,
    reason: `Session control applied to a live Session (${lease.agentName})`,
    sessionId,
  });

  return {
    sessionId,
    projectName: lease.projectName,
    capability: input.capability,
    enabled: input.enabled,
  };
}
