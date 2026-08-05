/**
 * External stdio bridge — `bumper mcp connect --project <id>`.
 *
 * An AI client running on the host (not in a Room) points at this process and
 * gets exactly the tools the Project allows. It is **MCP-only**: files, shell,
 * network and git on that path are the client's own, and Bumper does not touch
 * them. The Room path is the one with containment; this one is convenience.
 *
 * Enforcement is not implemented here — it is McpGateway, the same class the
 * Room Connector uses, so the two can never drift apart.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config, Context } from "./types.js";
import { McpGateway } from "./mcp-gateway.js";
import { getActiveContext } from "./state.js";
import { effectiveContext } from "./effective.js";

export function resolveActiveContext(config: Config): { name: string; context: Context } {
  const name = getActiveContext(config.defaultContext);
  if (!name) {
    throw new Error(
      `No active context and no defaultContext set. Run \`bumper use <context>\`.`,
    );
  }
  if (!config.contexts[name]) {
    throw new Error(`Active context "${name}" is not defined in config.`);
  }
  return { name, context: effectiveContext(config, name) };
}

export interface StartProxyOptions {
  /** Explicit Project id (for `bumper mcp connect --project`). */
  projectName?: string;
}

/** Start the enforcing bridge as a stdio MCP server for an AI client. */
export async function startProxy(config: Config, options: StartProxyOptions = {}): Promise<void> {
  let name: string;
  let context: Context;
  if (options.projectName) {
    name = options.projectName;
    if (!config.contexts[name]) {
      throw new Error(`Unknown project "${name}".`);
    }
    context = effectiveContext(config, name);
  } else {
    ({ name, context } = resolveActiveContext(config));
  }

  const gateway = await McpGateway.open(config, name, context, { source: "external-mcp" });

  const server = new Server(
    { name: "bumper", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: gateway.allowedTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await gateway.call(req.params.name, req.params.arguments);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `bumper: ${result.error}` }],
        isError: true,
      };
    }
    return result.result as { content: unknown[] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const cleanup = async () => {
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
