/**
 * Phase 2: bumper <cli> Room entry — resolve Project → readiness → TTY attach.
 *
 * Host vendor CLI is never required. Sandbox image CLI (roomCommand) is canonical.
 * Readiness reuses assets/launch-gate.js so refuse messages match the GUI checklist.
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Config, Context } from "./types.js";
import {
  autoApproveEnvFor,
  composeRoomCommand,
  forceCodexDeviceAuthLogin,
  getAgent,
  supportsAutoApprove,
  type AgentId,
} from "./agents.js";
import {
  applyCreatedProject,
  normalizeHostPath,
  projectAccessRoots,
  resolveProject,
  type ResolveAskRequest,
  type ResolveAskResponse,
  type ResolveProjectResult,
} from "./project.js";
import { effectiveContext } from "./effective.js";
import { getActiveContext } from "./state.js";
import { stateDir } from "./paths.js";
import { logEvent } from "./log.js";
import { AppleContainerBackend, buildRunArgs } from "./room/apple-container.js";
import { describeFolderDoors, profileIdForAgent, roomSpecForAgentLaunch } from "./room/launch.js";
import type { Door, RoomSpec } from "./room/backend.js";
import {
  ROOM_MCP_RUNTIME_MISSING_EXIT,
  roomExecutablePreflight,
  roomPreflightFailureDetail,
} from "./room/preflight.js";
import { prepareRoomMcp, withMcpBroker } from "./room/mcp-broker.js";
import { roomAuthCredentialPresent } from "./room/auth.js";
import { describeGitAccess, projectGitBroker, withGitBroker } from "./git-broker.js";
import { GitHubAppService } from "./github-app.js";
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
import { projectAuthProfileId } from "./setups.js";
import {
  describeImageSource,
  inspectRecommendedRoomRecipe,
  RECOMMENDED_ROOM_IMAGE,
  RECOMMENDED_ROOM_RECIPE,
} from "./room/setup.js";
import { EgressProxy } from "./room/egress-proxy.js";
import { startAllowlistEgress } from "./room/egress-network.js";
import { projectGitBindings, projectGitCeiling } from "./git-repositories.js";
import { loadConfig } from "./config.js";
import {
  computeLaunchGate,
  loadLaunchGate,
  type LaunchGateResult,
} from "./launch-gate-node.js";

/** CLI tokens → AgentId (roomCommand mapping). Host detection is irrelevant. */
export const CLI_AGENT_ALIASES: Record<string, AgentId> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  "cursor-agent": "cursor",
  agy: "antigravity",
  antigravity: "antigravity",
  grok: "grok",
};

export function isCliAgentCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  return cmd.toLowerCase() in CLI_AGENT_ALIASES;
}

export function resolveCliAgentId(cmd: string): AgentId | undefined {
  return CLI_AGENT_ALIASES[cmd.toLowerCase()];
}

export function listCliAgentAliases(): string[] {
  return Object.keys(CLI_AGENT_ALIASES).sort();
}

/** Parse global CLI flags used by Room entry: -p / --project. */
export function parseProjectFlag(argv: string[]): {
  projectFlag?: string;
  /** Phase 9-3: rebind this Project's tool account (already-bound Projects only). */
  accountFlag?: string;
  rest: string[];
} {
  const rest: string[] = [];
  let projectFlag: string | undefined;
  let accountFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-p" || a === "--project") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for ${a}. Usage: bumper -p <project> <cli>`);
      }
      projectFlag = value;
      continue;
    }
    if (a.startsWith("-p=") || a.startsWith("--project=")) {
      projectFlag = a.slice(a.indexOf("=") + 1);
      if (!projectFlag) throw new Error(`Missing value for ${a.split("=")[0]}.`);
      continue;
    }
    if (a === "--account") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) {
        throw new Error(`Missing value for --account. Usage: bumper <cli> --account <id>`);
      }
      accountFlag = value;
      continue;
    }
    if (a.startsWith("--account=")) {
      accountFlag = a.slice("--account=".length);
      if (!accountFlag) throw new Error("Missing value for --account.");
      continue;
    }
    rest.push(a);
  }
  return { projectFlag, accountFlag, rest };
}

/** Workspace for Room mount: project.workspace if set, else cwd when it exists. */
export function resolveLaunchWorkspace(context: Context, cwd: string): string {
  const fromProject = context.workspace?.trim();
  if (fromProject) return normalizeHostPath(fromProject);
  return normalizeHostPath(cwd || process.cwd());
}

export type ImageProbeStatus = "ready" | "missing" | "setup" | "unavailable" | "pending";

export interface ImageProbeResult {
  status: ImageProbeStatus;
  detail: string;
  skippedPreflight: boolean;
}

/**
 * Probe whether the Sandbox image has the tool CLI without starting a session.
 * Base images are setup (no auto preflight). Recommended/custom run preflight
 * with the same mounts as launch when container is available.
 */
export async function probeRoomImageForAgent(opts: {
  context: Context;
  workspace: string;
  agentId: AgentId;
  roomAvailable: boolean;
  roomAvailableDetail: string;
  /** Inject for tests — defaults to Apple container backend. */
  runPreflight?: (command: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}): Promise<ImageProbeResult> {
  const agent = getAgent(opts.agentId);
  if (!agent?.roomCommand?.length) {
    return {
      status: "missing",
      detail: "This tool has no Sandbox command mapping.",
      skippedPreflight: true,
    };
  }

  if (!opts.roomAvailable) {
    return {
      status: "unavailable",
      detail: opts.roomAvailableDetail || "Apple container is not available.",
      skippedPreflight: true,
    };
  }

  const image = opts.context.room?.image || "docker.io/library/alpine:3.20";
  const source = describeImageSource(image);
  const gate = loadLaunchGate();
  if (!gate.shouldAutoPreflightOnHome(source.kind)) {
    return {
      status: "setup",
      detail: gate.SAFE_BASE_IMAGE_DETAIL,
      skippedPreflight: true,
    };
  }

  const workspace = opts.workspace;
  if (!workspace || !existsSync(workspace)) {
    return {
      status: "pending",
      detail: "Choose a workspace before checking the image.",
      skippedPreflight: true,
    };
  }

  const profileId = profileIdForAgent(opts.context, opts.agentId);
  // Preflight does not need history isolation overlays (no Project conversation yet).
  const launchSpec = roomSpecForAgentLaunch(opts.context, workspace, opts.agentId, {
    mountAuth: true,
    profileId,
  });
  const preflight = roomExecutablePreflight(agent.roomCommand);
  let result: { exitCode: number; stdout: string; stderr: string };
  if (opts.runPreflight) {
    result = await opts.runPreflight(preflight.command);
  } else {
    const backend = new AppleContainerBackend();
    result = await backend.run(launchSpec, preflight.command);
  }

  if (result.exitCode === 0) {
    return {
      status: "ready",
      detail: `${agent.name} CLI is available in Sandbox image ${image}.`,
      skippedPreflight: false,
    };
  }

  return {
    status: "missing",
    detail: roomPreflightFailureDetail(agent.name, agent.roomCommand, image, result),
    skippedPreflight: false,
  };
}

export interface AssessCliReadinessOptions {
  config: Config;
  projectName: string;
  agentId: AgentId;
  cwd: string;
  /** Override platform checks (tests). */
  macOS?: boolean;
  roomAvailable?: boolean;
  roomAvailableDetail?: string;
  /** Inject image probe result (tests / status-adjacent paths). */
  imageProbe?: ImageProbeResult;
  /** Test hook for image probe when imageProbe is not set. */
  probeImage?: () => Promise<ImageProbeResult>;
}

export interface CliReadinessAssessment {
  canLaunch: boolean;
  gate: LaunchGateResult;
  workspace: string;
  context: Context;
  /** Raw project (for room.enabled honesty before effectiveContext forces true). */
  project: Context;
  image: ImageProbeResult;
  agentId: AgentId;
  agentName: string;
  roomCommand: string[];
}

export async function assessCliRoomReadiness(opts: AssessCliReadinessOptions): Promise<CliReadinessAssessment> {
  const project = opts.config.contexts[opts.projectName];
  if (!project) throw new Error(`Unknown project: ${opts.projectName}`);

  const context = effectiveContext(opts.config, opts.projectName);
  const agent = getAgent(opts.agentId);
  if (!agent) throw new Error(`Unknown AI tool: ${opts.agentId}`);

  const workspace = resolveLaunchWorkspace(project, opts.cwd);
  const workspaceExists = Boolean(workspace && existsSync(workspace));
  const roomEnabled = project.room?.enabled !== false;
  const agentMapped = Array.isArray(agent.roomCommand) && agent.roomCommand.length > 0;

  const macOS = opts.macOS ?? process.platform === "darwin";
  let roomAvailable = opts.roomAvailable;
  let roomAvailableDetail = opts.roomAvailableDetail ?? "";
  if (roomAvailable === undefined) {
    const backend = new AppleContainerBackend();
    const availability = await backend.check();
    roomAvailable = availability.usable;
    roomAvailableDetail = availability.detail;
  }

  let image: ImageProbeResult;
  if (opts.imageProbe) {
    image = opts.imageProbe;
  } else if (opts.probeImage) {
    image = await opts.probeImage();
  } else {
    image = await probeRoomImageForAgent({
      context: roomEnabled ? context : { ...context, room: { ...context.room, enabled: false } },
      workspace: workspaceExists ? realpathSync(workspace) : workspace,
      agentId: opts.agentId,
      roomAvailable: Boolean(roomAvailable),
      roomAvailableDetail,
    });
  }

  // Map probe → launch-gate imageStatus vocabulary
  const imageStatus =
    image.status === "unavailable" ? "missing"
      : image.status === "pending" ? "pending"
        : image.status;

  const gate = computeLaunchGate({
    macOS,
    roomAvailable: Boolean(roomAvailable),
    projectName: opts.projectName,
    workspace: workspaceExists ? workspace : "",
    roomEnabled,
    agentId: opts.agentId,
    agentMapped,
    imageStatus,
    imageDetail: image.detail,
    authRelevant: true,
    authPersisted: roomAuthCredentialPresent(opts.agentId, projectAuthProfileId(project, opts.agentId)),
  });

  return {
    canLaunch: gate.canLaunch,
    gate,
    workspace: workspaceExists ? realpathSync(workspace) : workspace,
    context,
    project,
    image,
    agentId: opts.agentId,
    agentName: agent.name,
    roomCommand: agent.roomCommand,
  };
}

/** CLI next-step hints for each launch-gate action. */
export function nextCommandsForAction(action: string | null | undefined, agentId?: string): string[] {
  switch (action) {
    case "install-container":
      return [
        "Install Apple container 1.1.0+ (https://github.com/apple/container), then re-run.",
        "Verify: /usr/local/bin/container --version",
      ];
    case "choose-project":
      return [
        "Create or pick a project: bumper app",
        "Or: bumper -p <project> <cli>",
      ];
    case "choose-workspace":
      return [
        "bumper access set [-p project] [folder]   # bind workspace as primary Access root",
        "Or: Bumper app → Home folder picker / Projects → Access (choosing a folder binds Access).",
        "Then run from a directory covered by that Access root (cwd resolve).",
      ];
    case "choose-tool":
      return [
        `Supported: ${listCliAgentAliases().join(", ")}`,
        "Example: bumper grok",
      ];
    case "build-image":
      return [
        "Build/rebuild: bumper room-image build --force",
        "Or: Bumper app → Build AI Sandbox image (Retry uses --force when replacing an older local image).",
        `Needed recipe: ${RECOMMENDED_ROOM_RECIPE} (PATH bins must survive empty auth mounts).`,
        agentId ? `Custom images must provide \`${agentId}\` on PATH (not only a host install).` : "Custom images must provide the AI CLI on PATH inside the Sandbox.",
      ];
    case "wait-image":
      return ["Wait for the image check to finish, then re-run."];
    case "open-project-settings":
      return ["Open the Bumper app → Project settings → enable Room backend."];
    case "sign-in":
      return ["Optional: sign in via Bumper app → Project → AI tools, or complete login inside the Sandbox session."];
    default:
      return [];
  }
}

/**
 * Print readiness refusal — same checklist semantics as GUI Home.
 * Does not start a Sandbox.
 */
export function formatReadinessRefuse(assessment: CliReadinessAssessment): string {
  const lines: string[] = [];
  lines.push(`bumper: cannot start ${assessment.agentId} — Sandbox is not ready.`);
  lines.push("");
  lines.push(`Project: ${assessment.gate.checklist.find((c) => c.id === "project")?.detail || assessment.agentName}`);
  if (assessment.gate.reason) {
    lines.push(`Reason: ${assessment.gate.reason}`);
  }
  lines.push("");
  lines.push("Checklist:");
  for (const item of assessment.gate.checklist) {
    if (item.id === "launch") continue;
    const mark =
      item.status === "ready" ? "✓"
        : item.status === "optional" ? "·"
          : item.status === "checking" ? "…"
            : "✗";
    lines.push(`  ${mark} ${item.label}: ${item.detail}`);
  }
  lines.push("");
  const action = assessment.gate.nextAction;
  if (action && action !== "launch") {
    lines.push(`Next: ${assessment.gate.nextActionLabel || action}`);
    for (const cmd of nextCommandsForAction(action, assessment.agentId)) {
      lines.push(`  ${cmd}`);
    }
    lines.push("");
  }
  lines.push("Host vendor CLI is not required. The CLI inside the Sandbox image is what runs.");
  lines.push("Sandbox was not started.");
  return lines.join("\n");
}

export interface ProjectStatusSnapshot {
  projectName: string;
  source: string;
  mode: string;
  roomEnabled: boolean;
  image: string;
  imageKind: string;
  imageLabel: string;
  egress: string;
  workspace: string;
  accessRoots: { path: string; role: string; access?: string }[];
  container: { usable: boolean; detail: string };
  tools: { id: AgentId; alias: string; roomCommand: string; mapped: boolean; authPersisted: boolean; profileId: string }[];
  note?: string;
}

export async function buildProjectStatusSnapshot(opts: {
  config: Config;
  projectName: string;
  source: string;
  cwd: string;
  macOS?: boolean;
  roomAvailable?: boolean;
  roomAvailableDetail?: string;
}): Promise<ProjectStatusSnapshot> {
  const project = opts.config.contexts[opts.projectName];
  if (!project) throw new Error(`Unknown project: ${opts.projectName}`);

  const workspace = resolveLaunchWorkspace(project, opts.cwd);
  const image = project.room?.image || "docker.io/library/alpine:3.20";
  const sourceInfo = describeImageSource(image);
  const roots = projectAccessRoots(project);

  let container = { usable: false, detail: "not checked" };
  if (opts.roomAvailable !== undefined) {
    container = { usable: opts.roomAvailable, detail: opts.roomAvailableDetail || "" };
  } else {
    const backend = new AppleContainerBackend();
    const availability = await backend.check();
    container = { usable: availability.usable, detail: availability.detail };
  }

  const order: AgentId[] = ["claude", "codex", "cursor", "antigravity", "grok"];
  const orderedTools = order.map((id) => {
    const agent = getAgent(id);
    const profileId = projectAuthProfileId(project, id);
    return {
      id,
      alias: id === "antigravity" ? "agy" : id,
      roomCommand: agent?.roomCommand?.join(" ") || "(none)",
      mapped: Boolean(agent?.roomCommand?.length),
      authPersisted: roomAuthCredentialPresent(id, profileId),
      profileId,
    };
  });

  let note: string | undefined;
  if (sourceInfo.kind === "base") {
    note = "Safe base image has no AI CLIs by design. Build: bumper room-image build [-p project]";
  } else if (sourceInfo.kind === "recommended" || image === RECOMMENDED_ROOM_IMAGE) {
    // Hermetic tests inject roomAvailable; skip live `container image inspect` there.
    const liveProbe = opts.macOS !== false && opts.roomAvailable === undefined;
    if (!liveProbe) {
      note = `Recommended image ${image}. If auth mounts hide CLIs, rebuild: bumper room-image build --force (${RECOMMENDED_ROOM_RECIPE}).`;
    } else {
      const recipe = inspectRecommendedRoomRecipe(image);
      note = recipe.detail;
    }
  }

  return {
    projectName: opts.projectName,
    source: opts.source,
    mode: project.mode,
    roomEnabled: project.room?.enabled !== false,
    image,
    imageKind: sourceInfo.kind,
    imageLabel: sourceInfo.label,
    egress: project.room?.egress || "blocked",
    workspace: workspace || "(unset)",
    accessRoots: roots.map((r) => ({ path: r.path, role: r.role, access: r.access })),
    container,
    tools: orderedTools,
    note,
  };
}

export function formatProjectStatus(snapshot: ProjectStatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`Project: ${snapshot.projectName}  (resolved via ${snapshot.source})`);
  lines.push(`Mode: ${snapshot.mode}  ·  Room: ${snapshot.roomEnabled ? "enabled" : "disabled"}  ·  Egress: ${snapshot.egress}`);
  lines.push(`Workspace: ${snapshot.workspace}`);
  lines.push(`Image: ${snapshot.image}`);
  lines.push(`  ${snapshot.imageLabel} [${snapshot.imageKind}]`);
  lines.push(`Container: ${snapshot.container.usable ? "available" : "unavailable"} — ${snapshot.container.detail}`);
  lines.push("");
  lines.push("Access roots:");
  if (snapshot.accessRoots.length === 0) {
    lines.push("  (none — cwd resolve cannot match this Project; status alone is not enough)");
    lines.push(`  Fix: bumper access set -p "${snapshot.projectName}"   # uses cwd, or pass a folder`);
    lines.push("       or Bumper app → Projects → Access → choose workspace (primary Access root)");
    lines.push("  Bumper does not invent a home-wide door.");
  } else {
    for (const root of snapshot.accessRoots) {
      const access = root.access ? ` [${root.access}]` : "";
      lines.push(`  · ${root.role}: ${root.path}${access}`);
    }
  }
  lines.push("");
  lines.push("Tool readiness (Sandbox image is canonical; host install not required):");
  for (const tool of snapshot.tools) {
    const auth = tool.authPersisted ? "auth:persisted" : "auth:none";
    const profile = tool.profileId && tool.profileId !== "default" ? ` · profile:${tool.profileId}` : "";
    const map = tool.mapped ? `room: ${tool.roomCommand}` : "not mapped";
    lines.push(`  · ${tool.alias}  ${map}  ·  ${auth}${profile}`);
  }
  if (snapshot.note) {
    lines.push("");
    lines.push(`Note: ${snapshot.note}`);
  }
  lines.push("");
  lines.push("No session started. Launch: bumper [-p project] <cli>");
  lines.push(`  CLIs: ${listCliAgentAliases().join(", ")}`);
  return lines.join("\n");
}

/** Interactive ask for resolveProject when stdin is a TTY. */
export async function ttyProjectAsk(req: ResolveAskRequest): Promise<ResolveAskResponse> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt: string) =>
    new Promise<string>((resolve) => rl.question(prompt, resolve));

  try {
    if (req.type === "select") {
      console.log(req.prompt);
      req.choices.forEach((name, i) => console.log(`  ${i + 1}) ${name}`));
      if (req.allowCreate) console.log(`  c) Create a Project for this folder${req.defaultCreate ? "   [Enter]" : ""}`);
      console.log("  q) Cancel");
      const answer = (await question("> ")).trim().toLowerCase();
      if (answer === "" && req.defaultCreate) return { action: "create", name: "" };
      if (answer === "q" || answer === "") return { action: "cancel" };
      if (answer === "c" && req.allowCreate) {
        return { action: "create", name: "" };
      }
      const asNum = Number(answer);
      if (Number.isInteger(asNum) && asNum >= 1 && asNum <= req.choices.length) {
        return { action: "select", name: req.choices[asNum - 1]! };
      }
      if (req.choices.includes(answer)) return { action: "select", name: answer };
      // allow typing create name directly
      if (req.allowCreate && answer && !/^\d+$/.test(answer)) {
        return { action: "create", name: answer };
      }
      return { action: "cancel" };
    }

    // create-name
    const raw = (await question(`${req.prompt} [${req.defaultName}]: `)).trim();
    if (raw.toLowerCase() === "q") return { action: "cancel" };
    return { action: "create", name: raw || req.defaultName };
  } finally {
    rl.close();
  }
}

/**
 * Account picker for unbound (Project, tool) — same shape as ttyProjectAsk.
 * Lines: "<label>  signed in · used by N Projects", plus n) New / q) Cancel.
 */
export async function ttyAccountAsk(opts: {
  toolLabel: string;
  accounts: import("./room/accounts.js").AccountChoice[];
}): Promise<import("./room/accounts.js").AccountPromptResult> {
  const { formatAccountChoiceLine, parseAccountPromptAnswer } = await import("./room/accounts.js");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt: string) =>
    new Promise<string>((resolve) => rl.question(prompt, resolve));
  try {
    console.log(`This Project has no ${opts.toolLabel} account yet.`);
    opts.accounts.forEach((account, i) => {
      console.log(`  ${i + 1}) ${formatAccountChoiceLine(account)}`);
    });
    console.log("  n) New login for this Project");
    console.log("  q) Cancel");
    const answer = await question("> ");
    return parseAccountPromptAnswer(answer, opts.accounts);
  } finally {
    rl.close();
  }
}

export async function resolveProjectForCli(opts: {
  config: Config;
  configPath: string;
  cwd: string;
  flag?: string | null;
  interactive: boolean;
}): Promise<ResolveProjectResult> {
  return resolveProject({
    config: opts.config,
    cwd: opts.cwd,
    flag: opts.flag,
    interactive: opts.interactive,
    ask: opts.interactive ? ttyProjectAsk : undefined,
    createProject: async ({ name, workspace }) => {
      applyCreatedProject(opts.config, { name, workspace });
      writeFileSync(opts.configPath, `${JSON.stringify(opts.config, null, 2)}\n`, { mode: 0o600 });
    },
  });
}

/**
 * Resolve project for status: flag → cwd unique → active state → default.
 * Never silently creates.
 */
export async function resolveProjectForStatus(opts: {
  config: Config;
  cwd: string;
  flag?: string | null;
}): Promise<{ name: string; source: string } | { error: string }> {
  if (opts.flag?.trim()) {
    const name = opts.flag.trim();
    if (!opts.config.contexts[name]) {
      return {
        error: `Unknown project "${name}". Available: ${Object.keys(opts.config.contexts).join(", ") || "(none)"}.`,
      };
    }
    return { name, source: "flag" };
  }

  const resolved = await resolveProject({
    config: opts.config,
    cwd: opts.cwd,
    interactive: false,
  });
  if (resolved.ok) return { name: resolved.name, source: resolved.source };

  const active = getActiveContext(opts.config.defaultContext);
  if (active && opts.config.contexts[active]) {
    return { name: active, source: "active-state" };
  }

  return { error: resolved.message };
}

export interface RunCliRoomOptions {
  config: Config;
  projectName: string;
  agentId: AgentId;
  cwd: string;
  /** Extra args after the agent name (passed into the room command). */
  agentArgs?: string[];
  /** Skip TTY check (tests only). */
  requireTty?: boolean;
  /** Inject assessment for dry-run refuse testing. */
  assessment?: CliReadinessAssessment;
  /** When true, never spawn container (return after readiness). */
  dryRun?: boolean;
}

export type RunCliRoomResult =
  | { started: false; refused: true; message: string; exitCode: number }
  | { started: true; exitCode: number }
  | { started: false; dryRunReady: true; message: string; exitCode: number };

/**
 * Full bumper <cli> pipeline: readiness → if ready, TTY-attach container on this terminal.
 */
export async function runCliRoomAgent(opts: RunCliRoomOptions): Promise<RunCliRoomResult> {
  const assessment = opts.assessment ?? await assessCliRoomReadiness({
    config: opts.config,
    projectName: opts.projectName,
    agentId: opts.agentId,
    cwd: opts.cwd,
  });

  if (!assessment.canLaunch) {
    return {
      started: false,
      refused: true,
      message: formatReadinessRefuse(assessment),
      exitCode: 1,
    };
  }

  if (opts.dryRun) {
    return {
      started: false,
      dryRunReady: true,
      message: `Ready to launch ${assessment.agentId} in project "${opts.projectName}" (dry-run; Sandbox not started).`,
      exitCode: 0,
    };
  }

  const requireTty = opts.requireTty !== false;
  if (requireTty && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    return {
      started: false,
      refused: true,
      message: [
        "bumper: cannot start a Sandbox agent without an interactive TTY.",
        "Run from a real terminal, or use the Bumper app (Advanced → Sessions) for attach.",
        "Sandbox was not started.",
      ].join("\n"),
      exitCode: 1,
    };
  }

  const backend = new AppleContainerBackend();
  const availability = await backend.check();
  if (!availability.usable) {
    return {
      started: false,
      refused: true,
      message: `bumper: ${availability.detail}\nSandbox was not started.`,
      exitCode: 1,
    };
  }

  const profileId = profileIdForAgent(assessment.context, opts.agentId);
  const forceDeviceAuthLogin = forceCodexDeviceAuthLogin(
    opts.agentId,
    roomAuthCredentialPresent(opts.agentId as AgentId, profileId),
  );
  // Device-auth login is not a coding session — never attach auto-approve flags.
  const autoApprove =
    !forceDeviceAuthLogin &&
    assessment.context.autoApprove === true &&
    supportsAutoApprove(opts.agentId);
  const launchSpec = roomSpecForAgentLaunch(assessment.context, assessment.workspace, opts.agentId, {
    mountAuth: true,
    profileId,
    projectName: opts.projectName,
  });

  // Final preflight with launch mounts (auth + history overlays). When the
  // Project binds MCP Connections, the same run also answers "can the Hub
  // bridge run in this image?" instead of costing a second container start.
  const wantsMcp = Object.keys(assessment.context.mcpBindings ?? {}).length > 0;
  const preflight = roomExecutablePreflight(assessment.roomCommand, { requireNode: wantsMcp });
  const preflightResult = await backend.run(launchSpec, preflight.command);
  const mcpRuntimeAvailable = preflightResult.exitCode !== ROOM_MCP_RUNTIME_MISSING_EXIT;
  if (preflightResult.exitCode !== 0 && mcpRuntimeAvailable) {
    const reason = roomPreflightFailureDetail(
      assessment.agentName,
      assessment.roomCommand,
      launchSpec.image,
      preflightResult,
    );
    logEvent({
      context: opts.projectName,
      surface: "session",
      decision: "blocked",
      target: `${assessment.agentName} Sandbox preflight failed`,
      reason,
    });
    return {
      started: false,
      refused: true,
      message: `bumper: ${reason}\nSandbox was not started.`,
      exitCode: 1,
    };
  }

  /*
   * MCP Hub. Composed through prepareRoomMcp so this path and SessionManager
   * cannot diverge — the previous revision wired the broker into SessionManager
   * only, and `bumper <cli>`, the path users actually run, had no MCP at all.
   */
  const mcp = prepareRoomMcp({
    dir: join(stateDir(), "room-mcp-broker", `cli-${Date.now().toString(36)}`),
    config: opts.config,
    projectName: opts.projectName,
    context: assessment.context,
    agentId: opts.agentId,
    runtimeAvailable: mcpRuntimeAvailable,
  });
  const command = composeRoomCommand({
    agentId: opts.agentId,
    roomCommand: assessment.roomCommand,
    autoApprove,
    bumperArgs: mcp.args,
    agentArgs: forceDeviceAuthLogin ? [] : opts.agentArgs,
    forceDeviceAuthLogin,
  });

  let proxyEnv: Record<string, string> = {};
  let egressProxy: EgressProxy | undefined;
  let egress = launchSpec.egress;
  if (egress.mode === "allowlist") {
    const started = await startAllowlistEgress(egress.hosts, ({ host, allowed, method, denial }) => logEvent({
      context: opts.projectName,
      surface: "network",
      decision: allowed ? "allowed" : "blocked",
      target: denial?.target ?? `${method} ${host}`,
      reason: allowed
        ? "host on project egress allowlist"
        : (denial?.reason ?? "host not on project egress allowlist — blocked by proxy"),
      fixTab: denial?.fixTab,
      fixLabel: denial?.fixLabel,
    }), { project: opts.projectName });
    egressProxy = started.proxy;
    proxyEnv = started.env;
    egress = started.egress;
  }

  /*
   * Git credential broker. This is the path users actually run (`bumper <cli>`),
   * so it must be wired here — an earlier revision only wired SessionManager,
   * which has no entry point, and the whole feature was unreachable.
   * Scope comes from Project config via projectGitBroker (decision R4).
   */
  const gitBindings = projectGitBindings(assessment.context);
  const gitLease = createGitSessionLease({
    pid: process.pid,
    projectName: opts.projectName,
    agentId: opts.agentId,
    agentName: assessment.agentName,
    // The lease labels the whole Session, which may bind several repositories.
    repository: gitBindings.map((row) => row.fullName).join(", "),
    connectionId: gitBindings[0]?.connectionId ?? "",
    enabled: gitBindings.length > 0,
  });
  const gitLeaseHeartbeat = setInterval(
    () => heartbeatGitSessionLease(gitLease.id),
    GIT_SESSION_HEARTBEAT_MS,
  );
  gitLeaseHeartbeat.unref?.();
  createDevelopmentSessionLease({
    id: gitLease.id,
    pid: process.pid,
    projectName: opts.projectName,
    agentId: opts.agentId,
    agentName: assessment.agentName,
    previewEnabled: assessment.context.development.preview.enabled,
    dockerEnabled: assessment.context.development.docker.enabled,
  });
  const developmentLeaseHeartbeat = setInterval(
    () => heartbeatDevelopmentSessionLease(gitLease.id),
    DEVELOPMENT_HEARTBEAT_MS,
  );
  developmentLeaseHeartbeat.unref?.();
  logEvent({
    context: opts.projectName,
    surface: "session",
    source: "app",
    type: "git",
    decision: "allowed",
    target: "Git Session lease opened",
    reason: `${assessment.agentName}; live access can be changed in Project → Git`,
    sessionId: gitLease.id,
    repository: gitLease.repository,
    capability: projectGitCeiling(assessment.context),
  });
  const gitBroker = projectGitBroker({
    dir: join(stateDir(), "room-git-broker", `cli-${Date.now().toString(36)}`),
    sessionId: gitLease.id,
    projectName: opts.projectName,
    context: assessment.context,
    installations: Object.entries(opts.config.githubApps ?? {}).flatMap(([connectionId, app]) =>
      app.installations.map((installation) => ({ ...installation, connectionId }))),
    resolveState: () => {
      const current = loadConfig().config;
      return {
        context: current.contexts[opts.projectName] ?? { gitAccess: "none", gitRepository: "", gitWriteUntil: "" },
        installations: Object.entries(current.githubApps ?? {}).flatMap(([connectionId, app]) =>
          app.installations.map((installation) => ({ ...installation, connectionId }))),
      };
    },
    github: {
      issue: (connectionId, installationId, repos, capability, context) =>
        new GitHubAppService().forConnection(connectionId).issue(installationId, repos, capability, context),
      revoke: (connectionId, token) => new GitHubAppService().forConnection(connectionId).revoke(token),
    },
    onEvent: ({ decision, target, reason }: { decision: "allowed" | "blocked" | "failed"; target: string; reason: string }) => logEvent({
      context: opts.projectName, surface: "session", source: "room", type: "git", decision, target, reason,
      sessionId: gitLease.id,
      repository: projectGitBindings(loadConfig().config.contexts[opts.projectName])
        .map((row) => row.fullName).join(", "),
    }),
  });
  let gitDoor: Door;
  try {
    gitDoor = gitBroker.setup().door;
  } catch (error) {
    clearInterval(gitLeaseHeartbeat);
    clearInterval(developmentLeaseHeartbeat);
    removeDevelopmentSessionLease(gitLease.id);
    removeGitSessionLease(gitLease.id);
    throw error;
  }

  // `egress` may now carry the host-only network prepared above; the spec must
  // use it, not the pre-proxy launchSpec value.
  const withGit = withGitBroker({ ...launchSpec, egress }, gitDoor);
  const withMcp = mcp.door ? withMcpBroker(withGit, mcp.door) : withGit;
  const previewBroker = new PreviewBroker(
    join(stateDir(), "room-preview-broker", gitLease.id),
    gitLease.id,
    ({ decision, target, reason, roomPort, hostPort }) => logEvent({
      context: opts.projectName,
      surface: "session",
      source: "app",
      type: "network",
      decision,
      target,
      reason: `${reason}${roomPort ? `; Sandbox :${roomPort}` : ""}${hostPort ? `; Mac :${hostPort}` : ""}`,
      sessionId: gitLease.id,
    }),
  );
  const previewParts = previewBroker.setup(command);
  const dockerPreviewBroker = new PreviewBroker(
    join(stateDir(), "room-docker-preview-broker", gitLease.id),
    gitLease.id,
    ({ decision, target, reason, roomPort, hostPort }) => logEvent({
      context: opts.projectName,
      surface: "session",
      source: "app",
      type: "network",
      decision,
      target: `Docker ${target}`,
      reason: `${reason}${roomPort ? `; Engine :${roomPort}` : ""}${hostPort ? `; Mac :${hostPort}` : ""}`,
      sessionId: gitLease.id,
    }),
    "docker",
  );
  const dockerPreviewParts = dockerPreviewBroker.setup([]);
  const dockerBroker = new DockerBroker({
    dir: join(stateDir(), "room-docker-broker", gitLease.id),
    sessionId: gitLease.id,
    projectName: opts.projectName,
    workspaceDoors: launchSpec.doors.filter((door) =>
      door.roomPath === "/workspace" || door.roomPath.startsWith("/workspace/")),
    egress,
    proxyEnv,
    preview: dockerPreviewParts,
    onEvent: ({ decision, target, reason }) => logEvent({
      context: opts.projectName,
      surface: "session",
      source: "app",
      type: "system",
      decision,
      target,
      reason,
      sessionId: gitLease.id,
    }),
  });
  const dockerParts = dockerBroker.setup();
  const baseSpec: RoomSpec = {
    ...withMcp,
    doors: [...withMcp.doors, ...previewParts.doors, ...dockerParts.doors],
    env: {
      ...withMcp.env,
      ...proxyEnv,
      ...dockerParts.env,
      ...(autoApprove ? autoApproveEnvFor(opts.agentId) : {}),
    },
  };
  const spec = withPreviewParts(baseSpec, { ...previewParts, doors: [] });
  gitBroker.start();
  await mcp.broker?.start();
  previewBroker.start();
  dockerPreviewBroker.start();
  dockerBroker.start();

  console.error(
    [
      forceDeviceAuthLogin
        ? `bumper: no Codex login yet — starting device auth in Sandbox (project "${opts.projectName}")`
        : `bumper: starting ${assessment.agentName} in Sandbox (project "${opts.projectName}")`,
      `  Folders: ${describeFolderDoors(spec)}`,
      `  Image: ${spec.image}  Egress: ${spec.egress.mode}`,
      `  Command: ${command.join(" ")}`,
      `  Git: ${describeGitAccess(gitBroker)}`,
      `  MCP: ${mcp.banner}`,
      `  Preview: ${assessment.context.development.preview.enabled ? "On" : "Off"} (live ports appear in Project → Development)`,
      `  Docker: ${assessment.context.development.docker.enabled ? "On; engine starts on first command" : "Off"}`,
      forceDeviceAuthLogin
        ? "  Open the shown URL on the host browser and paste the code back into this terminal."
        : autoApprove
          ? "  Approval prompts: off — the room is the boundary, not the prompt."
          : "  Approval prompts: the tool's own defaults.",
      "  Host vendor CLI is not used — Sandbox image CLI is canonical.",
    ].join("\n"),
  );

  try {
    const exitCode = await attachInteractiveContainer(spec, previewParts.command);
    logEvent({
      context: opts.projectName,
      surface: "session",
      decision: "allowed",
      target: `${assessment.agentName} Room CLI stopped`,
      reason: `exit ${exitCode}`,
    });
    return { started: true, exitCode };
  } catch (err) {
    const message = (err as Error).message;
    logEvent({
      context: opts.projectName,
      surface: "session",
      decision: "blocked",
      target: `${assessment.agentName} Room CLI launch failed`,
      reason: message,
    });
    return {
      started: false,
      refused: true,
      message: `bumper: ${message}\nSandbox launch failed.`,
      exitCode: 1,
    };
  } finally {
    mcp.broker?.stop();
    await previewBroker.stop();
    await dockerPreviewBroker.stop();
    await dockerBroker.stop();
    clearInterval(developmentLeaseHeartbeat);
    removeDevelopmentSessionLease(gitLease.id);
    await gitBroker.stop();
    clearInterval(gitLeaseHeartbeat);
    removeGitSessionLease(gitLease.id);
    logEvent({
      context: opts.projectName,
      surface: "session",
      source: "app",
      type: "git",
      decision: "allowed",
      target: "Git Session lease closed",
      reason: "host CLI Session ended; lease removed",
      sessionId: gitLease.id,
      repository: gitLease.repository,
      access: "none",
    });
    egressProxy?.stop();
  }
}

/**
 * Attach `container run --interactive --tty` to the current process stdio.
 * Not Electron xterm / node-pty — pure host TTY.
 */
export function attachInteractiveContainer(
  spec: Parameters<typeof buildRunArgs>[0],
  command: string[],
): Promise<number> {
  const CONTAINER_BIN = "/usr/local/bin/container";
  const args = buildRunArgs(spec, command, true);
  return new Promise((resolve, reject) => {
    const child = spawn(CONTAINER_BIN, args, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (err) => reject(err));
    child.on("exit", (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 1);
    });
  });
}
