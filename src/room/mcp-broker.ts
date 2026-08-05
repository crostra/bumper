/**
 * Room Connector — how a Project's MCP Connections reach the AI inside a Sandbox.
 *
 * Shape (decision 2026-07-26-mcp-hub-reaches-the-room):
 *
 *   host                                  │ room
 *   Connection secrets (0600 handles)     │
 *   MCP server processes (spawned here)   │
 *   McpGateway: decide + log every call   │
 *          ▲ file queue on the door ──────┼──► bumper-mcp-server.mjs (real MCP
 *          │                              │    stdio server the CLI registers)
 *
 * Two properties make this safe to hand an agent whose approvals are off:
 *
 * 1. The channel is a door, not a socket. Nothing about it needs the Sandbox's
 *    network, so MCP works with egress Off — and turning egress Off does not
 *    quietly turn MCP into a hole either, because the servers run out here.
 * 2. The room half is untrusted. It holds no secret and makes no decision; the
 *    host re-decides every request. Rewriting it buys the agent nothing.
 *
 * What it is NOT: a VM-structural control. An MCP Connection is a capability
 * that reaches *past* the Room's walls by construction (that is the point of
 * binding one), so assurance reports it as `broker`, never `vm`.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Context } from "../types.js";
import type { Door, RoomSpec } from "./backend.js";
import type { AgentId } from "../agents.js";
import { McpGateway } from "../mcp-gateway.js";
import { effectiveContext } from "../effective.js";
import { resolveProjectMcpBackends } from "../mcp-hub.js";

export const ROOM_MCP_MOUNT = "/bumper-mcp";
/** Path of the bridge inside the Sandbox. Referenced by every client registration. */
export const ROOM_MCP_SERVER = `${ROOM_MCP_MOUNT}/bumper-mcp-server.mjs`;
/** Claude Code reads a whole config file; keep it on the door, not in the repo. */
export const ROOM_MCP_CLIENT_CONFIG = `${ROOM_MCP_MOUNT}/clients/mcp.json`;
/** MCP server name the AI sees; its tools are `<connection>__<tool>` under it. */
export const ROOM_MCP_SERVER_NAME = "bumper";

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");

export interface McpBrokerRequest {
  op: "list_tools" | "call_tool";
  name?: string;
  arguments?: Record<string, unknown>;
}

/** True when this Project has at least one usable Connection bound. */
export function projectHasMcpBackends(config: Config, projectName: string): boolean {
  try {
    return resolveProjectMcpBackends(config, projectName).backendNames.length > 0;
  } catch {
    return false;
  }
}

// ── Per-CLI registration ──────────────────────────────────────────────────

export type RoomMcpRegistration =
  | { supported: true; args: string[]; detail: string }
  | { supported: false; args: []; detail: string };

/**
 * How each AI CLI is told about the bridge — verified in the recommended Room
 * image (`<cli> --help`, 2026-07-26), not guessed.
 *
 * Only *session-scoped* mechanisms qualify. Cursor, Grok and Antigravity all
 * read MCP config from their vendor home, which in a Sandbox is a per-profile auth
 * door shared by every Project using that profile: writing there would make two
 * concurrent Sessions overwrite each other's tool set, and would leave a config
 * pointing at a door that no longer exists. A wrong tool set is worse than an
 * absent one, so those CLIs say so instead.
 */
export function roomMcpRegistration(agentId: AgentId | string): RoomMcpRegistration {
  if (agentId === "claude") {
    return {
      supported: true,
      /*
       * `=` form, not a separate token: --mcp-config is variadic, so
       * `--mcp-config <path> <user args>` swallows the user's own arguments.
       * Measured in the Sandbox image 2026-07-26.
       */
      args: [`--mcp-config=${ROOM_MCP_CLIENT_CONFIG}`],
      detail: "Claude Code loads the Hub bridge from --mcp-config (this session only).",
    };
  }
  if (agentId === "codex") {
    return {
      supported: true,
      args: [
        "-c", `mcp_servers.${ROOM_MCP_SERVER_NAME}.command=node`,
        "-c", `mcp_servers.${ROOM_MCP_SERVER_NAME}.args=["${ROOM_MCP_SERVER}"]`,
      ],
      detail: "Codex loads the Hub bridge from -c overrides (this session only).",
    };
  }
  return {
    supported: false,
    args: [],
    detail:
      "this CLI has no per-session MCP flag: its MCP config lives in the vendor home, " +
      "which Rooms share per login profile, so Bumper does not write there. " +
      "Use Claude Code or Codex in the Sandbox, or the external bridge (bumper mcp connect).",
  };
}

/**
 * Per-CLI delivery, for the UI. The Connections screen must not imply that
 * binding a Connection gives every tool the tools — it depends on the CLI.
 */
export function roomMcpDeliveryReport(
  agents: Array<{ id: string; name: string }>,
): Array<{ agentId: string; name: string; supported: boolean; detail: string }> {
  return agents.map((agent) => {
    const registration = roomMcpRegistration(agent.id);
    return {
      agentId: agent.id,
      name: agent.name,
      supported: registration.supported,
      detail: registration.detail,
    };
  });
}

/** Attach the Connector door to a launch spec. Both launch paths use this. */
export function withMcpBroker(spec: RoomSpec, door: Door): RoomSpec {
  return {
    ...spec,
    doors: [...spec.doors, door],
    env: { ...spec.env, BUMPER_MCP_DOOR: ROOM_MCP_MOUNT },
  };
}

/** One-line launch banner fact. Honest when the CLI cannot be wired. */
export function describeRoomMcp(opts: {
  connections: number;
  registration: RoomMcpRegistration;
  runtimeMissing?: boolean;
}): string {
  if (opts.connections === 0) return "no Connections bound";
  if (opts.runtimeMissing) {
    return `${opts.connections} Connection(s) bound, but this Sandbox image has no node — the bridge was not attached`;
  }
  if (!opts.registration.supported) {
    return `${opts.connections} Connection(s) bound, but ${opts.registration.detail}`;
  }
  return `${opts.connections} Connection(s) via the host Connector door — secrets stay on this Mac, every call is decided by Project policy`;
}

// ── Broker ────────────────────────────────────────────────────────────────

/**
 * Host-side Connector. Spawns Connection backends in this process, answers the
 * Room's queued requests through McpGateway, and never puts a secret on the door.
 */
export class RoomMcpBroker {
  private timer?: NodeJS.Timeout;
  private readonly queueDir: string;
  private readonly inFlight = new Set<string>();
  private gateway?: McpGateway;
  private ready = false;
  private initError = "";

  constructor(
    private readonly dir: string,
    private readonly config: Config,
    private readonly projectName: string,
    private readonly origin: { sessionId?: string } = {},
  ) {
    this.queueDir = join(dir, "queue");
  }

  /** Lay out the door. Idempotent; safe to call before every launch. */
  setup(): { door: Door } {
    mkdirSync(this.queueDir, { recursive: true });
    mkdirSync(join(this.dir, "clients"), { recursive: true });
    writeFileSync(join(this.dir, "README.txt"), [
      "Bumper Room MCP Connector door.",
      "",
      "bumper-mcp-server.mjs is an MCP stdio server. It carries no credential and",
      "makes no decision: it forwards each request to the host Connector through",
      "queue/, and the host decides it against this Project's policy.",
      "",
      "Editing anything here cannot widen what the AI may call.",
      "",
    ].join("\n"), { mode: 0o644 });
    writeFileSync(
      join(this.dir, "bumper-mcp-server.mjs"),
      readFileSync(join(assetsDir, "room-mcp-server.mjs"), "utf8"),
      { mode: 0o755 },
    );
    writeFileSync(
      join(this.dir, "clients", "mcp.json"),
      `${JSON.stringify(roomMcpClientConfig(), null, 2)}\n`,
      { mode: 0o644 },
    );
    return {
      door: { hostPath: this.dir, roomPath: ROOM_MCP_MOUNT, access: "read-write" },
    };
  }

  async start(intervalMs = 120): Promise<void> {
    if (this.timer) return;
    try {
      const context = this.config.contexts[this.projectName]
        ? effectiveContext(this.config, this.projectName)
        : undefined;
      if (!context) throw new Error(`Unknown project "${this.projectName}".`);
      this.gateway = await McpGateway.open(this.config, this.projectName, context, {
        source: "room",
        sessionId: this.origin.sessionId,
      });
      const failed = Object.entries(this.gateway.failed);
      if (failed.length && this.gateway.connected.length === 0) {
        this.initError = failed.map(([name, why]) => `${name}: ${why}`).join("; ");
      }
      this.ready = true;
    } catch (err) {
      this.initError = (err as Error).message;
      this.ready = true;
    }
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref?.();
  }

  /** Tools the Room may call right now. Overview and tests read this. */
  get exposedToolNames(): string[] {
    return (this.gateway?.allowedTools() ?? []).map((tool) => tool.name);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    void this.gateway?.close();
    this.gateway = undefined;
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  /** Process pending queue requests. Exposed for tests. */
  async drain(): Promise<void> {
    let entries: string[];
    try {
      entries = readdirSync(this.queueDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (!name.endsWith(".req")) continue;
      const stem = name.slice(0, -".req".length);
      if (this.inFlight.has(stem)) continue;
      const resPath = join(this.queueDir, `${stem}.res`);
      if (existsSync(resPath)) continue;
      this.inFlight.add(stem);
      try {
        await this.answer(join(this.queueDir, name), resPath);
      } finally {
        this.inFlight.delete(stem);
      }
    }
  }

  private async answer(reqPath: string, resPath: string): Promise<void> {
    let raw: string;
    try {
      raw = readFileSync(reqPath, "utf8");
    } catch {
      return;
    }
    let req: McpBrokerRequest;
    try {
      req = JSON.parse(raw) as McpBrokerRequest;
    } catch {
      this.publish(resPath, { ok: false, error: "invalid JSON request" });
      return;
    }
    if (!this.ready) {
      this.publish(resPath, { ok: false, error: "Connector is not ready yet" });
      return;
    }
    if (!this.gateway) {
      this.publish(resPath, { ok: false, error: this.initError || "Connector failed to start" });
      return;
    }
    try {
      if (req.op === "list_tools") {
        this.publish(resPath, { ok: true, tools: this.gateway.allowedTools() });
        return;
      }
      if (req.op === "call_tool") {
        const result = await this.gateway.call(String(req.name ?? ""), req.arguments ?? {});
        this.publish(resPath, result.ok
          ? { ok: true, result: result.result }
          : { ok: false, error: result.error });
        return;
      }
      this.publish(resPath, { ok: false, error: `unknown op "${String(req.op)}"` });
    } catch (err) {
      this.publish(resPath, { ok: false, error: (err as Error).message });
    }
  }

  private publish(resPath: string, body: unknown): void {
    const tmp = `${resPath}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
      renameSync(tmp, resPath);
    } catch {
      /* the room-side bridge times out fail-closed */
    }
  }
}

/** The client config written onto the door (Claude Code `--mcp-config` shape). */
export function roomMcpClientConfig(): {
  mcpServers: Record<string, { command: string; args: string[] }>;
} {
  return {
    mcpServers: {
      [ROOM_MCP_SERVER_NAME]: { command: "node", args: [ROOM_MCP_SERVER] },
    },
  };
}

/** Assert helper for proofs: the door must never carry credential material. */
export function mcpBrokerDoorLooksClean(hostPath: string): { ok: boolean; detail: string } {
  if (!existsSync(hostPath)) return { ok: false, detail: "door missing" };
  const listing: string[] = [];
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      listing.push(p);
      if (ent.isDirectory()) walk(p);
    }
  };
  walk(hostPath);
  const blob = listing.join("\n");
  if (/mcp-connection-secrets|tokens\.json|\.ssh|Keychain|osxkeychain/i.test(blob)) {
    return { ok: false, detail: "credential-like path on door" };
  }
  for (const p of listing) {
    try {
      const text = readFileSync(p, "utf8");
      if (/mcp-connection-secrets|BEGIN (OPENSSH |RSA )?PRIVATE KEY/i.test(text)) {
        return { ok: false, detail: `credential material in ${p}` };
      }
    } catch {
      /* binary / dir */
    }
  }
  return { ok: true, detail: "clean" };
}

/**
 * Everything a launch path needs to give a Room its Connections, in one call.
 *
 * `bumper <cli>` and the app's SessionManager must not assemble this by hand:
 * the first revision wired the broker into SessionManager only, and the path
 * users actually run had no MCP at all. The convergence test in
 * test/mcp-room.test.mjs asserts both paths go through here.
 */
export function prepareRoomMcp(opts: {
  dir: string;
  config: Config;
  projectName: string;
  context: Context;
  agentId: AgentId | string;
  sessionId?: string;
  /** False when the Room image has no node (preflight exit 3). */
  runtimeAvailable?: boolean;
}): {
  broker?: RoomMcpBroker;
  door?: Door;
  args: string[];
  connections: number;
  registration: RoomMcpRegistration;
  banner: string;
} {
  const connections = Object.keys(opts.context.mcpBindings ?? {}).length;
  const registration = roomMcpRegistration(opts.agentId);
  const runtimeMissing = opts.runtimeAvailable === false;
  const usable = connections > 0
    && registration.supported
    && !runtimeMissing
    && projectHasMcpBackends(opts.config, opts.projectName);
  const banner = describeRoomMcp({ connections, registration, runtimeMissing });
  if (!usable) return { args: [], connections, registration, banner };

  const broker = new RoomMcpBroker(opts.dir, opts.config, opts.projectName, {
    sessionId: opts.sessionId,
  });
  const { door } = broker.setup();
  return { broker, door, args: registration.args, connections, registration, banner };
}
