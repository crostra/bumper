import { existsSync, readdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type AgentId = "claude" | "codex" | "cursor" | "antigravity" | "grok";

export interface AgentDescriptor {
  id: AgentId;
  name: string;
  shortName: string;
  description: string;
  command: string[] | null;
  detected: boolean;
  installUrl: string;
  nativePolicy: "hook" | "sandbox";
  readPaths: string[];
  /** Command expected inside a Room image. The image must provide it. */
  roomCommand: string[];
  /**
   * Flags that turn off this CLI's own approval prompts, verified against the
   * recommended Sandbox image (`<cli> --help`). Empty means Bumper has no verified
   * flag for that tool — the UI must say so instead of guessing.
   */
  autoApproveArgs: string[];
  /**
   * Env the tool requires before it will accept those flags. Claude Code refuses
   * --dangerously-skip-permissions as root unless IS_SANDBOX=1; the room is
   * exactly the sandbox that assertion is about.
   */
  autoApproveEnv: Record<string, string>;
}

interface AgentDefinition {
  id: AgentId;
  name: string;
  shortName: string;
  description: string;
  commands: string[];
  candidates: () => string[];
  installUrl: string;
  nativePolicy: "hook" | "sandbox";
  roomCommand: string[];
  autoApproveArgs: string[];
  autoApproveEnv: Record<string, string>;
}

const home = homedir();

function claudeCandidates(): string[] {
  const found: string[] = [];
  const versions = join(home, ".nodenv", "versions");
  try {
    for (const version of readdirSync(versions).sort().reverse()) {
      const cli = join(versions, version, "bin", "claude");
      const node = join(versions, version, "bin", "node");
      if (existsSync(cli) && existsSync(node)) found.push(`${node}\0${realpathSync(cli)}`);
    }
  } catch { /* optional version manager */ }
  return [
    ...found,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".volta", "bin", "claude"),
  ];
}

const DEFINITIONS: AgentDefinition[] = [
  {
    id: "claude", name: "Claude Code", shortName: "Claude", nativePolicy: "hook",
    description: "Anthropic's coding agent",
    commands: ["claude"], candidates: claudeCandidates,
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/overview",
    roomCommand: ["claude"],
    autoApproveArgs: ["--dangerously-skip-permissions"],
    // Verified in the Sandbox image: without this the CLI refuses the flag as root.
    autoApproveEnv: { IS_SANDBOX: "1" },
  },
  {
    id: "codex", name: "ChatGPT Codex", shortName: "Codex", nativePolicy: "hook",
    description: "OpenAI's coding agent",
    commands: ["codex"], candidates: () => [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/opt/homebrew/bin/codex", "/usr/local/bin/codex", join(home, ".local", "bin", "codex"),
    ],
    installUrl: "https://developers.openai.com/codex/cli/",
    roomCommand: ["codex"],
    autoApproveArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    autoApproveEnv: {},
  },
  {
    id: "cursor", name: "Cursor Agent", shortName: "Cursor", nativePolicy: "sandbox",
    description: "Cursor's terminal coding agent",
    commands: ["cursor-agent", "agent"], candidates: () => [
      join(home, ".local", "bin", "cursor-agent"), join(home, ".local", "bin", "agent"),
      "/opt/homebrew/bin/cursor-agent", "/usr/local/bin/cursor-agent",
    ],
    installUrl: "https://cursor.com/docs/cli/overview",
    roomCommand: ["cursor-agent"],
    autoApproveArgs: ["--force"],
    autoApproveEnv: {},
  },
  {
    id: "antigravity", name: "Antigravity", shortName: "Antigravity", nativePolicy: "sandbox",
    description: "Google Antigravity CLI or IDE",
    commands: ["agy"], candidates: () => [
      join(home, ".local", "bin", "agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy",
      "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide",
    ],
    installUrl: "https://antigravity.google/docs/cli-getting-started",
    roomCommand: ["agy"],
    autoApproveArgs: ["--dangerously-skip-permissions"],
    autoApproveEnv: {},
  },
  {
    id: "grok", name: "Grok Build", shortName: "Grok", nativePolicy: "sandbox",
    description: "xAI's coding agent",
    commands: ["grok"], candidates: () => [
      join(home, ".local", "bin", "grok"), join(home, ".grok", "bin", "grok"),
      "/opt/homebrew/bin/grok", "/usr/local/bin/grok",
    ],
    installUrl: "https://docs.x.ai/build/overview",
    roomCommand: ["grok"],
    autoApproveArgs: ["--always-approve"],
    autoApproveEnv: {},
  },
];

function which(command: string): string | undefined {
  try {
    const result = execFileSync("/usr/bin/which", [command], {
      encoding: "utf8", timeout: 1200, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return result && existsSync(result) ? result : undefined;
  } catch { return undefined; }
}

function resolveCommand(definition: AgentDefinition): string[] | null {
  for (const candidate of definition.candidates()) {
    if (candidate.includes("\0")) {
      const command = candidate.split("\0");
      if (command.every(existsSync)) return command;
      continue;
    }
    if (existsSync(candidate)) return [candidate];
  }
  for (const name of definition.commands) {
    const path = which(name);
    if (path) return [path];
  }
  return null;
}

function commandReadPaths(command: string[]): string[] {
  const paths = new Set<string>();
  for (const item of command) {
    if (!item.startsWith("/")) continue;
    paths.add(dirname(item));
    let path = item;
    try { path = realpathSync(item); } catch { /* keep path */ }
    paths.add(dirname(path));
    if (path.startsWith(join(home, ".nodenv", "versions"))) paths.add(resolve(path, "../../.."));
    if (path.startsWith(join(home, ".local", "share"))) paths.add(join(home, ".local", "share"));
    if (path.startsWith(join(home, ".grok"))) paths.add(join(home, ".grok"));
  }
  return [...paths];
}

/**
 * Detection cache.
 *
 * `detectAgents()` shells out once per agent for `--version` (execFileSync, 1.5 s
 * timeout each), so an uncached call costs ~1.4 s. `/api/state` used to call it three
 * times per request, which made the whole control plane feel like it was hanging.
 * Installed CLIs do not change mid-session often, so a short TTL is plenty.
 */
let detectCache: { at: number; agents: AgentDescriptor[] } | null = null;
const DETECT_TTL_MS = 30_000;

/** Drop the cache — call after anything that installs or removes a vendor CLI. */
export function invalidateAgentDetection(): void {
  detectCache = null;
}

export function detectAgents(): AgentDescriptor[] {
  const now = Date.now();
  if (detectCache && now - detectCache.at < DETECT_TTL_MS) return detectCache.agents;
  const agents = detectAgentsUncached();
  detectCache = { at: now, agents };
  return agents;
}

function detectAgentsUncached(): AgentDescriptor[] {
  return DEFINITIONS.map((definition) => {
    const command = resolveCommand(definition);
    return {
      id: definition.id,
      name: definition.name,
      shortName: definition.shortName,
      description: definition.description,
      command,
      detected: command !== null,
      installUrl: definition.installUrl,
      nativePolicy: definition.nativePolicy,
      readPaths: command ? commandReadPaths(command) : [],
      roomCommand: definition.roomCommand,
      autoApproveArgs: definition.autoApproveArgs,
      autoApproveEnv: definition.autoApproveEnv,
    };
  });
}

export function getAgent(id: string): AgentDescriptor | undefined {
  return detectAgents().find((agent) => agent.id === id);
}

/** Verified auto-approve flags for a tool. Empty = Bumper has none for it. */
export function autoApproveArgsFor(id: string): string[] {
  return DEFINITIONS.find((definition) => definition.id === id)?.autoApproveArgs ?? [];
}

export function supportsAutoApprove(id: string): boolean {
  return autoApproveArgsFor(id).length > 0;
}

/** Env the tool needs before it accepts its auto-approve flags. */
export function autoApproveEnvFor(id: string): Record<string, string> {
  return { ...(DEFINITIONS.find((definition) => definition.id === id)?.autoApproveEnv ?? {}) };
}

/**
 * Codex's default browser login uses localhost redirect and fails inside a
 * Room (vendor 500). Device auth is the only code-display flow that works.
 * When no credential is present, Bumper launches `codex login --device-auth`
 * instead of the normal agent command (Phase 9-1c / terminal-login-canonical §4.7).
 */
export function forceCodexDeviceAuthLogin(agentId: string, credentialPresent: boolean): boolean {
  return agentId === "codex" && !credentialPresent;
}

/**
 * Compose the in-room command line. Pure so both the CLI and the UI preview
 * show the identical string — the user can always read what will run.
 *
 * User-supplied args win: if they already passed the auto-approve flag (or any
 * conflicting permission flag), Bumper does not add a second one.
 *
 * bumperArgs are Bumper's own wiring (today: the MCP Hub bridge registration).
 * They go before the user's args so an explicit user flag still has the last
 * word, and they are dropped for device-auth login like everything else.
 *
 * forceDeviceAuthLogin (codex only) wins over auto-approve flags and agentArgs:
 * login is not a coding session, so never inject approval bypass onto it.
 */
export function composeRoomCommand(opts: {
  agentId: string;
  roomCommand: string[];
  autoApprove: boolean;
  agentArgs?: string[];
  /** Bumper-injected flags (MCP Hub registration). Never user-supplied. */
  bumperArgs?: string[];
  /** When true and agent is codex, emit device-auth login only. */
  forceDeviceAuthLogin?: boolean;
}): string[] {
  if (opts.forceDeviceAuthLogin && opts.agentId === "codex") {
    return ["codex", "login", "--device-auth"];
  }
  const userArgs = opts.agentArgs ?? [];
  const flags = opts.autoApprove ? autoApproveArgsFor(opts.agentId) : [];
  const conflicts = new Set(["--permission-mode", "--approval-policy", "--sandbox"]);
  const userHasOwnPolicy = userArgs.some(
    (arg) => flags.includes(arg) || conflicts.has(arg.split("=")[0]!),
  );
  const applied = userHasOwnPolicy ? [] : flags;
  return [...opts.roomCommand, ...applied, ...(opts.bumperArgs ?? []), ...userArgs];
}
