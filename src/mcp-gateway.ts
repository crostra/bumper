/**
 * The single decision point for every MCP tool call Bumper brokers.
 *
 * Both consumers — the external stdio bridge (`bumper mcp connect`) and the
 * Room Connector door — compose through this class. The first revision of the
 * Room broker split the exposed name and called `conn.callTool` directly, so a
 * read-only Project silently exposed write tools inside the Room while the same
 * tools were blocked on the proxy path. One gateway means one deny-by-default
 * index, one blocked reason, and one Events line for both.
 *
 * Enforcement is host-side on purpose: the Room's copy of the bridge is
 * untrusted (the AI can rewrite it — it is on a read-write door), and rewriting
 * it gains nothing, because every request is re-decided here.
 */
import type { Config, Context, ToolDecision } from "./types.js";
import { BackendManager, type BackendTool } from "./backends.js";
import { decideTool, parseExposedName } from "./policy.js";
import { logEvent, type EventSource } from "./log.js";
import { mergeProjectBackends } from "./mcp-hub.js";

export interface GatewayEntry {
  decision: ToolDecision;
  tool: BackendTool;
}

/** Tool as an MCP client sees it (allowed tools only). */
export interface ExposedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface GatewayOrigin {
  /** Events attribution: which path asked. */
  source: EventSource;
  /** Room Session correlation id, when the caller is a Sandbox. */
  sessionId?: string;
}

export type GatewayCallResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export class McpGateway {
  private readonly allowedIndex = new Map<string, GatewayEntry>();

  private constructor(
    readonly projectName: string,
    private readonly context: Context,
    private readonly manager: BackendManager,
    /** Every tool the bound Connections offer, with its decision. */
    readonly entries: GatewayEntry[],
    readonly connected: string[],
    readonly failed: Record<string, string>,
    private readonly origin: GatewayOrigin,
  ) {
    for (const entry of entries) {
      if (entry.decision.allowed) this.allowedIndex.set(entry.decision.exposedName, entry);
    }
  }

  /**
   * Connect this Project's bound Connections and decide their tools.
   *
   * Connection secrets are read here, in the host process, and handed to the
   * backend as spawn env. They never reach the caller of this gateway.
   */
  static async open(
    config: Config,
    projectName: string,
    context: Context,
    origin: GatewayOrigin,
  ): Promise<McpGateway> {
    const merged = mergeProjectBackends(config, projectName, context);
    const manager = new BackendManager(merged.config.backends);
    const { connected, failed } = await manager.connectMany(merged.context.backends);

    const entries: GatewayEntry[] = [];
    for (const backendName of connected) {
      const conn = manager.get(backendName)!;
      let tools: BackendTool[];
      try {
        tools = await conn.listTools();
      } catch (err) {
        failed[backendName] = `listTools failed: ${(err as Error).message}`;
        continue;
      }
      for (const tool of tools) {
        entries.push({
          decision: decideTool(merged.context, backendName, tool.name, tool.readOnlyHint),
          tool,
        });
      }
    }
    return new McpGateway(
      projectName, merged.context, manager, entries, connected, failed, origin,
    );
  }

  /** Only the allowed tools are ever named to a client. */
  allowedTools(): ExposedTool[] {
    return [...this.allowedIndex.values()].map(({ decision, tool }) => ({
      name: decision.exposedName,
      description: decorateDescription(tool.description, decision, this.projectName),
      inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
    }));
  }

  /** Decision for one exposed name, whether allowed or not (preview / tests). */
  decisionFor(exposed: string): ToolDecision | undefined {
    return this.entries.find((entry) => entry.decision.exposedName === exposed)?.decision;
  }

  get hasBackends(): boolean {
    return this.connected.length > 0 || Object.keys(this.failed).length > 0;
  }

  /**
   * Call one exposed tool. Deny-by-default: a name that is not in the allowed
   * index is refused even if the client guessed it correctly.
   */
  async call(exposed: string, args: Record<string, unknown> | undefined): Promise<GatewayCallResult> {
    const entry = this.allowedIndex.get(exposed);
    if (!entry) {
      const reason = this.blockedReason(exposed);
      this.log("blocked", exposed, reason);
      return { ok: false, error: `"${exposed}" is blocked — ${reason}.` };
    }
    const conn = this.manager.get(entry.decision.backend);
    if (!conn) {
      const reason = `connection "${entry.decision.backend}" is not connected`;
      this.log("failed", exposed, reason);
      return { ok: false, error: reason };
    }
    try {
      const result = await conn.callTool(entry.decision.toolName, args);
      this.log("allowed", exposed, entry.decision.reason, entry.decision.access);
      return { ok: true, result };
    } catch (err) {
      const reason = `connection error: ${(err as Error).message}`;
      this.log("failed", exposed, reason);
      return { ok: false, error: reason };
    }
  }

  async close(): Promise<void> {
    await this.manager.closeAll();
  }

  private blockedReason(exposed: string): string {
    const parsed = parseExposedName(exposed);
    if (!parsed) return `tool name must be connection__tool`;
    const known = this.decisionFor(exposed);
    if (known) return known.reason;
    if (!this.context.backends.includes(parsed.backend)) {
      return `connection "${parsed.backend}" is not bound to project "${this.projectName}"`;
    }
    return `no such tool on connection "${parsed.backend}"`;
  }

  private log(
    decision: "allowed" | "blocked" | "failed",
    target: string,
    reason: string,
    access?: "read" | "write",
  ): void {
    logEvent({
      context: this.projectName,
      surface: "mcp",
      type: "mcp",
      source: this.origin.source,
      sessionId: this.origin.sessionId,
      decision,
      access,
      target,
      reason,
      fixTab: "connections",
      fixLabel: "Open Connections",
    });
  }
}

/** The tag tells the model what Bumper decided, so it stops retrying blindly. */
export function decorateDescription(
  desc: string | undefined,
  decision: ToolDecision,
  projectName: string,
): string {
  const tag = `[bumper: project "${projectName}", ${decision.access}]`;
  return desc ? `${desc}\n\n${tag}` : tag;
}
