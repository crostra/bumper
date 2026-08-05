/**
 * Binding Library MCP Connections to a Project.
 *
 * A Connection holds the server command and its secrets on the Mac; the
 * Project decides which ones its Sandbox may call. `mcpBindings` is
 * Integration id → Connection id, at most one Connection per Integration,
 * which is the rule this module enforces for both entry points.
 *
 * The honesty rule from docs/SECURITY_MODEL.md applies here more than anywhere:
 * a bound MCP server runs *outside* the Sandbox, so the folder and network
 * boundary does not apply to it. Both surfaces have to say so, so the sentence
 * lives here rather than being retyped per surface.
 */
import type { Config } from "../types.js";
import { roomMcpRegistration } from "../room/mcp-broker.js";
import { OperationError } from "./error.js";

/**
 * The limit that is easiest to get wrong when reading the code: only tools the
 * Sandbox can actually register MCP with per session receive the Hub.
 */
export const MCP_OUTSIDE_SANDBOX_NOTE =
  "A bound MCP server runs on your Mac, outside the Sandbox. "
  + "The folder and network boundary does not apply to what that server can do.";

export interface McpConnectionView {
  id: string;
  name: string;
  integrationId: string;
  integrationName: string;
  description: string;
  /** Projects that currently bind it. */
  boundTo: string[];
}

export function listMcpConnections(config: Config): McpConnectionView[] {
  return Object.entries(config.mcpConnections ?? {}).map(([id, connection]) => ({
    id,
    name: connection.name,
    integrationId: connection.integrationId,
    integrationName: config.mcpIntegrations?.[connection.integrationId]?.name ?? connection.integrationId,
    description: connection.description ?? "",
    boundTo: Object.entries(config.contexts)
      .filter(([, context]) => Object.values(context.mcpBindings ?? {}).includes(id))
      .map(([name]) => name),
  }));
}

export interface ProjectMcpView {
  projectName: string;
  bindings: { integrationId: string; connectionId: string; connectionName: string }[];
  /** Which AI CLIs actually receive these tools inside the Sandbox. */
  reachedBy: { agentId: string; supported: boolean; detail: string }[];
  note: string;
}

const SANDBOX_AGENTS = ["claude", "codex", "cursor", "antigravity", "grok"];

export function describeProjectMcp(config: Config, projectName: string): ProjectMcpView {
  const project = config.contexts[projectName];
  if (!project) {
    throw new OperationError("not-found", `Unknown project "${projectName}".`, ["bumper project list"]);
  }
  const bindings = Object.entries(project.mcpBindings ?? {}).map(([integrationId, connectionId]) => ({
    integrationId,
    connectionId,
    connectionName: config.mcpConnections?.[connectionId]?.name ?? connectionId,
  }));
  return {
    projectName,
    bindings,
    reachedBy: SANDBOX_AGENTS.map((agentId) => {
      const registration = roomMcpRegistration(agentId);
      return {
        agentId,
        supported: registration.supported,
        detail: registration.detail,
      };
    }),
    note: MCP_OUTSIDE_SANDBOX_NOTE,
  };
}

export interface BindMcpResult {
  projectName: string;
  integrationId: string;
  connectionId: string;
  connectionName: string;
  /** Set when this replaced a different Connection for the same Integration. */
  replaced?: string;
  note: string;
}

/** Mutates config in memory; the caller persists. */
export function bindProjectMcp(input: {
  config: Config;
  projectName: string;
  connectionId: string;
}): BindMcpResult {
  const project = input.config.contexts[input.projectName];
  if (!project) {
    throw new OperationError("not-found", `Unknown project "${input.projectName}".`, ["bumper project list"]);
  }
  const connectionId = input.connectionId.trim();
  const connection = input.config.mcpConnections?.[connectionId];
  if (!connection) {
    const available = Object.keys(input.config.mcpConnections ?? {}).join(", ") || "(none)";
    throw new OperationError("not-found", `Unknown MCP Connection "${connectionId}". Available: ${available}.`, [
      "bumper mcp list           # Connections in the Library",
      "Add one in the Bumper app → Library → MCP (it holds the server's secrets).",
    ]);
  }

  const bindings = { ...(project.mcpBindings ?? {}) };
  const replaced = bindings[connection.integrationId];
  bindings[connection.integrationId] = connectionId;
  project.mcpBindings = bindings;

  return {
    projectName: input.projectName,
    integrationId: connection.integrationId,
    connectionId,
    connectionName: connection.name,
    replaced: replaced && replaced !== connectionId ? replaced : undefined,
    note: MCP_OUTSIDE_SANDBOX_NOTE,
  };
}

export function unbindProjectMcp(input: {
  config: Config;
  projectName: string;
  connectionId: string;
}): { projectName: string; connectionId: string; integrationId: string } {
  const project = input.config.contexts[input.projectName];
  if (!project) {
    throw new OperationError("not-found", `Unknown project "${input.projectName}".`, ["bumper project list"]);
  }
  const bindings = { ...(project.mcpBindings ?? {}) };
  const integrationId = Object.keys(bindings).find((key) => bindings[key] === input.connectionId.trim());
  if (!integrationId) {
    throw new OperationError("not-found", `This Project does not bind "${input.connectionId}".`, [
      `bumper mcp show -p "${input.projectName}"`,
    ]);
  }
  delete bindings[integrationId];
  project.mcpBindings = bindings;
  return { projectName: input.projectName, connectionId: input.connectionId.trim(), integrationId };
}
