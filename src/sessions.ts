import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Server } from "node:http";
import { createRequire } from "node:module";
import type { IPty } from "node-pty";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./types.js";
import {
  autoApproveEnvFor,
  composeRoomCommand,
  forceCodexDeviceAuthLogin,
  getAgent,
  type AgentDescriptor,
  type AgentId,
} from "./agents.js";
import { buildProfile, gitIgnoredPaths } from "./sandbox.js";
import { effectiveContext } from "./effective.js";
import { resolveConfigPath, stateDir } from "./paths.js";
import { logEvent } from "./log.js";
import { installAgent } from "./install.js";
import type { Door, RoomProcess, RoomSpec } from "./room/backend.js";
import { AppleContainerBackend } from "./room/apple-container.js";
import { prepareRoomMcp, withMcpBroker, type RoomMcpBroker } from "./room/mcp-broker.js";
import { GitHubAppService } from "./github-app.js";
import {
  describeGitAccess, projectGitBroker, withGitBroker, type RoomGitBroker,
} from "./git-broker.js";
import {
  createGitSessionLease,
  GIT_SESSION_HEARTBEAT_MS,
  heartbeatGitSessionLease,
  removeGitSessionLease,
} from "./git-session-lease.js";
import {
  createDevelopmentSessionLease,
  DEVELOPMENT_HEARTBEAT_MS,
  heartbeatDevelopmentSessionLease,
  removeDevelopmentSessionLease,
} from "./development-session-lease.js";
import { PreviewBroker, withPreviewParts } from "./preview-broker.js";
import { DockerBroker } from "./docker-broker.js";
import { EgressProxy } from "./room/egress-proxy.js";
import { startAllowlistEgress } from "./room/egress-network.js";
import { projectGitBindings, projectGitCeiling } from "./git-repositories.js";
import {
  ROOM_MCP_RUNTIME_MISSING_EXIT,
  roomExecutablePreflight,
  roomPreflightFailureDetail,
} from "./room/preflight.js";
import {
  describeFolderDoors,
  profileIdForAgent,
  roomLaunchAuthDoors,
  roomSpecWithExtraDoors,
  roomSpecForAgentLaunch,
} from "./room/launch.js";
import { hostProjectAgentStateDir, normalizeAuthProfileId, roomAuthCredentialPresent } from "./room/auth.js";
import { RECOMMENDED_ROOM_IMAGE } from "./room/setup.js";

export type SessionStatus = "starting" | "running" | "stopped" | "failed" | "interrupted";
export type SessionBackend = "seatbelt" | "room";
export type SessionKind = "agent" | "shell" | "signin";

export interface SessionSummary {
  id: string;
  agentId: AgentId | "room-shell";
  agentName: string;
  context: string;
  workspace: string;
  backend: SessionBackend;
  status: SessionStatus;
  protected: boolean;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  pid?: number;
  error?: string;
  presentation: "terminal" | "window";
  /** agent | shell | signin — drives terminal window Help copy. */
  kind?: SessionKind;
  /** Login profile mounted for this session (signin / agent). */
  profileId?: string;
  /** Dedupe key for Electron utility windows (signin:agent:profile or session:id). */
  windowKey?: string;
}

/**
 * Deferred for the same reason as room/apple-container.ts: `bumper doctor` and
 * the other CLI commands reach this module through cli.ts → app.ts, and a
 * module-scope import made them all require the native build. Only the legacy
 * Seatbelt session path below actually spawns a pty.
 */
type PtyModule = { spawn: typeof import("node-pty").spawn };
let ptyModule: PtyModule | undefined;

function loadPty(): PtyModule {
  if (!ptyModule) {
    ptyModule = createRequire(import.meta.url)("node-pty") as PtyModule;
  }
  return ptyModule;
}

interface PersistedSessions { sessions: SessionSummary[]; }

interface RuntimeSession extends SessionSummary {
  term?: IPty | RoomProcess;
  clients: Set<WebSocket>;
  output: string;
  roomMcpBroker?: RoomMcpBroker;
  roomGitBroker?: RoomGitBroker;
  gitLeaseHeartbeat?: NodeJS.Timeout;
  developmentLeaseHeartbeat?: NodeJS.Timeout;
  previewBroker?: PreviewBroker;
  dockerPreviewBroker?: PreviewBroker;
  dockerBroker?: DockerBroker;
  egressProxy?: EgressProxy;
}

export interface CreateSessionInput {
  agentId: string;
  context: string;
  workspace: string;
}

export interface CreateRoomSessionInput {
  context: string;
  workspace: string;
}

export interface CreateRoomAgentSessionInput extends CreateRoomSessionInput {
  agentId: string;
  /** Override Project.loginProfiles for this launch (Library sign-in). */
  profileId?: string;
}

export interface CreateRoomSigninInput {
  agentId: string;
  /** Optional Project association for Advanced list / image; files are never mounted. */
  context?: string;
  profileId?: string;
}

const MAX_OUTPUT = 1024 * 1024;

function sessionsPath(): string { return join(stateDir(), "sessions.json"); }

function presentation(agent: AgentDescriptor): "terminal" | "window" {
  return agent.id === "antigravity" && agent.command?.[0].includes("Antigravity IDE.app") ? "window" : "terminal";
}

function commandFor(agent: AgentDescriptor, workspace: string): string[] {
  const base = [...(agent.command ?? [])];
  if (presentation(agent) === "window") {
    const electron = "/Applications/Antigravity IDE.app/Contents/MacOS/Electron";
    return [electron, "--new-window", workspace];
  }
  if (agent.id === "codex") return [...base, "--cd", workspace, "--sandbox", "workspace-write", "--ask-for-approval", "on-request"];
  return base;
}

/** Project × Tool runtime/history — not credential storage (room-auth). */
function runtimeStatePaths(agent: AgentDescriptor, project: string): string[] {
  return [hostProjectAgentStateDir(project, agent.id)];
}

function readPersisted(): SessionSummary[] {
  try {
    const data = JSON.parse(readFileSync(sessionsPath(), "utf8")) as PersistedSessions;
    return (data.sessions ?? []).map((session) =>
      session.status === "running" || session.status === "starting"
        ? { ...session, backend: session.backend ?? "seatbelt", status: "interrupted", endedAt: new Date().toISOString(), pid: undefined }
        : { ...session, backend: session.backend ?? "seatbelt" },
    );
  } catch { return []; }
}

export class SessionManager {
  private sessions = new Map<string, RuntimeSession>();
  private wss = new WebSocketServer({ noServer: true });

  constructor(
    private server: Server,
    private reload: () => Config,
    private binPath: string,
  ) {
    for (const saved of readPersisted()) this.sessions.set(saved.id, { ...saved, clients: new Set(), output: "" });
    this.persist();
    server.on("upgrade", (request, socket, head) => {
      const match = new URL(request.url ?? "/", "http://localhost").pathname.match(/^\/ws\/sessions\/([a-zA-Z0-9-]+)$/);
      if (!match) return;
      const origin = request.headers.origin;
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.attach(match[1], ws));
    });
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map(({
        clients: _clients, output: _output, term: _term,
        roomMcpBroker: _roomMcpBroker, roomGitBroker: _roomGitBroker,
        gitLeaseHeartbeat: _gitLeaseHeartbeat,
        developmentLeaseHeartbeat: _developmentLeaseHeartbeat,
        previewBroker: _previewBroker, dockerPreviewBroker: _dockerPreviewBroker,
        dockerBroker: _dockerBroker,
        egressProxy: _egressProxy, ...summary
      }) => summary)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id: string): SessionSummary | undefined { return this.list().find((session) => session.id === id); }

  create(input: CreateSessionInput): SessionSummary {
    const config = this.reload();
    if (!config.contexts[input.context]) throw new Error(`Unknown project: ${input.context}`);
    const context = effectiveContext(config, input.context);
    const agent = getAgent(input.agentId);
    if (!agent) throw new Error(`Unknown AI tool: ${input.agentId}`);
    if (!agent.detected || !agent.command) throw new Error(`${agent.name} is not installed on this Mac.`);
    if (!existsSync(input.workspace)) throw new Error("The selected workspace no longer exists.");
    const workspace = realpathSync(input.workspace);
    const command = commandFor(agent, workspace);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    const runtimePaths = runtimeStatePaths(agent, input.context);
    const summary: RuntimeSession = {
      id, agentId: agent.id, agentName: agent.name, context: input.context, workspace,
      backend: "seatbelt", status: "starting", protected: false, startedAt: new Date().toISOString(),
      presentation: presentation(agent), kind: "agent", windowKey: `session:${id}`,
      clients: new Set(), output: "",
    };
    this.sessions.set(id, summary);
    this.persist();

    try {
      installAgent(agent.id, workspace, this.binPath, input.context);
      const bumperRuntime = [dirname(this.binPath), dirname(process.execPath), join(dirname(this.binPath), "..")];
      const ignored = context.gitIgnored === "visible" ? [] : gitIgnoredPaths(workspace);
      const profile = buildProfile(context, {
        workspace, runtimeReadPaths: [...agent.readPaths, ...bumperRuntime], runtimeWritePaths: runtimePaths,
        deniedReadPaths: context.gitIgnored === "hidden" ? ignored : [],
        deniedWritePaths: context.gitIgnored === "visible" ? [] : ignored,
      });
      const term = loadPty().spawn("/usr/bin/sandbox-exec", ["-p", profile, ...command], {
        name: "xterm-256color", cwd: workspace, cols: 100, rows: 30,
        env: {
          ...process.env,
          BUMPER_CONFIG: resolveConfigPath(), BUMPER_CONTEXT: input.context,
          GIT_TERMINAL_PROMPT: "0", HISTFILE: "/dev/null",
          BUMPER_SESSION_ID: id, TERM_PROGRAM: "Bumper",
        } as Record<string, string>,
      });
      summary.term = term;
      summary.pid = term.pid;
      summary.status = "running";
      summary.protected = true;
      this.append(summary, `\r\n\x1b[38;5;31mBumper\x1b[0m  ${agent.name} is protected\r\n` +
        `Project: ${input.context}  Workspace: ${workspace}\r\n` +
        `${context.mode === "read-only" ? "Workspace is read-only" : "Workspace is readable and writable"}; other home folders are blocked.\r\n\r\n`);
      term.onData((data) => this.append(summary, data));
      term.onExit(({ exitCode }) => {
        summary.status = "stopped";
        summary.protected = false;
        summary.exitCode = exitCode;
        summary.endedAt = new Date().toISOString();
        summary.pid = undefined;
        summary.term = undefined;
        this.broadcast(summary, { type: "status", session: this.publicSummary(summary) });
        this.persist();
        logEvent({ context: input.context, surface: "session", decision: "allowed", target: `${agent.name} stopped`, reason: `exit ${exitCode}` });
      });
      logEvent({ context: input.context, surface: "session", decision: "allowed", target: `${agent.name} launched`, reason: `protected workspace ${workspace}` });
      this.persist();
      return this.publicSummary(summary);
    } catch (error) {
      summary.status = "failed";
      summary.error = (error as Error).message;
      summary.endedAt = new Date().toISOString();
      summary.protected = false;
      this.persist();
      logEvent({ context: input.context, surface: "session", decision: "blocked", target: `${agent.name} launch failed`, reason: summary.error });
      throw error;
    }
  }

  async createRoomShell(input: CreateRoomSessionInput): Promise<SessionSummary> {
    return this.createRoomProcess(input, "room-shell", "Sandbox shell", ["/bin/sh"], "Sandbox shell", { kind: "shell" });
  }

  async createRoomAgent(input: CreateRoomAgentSessionInput): Promise<SessionSummary> {
    const agent = getAgent(input.agentId);
    if (!agent) throw new Error(`Unknown AI tool: ${input.agentId}`);
    if (!agent.roomCommand.length) throw new Error(`${agent.name} does not have a Sandbox command mapping yet.`);
    const config = this.reload();
    const context = config.contexts[input.context] ? effectiveContext(config, input.context) : undefined;
    const profileId = input.profileId != null
      ? normalizeAuthProfileId(input.profileId)
      : profileIdForAgent(context, agent.id);
    const forceDeviceAuthLogin = forceCodexDeviceAuthLogin(
      agent.id,
      roomAuthCredentialPresent(agent.id, profileId),
    );
    const autoApprove = !forceDeviceAuthLogin && context?.autoApprove === true;
    const command = composeRoomCommand({
      agentId: agent.id,
      roomCommand: agent.roomCommand,
      autoApprove,
      forceDeviceAuthLogin,
    });
    return this.createRoomProcess(input, agent.id, `${agent.name} (Room)`, command, agent.name, {
      mountAuth: true, kind: "agent", profileId,
      extraEnv: autoApprove ? autoApproveEnvFor(agent.id) : {},
    });
  }

  findRunningByWindowKey(windowKey: string): SessionSummary | undefined {
    return this.list().find(
      (session) => session.windowKey === windowKey && (session.status === "running" || session.status === "starting"),
    );
  }

  private async createRoomProcess(
    input: CreateRoomSessionInput,
    agentId: AgentId | "room-shell",
    agentName: string,
    command: string[],
    logName: string,
    options: {
      mountAuth?: boolean;
      egressOverride?: "open";
      kind?: SessionKind;
      profileId?: string;
      windowKey?: string;
      /** Env the tool needs to accept its auto-approve flags (see agents.ts). */
      extraEnv?: Record<string, string>;
    } = {},
  ): Promise<SessionSummary> {
    const config = this.reload();
    // GUI sign-in was withdrawn (terminal-login-canonical): there is no signin
    // session kind any more, so every session belongs to a real Project.
    if (!config.contexts[input.context]) throw new Error(`Unknown project: ${input.context}`);
    const context = effectiveContext(config, input.context);
    if (!context.room.enabled) throw new Error("Enable Sandbox backend in this project before opening a room shell.");
    if (!existsSync(input.workspace)) throw new Error("The selected workspace no longer exists.");
    const workspace = existsSync(input.workspace) ? realpathSync(input.workspace) : input.workspace;
    const backend = new AppleContainerBackend();
    const availability = await backend.check();
    if (!availability.usable || !backend.spawn) throw new Error(availability.detail);
    const mountAuth = options.mountAuth === true;
    const profileId = options.profileId != null
      ? normalizeAuthProfileId(options.profileId)
      : profileIdForAgent(context, agentId);
    const launchSpec = roomSpecForAgentLaunch(context, workspace, agentId, {
      mountAuth,
      profileId,
      projectName: input.context,
    });
    const wantsMcp = Object.keys(context.mcpBindings ?? {}).length > 0;
    const preflight = roomExecutablePreflight(command, { requireNode: wantsMcp });
    const preflightResult = await backend.run(launchSpec, preflight.command);
    const mcpRuntimeAvailable = preflightResult.exitCode !== ROOM_MCP_RUNTIME_MISSING_EXIT;
    if (preflightResult.exitCode !== 0 && mcpRuntimeAvailable) {
      const reason = roomPreflightFailureDetail(logName, command, launchSpec.image, preflightResult);
      logEvent({ context: input.context, surface: "session", decision: "blocked", target: `${logName} Sandbox preflight failed`, reason });
      throw new Error(reason);
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    const kind: SessionKind = options.kind ?? (agentId === "room-shell" ? "shell" : "agent");
    const windowKey = options.windowKey ?? `session:${id}`;
    const summary: RuntimeSession = {
      id, agentId, agentName, context: input.context, workspace,
      backend: "room", status: "starting", protected: false, startedAt: new Date().toISOString(),
      presentation: "terminal", kind, profileId: agentId === "room-shell" ? undefined : profileId, windowKey,
      clients: new Set(), output: "",
    };
    this.sessions.set(id, summary);
    this.persist();
    /*
     * MCP Hub via the shared composer (see prepareRoomMcp). `command` carries no
     * user args on this path, so appending the registration flags is the same
     * ordering composeRoomCommand produces for `bumper <cli>`.
     */
    const mcp = prepareRoomMcp({
      dir: join(stateDir(), "room-mcp-broker", id),
      config,
      projectName: input.context,
      context,
      agentId,
      sessionId: id,
      runtimeAvailable: mcpRuntimeAvailable,
    });
    const roomCommand = [...command, ...mcp.args];
    const github = new GitHubAppService();
    const gitBindings = projectGitBindings(context);
    createGitSessionLease({
      id,
      pid: process.pid,
      projectName: input.context,
      agentId,
      agentName,
      // The lease labels the whole Session, which may bind several repositories.
      repository: gitBindings.map((row) => row.fullName).join(", "),
      connectionId: gitBindings[0]?.connectionId ?? "",
      enabled: gitBindings.length > 0,
    });
    summary.gitLeaseHeartbeat = setInterval(
      () => heartbeatGitSessionLease(id),
      GIT_SESSION_HEARTBEAT_MS,
    );
    summary.gitLeaseHeartbeat.unref?.();
    createDevelopmentSessionLease({
      id,
      pid: process.pid,
      projectName: input.context,
      agentId,
      agentName,
      previewEnabled: context.development.preview.enabled,
      dockerEnabled: context.development.docker.enabled,
    });
    summary.developmentLeaseHeartbeat = setInterval(() => {
      heartbeatDevelopmentSessionLease(id);
    }, DEVELOPMENT_HEARTBEAT_MS);
    summary.developmentLeaseHeartbeat.unref?.();
    logEvent({
      context: input.context,
      surface: "session",
      source: "app",
      type: "git",
      decision: "allowed",
      target: "Git Session lease opened",
      reason: `${agentName}; live access can be changed in Project → Git`,
      sessionId: id,
      repository: gitBindings.map((row) => row.fullName).join(", "),
      capability: projectGitCeiling(context),
    });
    const gitBroker = projectGitBroker({
      dir: join(stateDir(), "room-git-broker", id),
      sessionId: id,
      projectName: input.context,
      context,
      installations: Object.entries(config.githubApps ?? {}).flatMap(([connectionId, app]) =>
        app.installations.map((installation) => ({ ...installation, connectionId }))),
      resolveState: () => {
        const current = this.reload();
        return {
          context: current.contexts[input.context] ?? { gitAccess: "none", gitRepository: "", gitWriteUntil: "" },
          installations: Object.entries(current.githubApps ?? {}).flatMap(([connectionId, app]) =>
            app.installations.map((installation) => ({ ...installation, connectionId }))),
        };
      },
      github: {
        issue: (connectionId, installationId, repos, capability, tokenContext) =>
          github.forConnection(connectionId).issue(installationId, repos, capability, tokenContext),
        revoke: (connectionId, token) => github.forConnection(connectionId).revoke(token),
      },
      onEvent: ({ decision, target, reason }) => logEvent({
        context: input.context, surface: "session", source: "room", type: "git", decision, target, reason,
        sessionId: id,
        repository: String(this.reload().contexts[input.context]?.gitRepository ?? ""),
      }),
    });
    let gitParts: ReturnType<RoomGitBroker["setup"]>;
    try {
      gitParts = gitBroker.setup();
    } catch (error) {
      if (summary.gitLeaseHeartbeat) clearInterval(summary.gitLeaseHeartbeat);
      summary.gitLeaseHeartbeat = undefined;
      if (summary.developmentLeaseHeartbeat) clearInterval(summary.developmentLeaseHeartbeat);
      summary.developmentLeaseHeartbeat = undefined;
      removeDevelopmentSessionLease(id);
      removeGitSessionLease(id);
      throw error;
    }
    const authDoors = roomLaunchAuthDoors(agentId, { mountAuth, profileId });
    let egress = options.egressOverride ? { mode: "open" as const } : launchSpec.egress;
    let proxyEnv: Record<string, string> = {};
    if (egress.mode === "allowlist") {
      try {
        const started = await startAllowlistEgress(egress.hosts, ({ host, allowed, method, denial }) => logEvent({
          context: input.context,
          surface: "network",
          decision: allowed ? "allowed" : "blocked",
          target: denial?.target ?? `${method} ${host}`,
          reason: allowed
            ? "host on project egress allowlist"
            : (denial?.reason ?? "host not on project egress allowlist — blocked by proxy"),
          fixTab: denial?.fixTab,
          fixLabel: denial?.fixLabel,
        }), { project: input.context });
        summary.egressProxy = started.proxy;
        proxyEnv = started.env;
        egress = started.egress;
      } catch (error) {
        if (summary.gitLeaseHeartbeat) clearInterval(summary.gitLeaseHeartbeat);
        summary.gitLeaseHeartbeat = undefined;
        if (summary.developmentLeaseHeartbeat) clearInterval(summary.developmentLeaseHeartbeat);
        summary.developmentLeaseHeartbeat = undefined;
        removeDevelopmentSessionLease(id);
        await gitBroker.stop();
        removeGitSessionLease(id);
        throw error;
      }
    }
    // Compose git access through the shared composer so both launch paths stay
    // in step (see withGitBroker).
    const withGit = withGitBroker({ ...launchSpec, egress }, gitParts.door);
    const withMcp = mcp.door ? withMcpBroker(withGit, mcp.door) : withGit;
    const previewBroker = new PreviewBroker(
      join(stateDir(), "room-preview-broker", id),
      id,
      ({ decision, target, reason, roomPort, hostPort }) => logEvent({
        context: input.context,
        surface: "session",
        source: "app",
        type: "network",
        decision,
        target,
        reason: `${reason}${roomPort ? `; Sandbox :${roomPort}` : ""}${hostPort ? `; Mac :${hostPort}` : ""}`,
        sessionId: id,
      }),
    );
    const previewParts = previewBroker.setup(roomCommand);
    const dockerPreviewBroker = new PreviewBroker(
      join(stateDir(), "room-docker-preview-broker", id),
      id,
      ({ decision, target, reason, roomPort, hostPort }) => logEvent({
        context: input.context,
        surface: "session",
        source: "app",
        type: "network",
        decision,
        target: `Docker ${target}`,
        reason: `${reason}${roomPort ? `; Engine :${roomPort}` : ""}${hostPort ? `; Mac :${hostPort}` : ""}`,
        sessionId: id,
      }),
      "docker",
    );
    const dockerPreviewParts = dockerPreviewBroker.setup([]);
    const dockerBroker = new DockerBroker({
      dir: join(stateDir(), "room-docker-broker", id),
      sessionId: id,
      projectName: input.context,
      workspaceDoors: launchSpec.doors.filter((door) =>
        door.roomPath === "/workspace" || door.roomPath.startsWith("/workspace/")),
      egress,
      proxyEnv,
      preview: dockerPreviewParts,
      onEvent: ({ decision, target, reason }) => logEvent({
        context: input.context,
        surface: "session",
        source: "app",
        type: "system",
        decision,
        target,
        reason,
        sessionId: id,
      }),
    });
    const dockerParts = dockerBroker.setup();
    const baseSpec: RoomSpec = {
      ...withMcp,
      env: { ...withMcp.env, ...proxyEnv, ...dockerParts.env, ...(options.extraEnv ?? {}) },
      // Named so Stop can end the room itself, not just detach the terminal.
      name: `bumper-${id}`,
    };
    const extraDoors = [...previewParts.doors, ...dockerParts.doors];
    const spec: RoomSpec = withPreviewParts(
      roomSpecWithExtraDoors(baseSpec, extraDoors),
      { ...previewParts, doors: [] },
    );
    summary.roomMcpBroker = mcp.broker;
    summary.roomGitBroker = gitBroker;
    summary.previewBroker = previewBroker;
    summary.dockerPreviewBroker = dockerPreviewBroker;
    summary.dockerBroker = dockerBroker;
    try {
      await mcp.broker?.start();
      gitBroker.start();
      previewBroker.start();
      dockerPreviewBroker.start();
      dockerBroker.start();
      const term = backend.spawn(spec, previewParts.command, { cols: 100, rows: 30 });
      summary.term = term;
      summary.pid = term.pid;
      summary.status = "running";
      summary.protected = true;
      const mcpNote = `MCP: ${mcp.banner}\r\n`;
      const authNote = authDoors.length
        ? `Auth: persisted at ${authDoors.map((d) => d.roomPath).join(", ")} across launches.\r\n`
        : "";
      // Report the folders actually mounted. A "selected" share with nothing selected
      // produces no /workspace door at all, and claiming one made the agent's empty
      // working directory look like a bug.
      this.append(summary, `\r\n\x1b[38;5;31mBumper\x1b[0m  ${agentName} is protected by Apple container\r\n` +
        `Project: ${input.context}\r\n` +
        `Folders: ${describeFolderDoors(spec)}\r\n` +
        `Image: ${spec.image}  Egress: ${spec.egress.mode}\r\n` +
        `Command: ${roomCommand.join(" ")}\r\n` +
        `Doors: ${spec.doors.map((door) => `${door.roomPath}:${door.access}`).join(", ")}\r\n` +
        `Git: ${describeGitAccess(gitBroker)}\r\n` +
        mcpNote +
        authNote + `\r\n`);
      term.onData((data) => this.append(summary, data));
      term.onExit(({ exitCode }) => {
        summary.status = "stopped";
        summary.protected = false;
        summary.exitCode = exitCode;
        summary.endedAt = new Date().toISOString();
        summary.pid = undefined;
        summary.term = undefined;
        mcp.broker?.stop();
        summary.roomMcpBroker = undefined;
        if (summary.gitLeaseHeartbeat) clearInterval(summary.gitLeaseHeartbeat);
        summary.gitLeaseHeartbeat = undefined;
        if (summary.developmentLeaseHeartbeat) clearInterval(summary.developmentLeaseHeartbeat);
        summary.developmentLeaseHeartbeat = undefined;
        void previewBroker.stop();
        summary.previewBroker = undefined;
        void dockerPreviewBroker.stop();
        summary.dockerPreviewBroker = undefined;
        void dockerBroker.stop().finally(() => removeDevelopmentSessionLease(id));
        summary.dockerBroker = undefined;
        void gitBroker.stop().finally(() => {
          removeGitSessionLease(id);
          logEvent({
            context: input.context,
            surface: "session",
            source: "app",
            type: "git",
            decision: "allowed",
            target: "Git Session lease closed",
            reason: "Sandbox Session ended; lease removed",
            sessionId: id,
            repository: String(context.gitRepository ?? ""),
            access: "none",
          });
        });
        summary.roomGitBroker = undefined;
        summary.egressProxy?.stop();
        summary.egressProxy = undefined;
        this.broadcast(summary, { type: "status", session: this.publicSummary(summary) });
        this.persist();
        logEvent({ context: input.context, surface: "session", decision: "allowed", target: `${logName} Sandbox stopped`, reason: `exit ${exitCode}` });
      });
      logEvent({ context: input.context, surface: "session", decision: "allowed", target: `${logName} Sandbox launched`, reason: `room ${spec.image}; egress ${spec.egress.mode}` });
      this.persist();
      return this.publicSummary(summary);
    } catch (error) {
      mcp.broker?.stop();
      summary.roomMcpBroker = undefined;
      if (summary.gitLeaseHeartbeat) clearInterval(summary.gitLeaseHeartbeat);
      summary.gitLeaseHeartbeat = undefined;
      if (summary.developmentLeaseHeartbeat) clearInterval(summary.developmentLeaseHeartbeat);
      summary.developmentLeaseHeartbeat = undefined;
      void previewBroker.stop();
      summary.previewBroker = undefined;
      void dockerPreviewBroker.stop();
      summary.dockerPreviewBroker = undefined;
      void dockerBroker.stop().finally(() => removeDevelopmentSessionLease(id));
      summary.dockerBroker = undefined;
      void gitBroker.stop().finally(() => removeGitSessionLease(id));
      summary.roomGitBroker = undefined;
      summary.egressProxy?.stop();
      summary.egressProxy = undefined;
      summary.status = "failed";
      summary.error = (error as Error).message;
      summary.endedAt = new Date().toISOString();
      summary.protected = false;
      this.persist();
      logEvent({ context: input.context, surface: "session", decision: "blocked", target: `${logName} Sandbox launch failed`, reason: summary.error });
      throw error;
    }
  }

  stop(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session?.term) return false;
    try { session.term.kill("SIGTERM"); } catch { return false; }
    return true;
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      try { session.term?.kill("SIGTERM"); } catch { /* already stopped */ }
      try { session.roomMcpBroker?.stop(); } catch { /* best effort */ }
      if (session.gitLeaseHeartbeat) clearInterval(session.gitLeaseHeartbeat);
      session.gitLeaseHeartbeat = undefined;
      const broker = session.roomGitBroker;
      void broker?.stop().finally(() => removeGitSessionLease(session.id));
      session.roomGitBroker = undefined;
      if (session.developmentLeaseHeartbeat) clearInterval(session.developmentLeaseHeartbeat);
      session.developmentLeaseHeartbeat = undefined;
      void session.previewBroker?.stop();
      session.previewBroker = undefined;
      void session.dockerPreviewBroker?.stop();
      session.dockerPreviewBroker = undefined;
      void session.dockerBroker?.stop().finally(() => removeDevelopmentSessionLease(session.id));
      session.dockerBroker = undefined;
      try { session.egressProxy?.stop(); } catch { /* best effort */ }
    }
  }

  private attach(id: string, ws: WebSocket): void {
    const session = this.sessions.get(id);
    if (!session) { ws.close(1008, "Unknown session"); return; }
    session.clients.add(ws);
    ws.send(JSON.stringify({ type: "snapshot", session: this.publicSummary(session), output: session.output }));
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; data?: string; cols?: number; rows?: number };
        if (message.type === "input" && session.term && typeof message.data === "string") session.term.write(message.data);
        if (message.type === "resize" && session.term && message.cols && message.rows) session.term.resize(message.cols, message.rows);
      } catch { /* reject malformed messages without affecting the session */ }
    });
    ws.on("close", () => session.clients.delete(ws));
  }

  private append(session: RuntimeSession, data: string): void {
    session.output = (session.output + data).slice(-MAX_OUTPUT);
    this.broadcast(session, { type: "output", data });
  }

  private broadcast(session: RuntimeSession, message: unknown): void {
    const payload = JSON.stringify(message);
    for (const client of session.clients) {
      try { client.send(payload); } catch { session.clients.delete(client); }
    }
  }

  private publicSummary(session: RuntimeSession): SessionSummary {
    const { clients: _clients, output: _output, term: _term, roomMcpBroker: _roomMcpBroker, roomGitBroker: _roomGitBroker, gitLeaseHeartbeat: _gitLeaseHeartbeat, egressProxy: _egressProxy, ...summary } = session;
    return summary;
  }

  private persist(): void {
    try {
      mkdirSync(stateDir(), { recursive: true });
      const sessions = this.list().slice(0, 100);
      writeFileSync(sessionsPath(), JSON.stringify({ sessions }, null, 2) + "\n", { mode: 0o600 });
    } catch { /* session persistence must not break containment */ }
  }
}
