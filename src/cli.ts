#!/usr/bin/env node
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, ensureConfig, EXAMPLE_CONFIG } from "./config.js";
import { ConfigSchema } from "./types.js";
import { writeConfigJson } from "./config-store.js";
import { resolveConfigPath } from "./paths.js";
import { getActiveContext, setActiveContext } from "./state.js";
import { resolveActiveContext, startProxy } from "./proxy.js";
import { startApp } from "./app.js";
import { runHook } from "./hook.js";
import { installClaude } from "./install.js";
import { readEvents, todayCounts } from "./log.js";
import { runSandboxed } from "./sandbox.js";
import { applyRule, inferSpecFromString, lastBlockedSpec } from "./rules.js";
import {
  buildProjectStatusSnapshot,
  formatProjectStatus,
  isCliAgentCommand,
  listCliAgentAliases,
  parseProjectFlag,
  resolveCliAgentId,
  resolveProjectForCli,
  resolveProjectForStatus,
  runCliRoomAgent,
} from "./cli-room.js";
import {
  applyCreatedProject,
  defaultProjectNameFromCwd,
  projectAccessRoots,
  resolveProjectNameForAccessEdit,
  setProjectAccessWorkspace,
} from "./project.js";
import {
  buildDoctorReport,
  collectDoctorFacts,
  formatDoctorReport,
} from "./doctor.js";
import { isOperationError } from "./operations/error.js";
import { ensureContainerSystem } from "./operations/container-system.js";
import {
  listEgressTemplates,
  networkLabel,
  networkSentence,
  NETWORK_VERBS,
  setProjectNetwork,
} from "./operations/network.js";
import {
  accessLabel,
  addProjectFolder,
  applyFolderPatch,
  describeProjectFolders,
  describeShareRow,
  removeProjectFolder,
} from "./operations/folders.js";
import { createProject, deleteProject, listProjects } from "./operations/project.js";
import { leaseSessionRefs } from "./operations/running-sessions.js";
import { describeProjectGit, listGitSessions, setGitSessionAccess } from "./operations/git.js";
import {
  bindProjectMcp,
  describeProjectMcp,
  listMcpConnections,
  MCP_OUTSIDE_SANDBOX_NOTE,
  unbindProjectMcp,
} from "./operations/mcp.js";
import {
  describeFeedback,
  describeRecovery,
  exportEvents,
  performUninstall,
  previewUninstall,
  restoreBackup,
} from "./operations/lifecycle.js";
import { proveProject, proveSealedRoom } from "./operations/prove.js";
import {
  bindProjectRepository,
  GITHUB_APP_BROWSER_REASON,
  listGitHubConnections,
  storedInstallations,
  summarizeRefresh,
  unbindProjectRepository,
} from "./operations/github.js";
import { applySetupToProject, deleteSetup, listSetups, saveSetup } from "./operations/setups.js";
import { listDevelopmentSessions, setDevelopmentSessionAccess } from "./operations/development.js";
import { describePrefs, retentionSentence, setPref } from "./operations/prefs.js";
import { listStoredLogins, removeStoredLogin } from "./operations/logins.js";
import { withGitBindings } from "./git-repositories.js";
import type { Config } from "./types.js";

/** Reported in `bumper feedback` so an issue names the build it came from. */
const BUMPER_VERSION = "0.6.0";
import {
  buildRecommendedRoomImage,
  inspectRecommendedRoomRecipe,
  RECOMMENDED_ROOM_IMAGE,
  RECOMMENDED_ROOM_RECIPE,
  verifyRecommendedRoomAuthOverlay,
} from "./room/setup.js";
import { AppleContainerBackend } from "./room/apple-container.js";
import {
  applyExternalMcpConfig,
  buildExternalMcpSnippet,
  EXTERNAL_MCP_MODE_LABEL,
  previewExternalMcpConfig,
  rollbackExternalMcpConfig,
} from "./mcp-hub.js";
import { homedir } from "node:os";

const HELP = `bumper — keep your AI inside the Project cage you picked.

Start here (CLI-only, no Mac app needed):
  brew install container      Apple container (once; Bumper starts its services for you)
  bumper doctor               Container / Node / Sandbox image / Access in one screen
  bumper init                 Create a Sandbox Project for this folder (writes the user config)
  bumper room-image build     Build the recommended AI Sandbox image
  bumper network off          Cut the Sandbox off the internet (or: allowed / open)
  bumper [-p project] <cli>   Launch the AI CLI in that Sandbox, on this TTY

Usage:
  bumper [-p project] <cli>   Launch AI CLI in a Sandbox on this TTY (claude|codex|cursor|agy|grok|…)
  bumper doctor [-p project]  Diagnose prerequisites; prints the next command.
                              --quick skips the image probe · --no-start leaves stopped services alone
  bumper status [-p project]  Show Project cage summary (Access, image, egress, tools) — no session
  bumper project list|create <name>|remove <name>   Projects without opening the app
  bumper folders list [-p project]         What this Project shares with the Sandbox
  bumper folders add <path> [--read-only]  Share the project folder (.), a subfolder, or ~/anywhere
  bumper folders remove <path>             Stop sharing a folder
  bumper access set [-p project] [folder]   Bind workspace as primary Access root (cwd resolve)
  bumper access show [-p project]          List Access roots for a Project
  bumper network off|allowed|open [-p project]   Set what the Sandbox can reach (new Sessions)
  bumper network allowed <host…> [--template <id>…]   Allowed-only list (templates: anthropic, openai, …)
  bumper network show [-p project]         Current mode, list, and available templates
  bumper room-image build [-p project] [--force]   Build recommended Sandbox image (materialize_path_bin)
  bumper room-image verify    Probe PATH CLIs under empty auth overlays (no rebuild)
  bumper init [--legacy]      Create a Sandbox Project for this folder (--legacy: old host MCP-proxy example)
  bumper contexts             List contexts / projects (marks the active one)
  bumper use <context>        Switch the active context
  bumper allow [last|<rule>]  Allow the last blocked action (or a rule) in the active context
  bumper deny <rule>          Block a rule in the active context
  bumper run -- <cmd...>      Launch a command inside the OS sandbox for the active context
  bumper prove [-p project] [--sealed]  Run the real Sandbox and try to break out of it
  bumper git status|sessions [-p project]   Project Git access; live Sessions and their access
  bumper git repo add <url> [--access read|write|pr|workflow]   Bind a repository
  bumper git off|read|write <session-id>   Change one live Session (write = 15 minutes)
  bumper github list|connect|refresh|disconnect   GitHub Apps (connect opens a local page)
  bumper setup list|save|apply|remove   Reuse one Project's boundary on another
  bumper dev sessions|preview|docker    Local Preview / Docker for a live Session
  bumper login list|remove <tool>       Stored AI logins (sign-in happens in the Sandbox)
  bumper prefs [<key> <value>]          Local preferences, including event retention
  bumper mcp list|show|bind|unbind     Library MCP Connections and what a Project binds
  bumper backup list|restore <id>      Config backups (the way back from a bad edit)
  bumper uninstall [--dry-run|--yes]   Remove Bumper's own state; never your folders
  bumper feedback [--bug] [--open]     Where to say what you hit (no telemetry)
  bumper mcp connect --project <id>   Stdio MCP Hub bridge for one Project (secrets stay in Bumper)
  bumper mcp client-config --project <id> [--path file] [--apply|--rollback <backup>]
                              External MCP client snippet (MCP-only — files/shell/network not protected)
  bumper app                  Open the Bumper app (local, live view of contexts + records)
  bumper install-claude [dir] Wire bumper into Claude Code for a project (MCP + native hook)
  bumper client-config        Print the MCP + hook snippets (manual setup / other clients)
  bumper log [--blocked] [--export]   The audit record; --export prints JSON to keep
  bumper hook                 (internal) PreToolUse hook target that enforces native tools

Sandbox entry (primary):
  bumper grok                 Resolve Project (cwd Access / -p) → readiness → TTY-attach Sandbox
  bumper -p Demo claude       Explicit project
  If anything is missing: bumper doctor  names it and prints the next command.
  If Access roots are empty: bumper access set  (or app Projects → Access) before cwd resolve works.
  If readiness fails, Sandbox is NOT started; missing items and next commands are printed.
  Host vendor CLIs are not required — the CLI inside the Sandbox image is canonical.
  Older bumper/ai-room:latest may hide grok under auth mounts — rebuild: bumper room-image build --force.

Config resolution: $BUMPER_CONFIG → ./bumper.config.json → ~/.bumper/config.json
`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/**
 * Adapter for src/operations: turn a coded failure into a sentence plus the
 * next command. Operations never print — this is the only place a CLI message
 * is built from one, so a new operation gets consistent output for free.
 */
function failFromOperation(err: unknown): never {
  if (isOperationError(err)) {
    fail([err.message, ...(err.fix.length ? ["", "Next:", ...err.fix.map((line) => `  ${line}`)] : [])].join("\n"));
  }
  fail((err as Error).message);
}

/**
 * Phase 5 (W1-0): `bumper init` creates a Sandbox Project, not a legacy host
 * MCP example.
 *
 * The old example wrote `backends` / `policies` / `writePaths` into
 * ./bumper.config.json — the pre-Sandbox host-proxy model. For someone whose
 * only entry point is `npm i -g`, that config contradicts every other command
 * (`status`, `access`, `<cli>`) and shadows the real store when they later run
 * from that folder. It now lives behind `--legacy`.
 *
 * The Sandbox path writes to the resolved config path — the same store the app,
 * `bumper access set`, and `bumper status` read — and composes the Project with
 * applyCreatedProject so there is exactly one definition of "a new Project".
 */
async function cmdInit(argv: string[]): Promise<void> {
  const legacy = argv.includes("--legacy");
  const rest = argv.filter((a) => a !== "--legacy");
  if (rest.length) {
    fail(`Unexpected arguments: ${rest.join(" ")}\nUsage: bumper init [--legacy]`);
  }
  if (legacy) return cmdInitLegacy();

  const target = resolveConfigPath();
  if (existsSync(target)) {
    fail(
      [
        `Refusing to overwrite existing ${target}`,
        "",
        "Next:",
        "  bumper doctor           # what is missing before a Sandbox can start",
        "  bumper access set       # bind this folder to a Project",
        "  bumper status           # Project cage summary",
      ].join("\n"),
    );
  }

  // The new Project's image comes from `initialRoomImage()`, which probes the
  // local image list. With the services stopped that probe fails and a Project
  // that could have used the recommended image silently starts on a base image
  // with no AI CLIs in it — so settle the services first, as doctor does.
  const system = ensureContainerSystem();
  if (system.started) {
    console.log("Apple container services were stopped — started them (stop again: container system stop)");
  }

  const workspace = process.cwd();
  const name = defaultProjectNameFromCwd(workspace);
  const config = ConfigSchema.parse({});
  applyCreatedProject(config, { name, workspace });
  writeConfigJson(target, config);

  const project = config.contexts[name]!;
  console.log(`Created ${target}`);
  console.log(`Project "${name}"`);
  console.log(`  Folder shared with the Sandbox: ${project.workspace}`);
  console.log(`  Network: ${project.room?.egress === "blocked" ? "Off" : project.room?.egress === "allowlist" ? "Allowed only" : "Open"}`);
  console.log(`  Sandbox image: ${project.room?.image}`);
  console.log("");
  console.log("Nothing outside that folder is shared. Bumper never invents a home-wide door.");
  console.log("");
  // Only tell them to build an image they do not already have.
  const needsImage = project.room?.image !== RECOMMENDED_ROOM_IMAGE;
  console.log("Next:");
  console.log("  1. bumper doctor            # container / Node / image / Access in one screen");
  if (needsImage) {
    console.log("  2. bumper room-image build  # build the AI Sandbox image (first run takes a while)");
  }
  console.log(`  ${needsImage ? 3 : 2}. bumper -p "${name}" claude   # protected launch on this TTY (claude|codex|cursor|agy|grok)`);
}

/** The pre-Sandbox host-proxy example. Kept for existing MCP-proxy setups. */
function cmdInitLegacy(): void {
  const target = resolve(process.cwd(), "bumper.config.json");
  if (existsSync(target)) fail(`Refusing to overwrite existing ${target}`);
  writeFileSync(target, JSON.stringify(EXAMPLE_CONFIG, null, 2) + "\n");
  console.log(`Created ${target}  (legacy host MCP-proxy example)`);

  // Make the example runnable out of the box: the demo filesystem backend
  // points at /tmp/bumper-demo, which must exist for the server to start.
  try {
    const demoDir = "/tmp/bumper-demo";
    mkdirSync(demoDir, { recursive: true });
    const sample = join(demoDir, "note.txt");
    if (!existsSync(sample)) writeFileSync(sample, "hello from the bumper demo\n");
  } catch {
    /* best effort — quickstart still works once the user sets real backends */
  }
  console.log("");
  console.log("This is the MCP-proxy model: it protects MCP tool calls only.");
  console.log("Files, shell, and network are NOT Bumper-protected on this path.");
  console.log("For the Sandbox boundary, delete this file and run: bumper init");
}

/** `bumper prove` — run the real Sandbox and try to break out of it. */
async function cmdProve(argv: string[]): Promise<void> {
  const sealed = argv.includes("--sealed");
  const filtered = argv.filter((a) => a !== "--sealed");
  let projectFlag: string | undefined;
  let rest: string[];
  try {
    ({ projectFlag, rest } = parseProjectFlag(filtered));
  } catch (err) {
    fail((err as Error).message);
  }
  if (rest.length) fail(`Unexpected arguments: ${rest.join(" ")}\nUsage: bumper prove [-p project] [--sealed]`);

  const system = ensureContainerSystem();
  if (system.started) {
    console.log("Apple container services were stopped — started them (stop again: container system stop)");
  }

  if (sealed) {
    console.log("Prove it — a disposable Sandbox that touches none of your folders.");
    console.log("");
    const result = await proveSealedRoom();
    if (!result.available) {
      fail(`Cannot run the proof — ${result.detail}\n\nNext:\n  container system start\n  If \`container\` is missing: brew install container`);
    }
    for (const probe of result.results) {
      console.log(`  ${probe.contained ? "✓" : "✗"} ${probe.title}`);
      console.log(`      ${probe.evidence}`);
    }
    const failed = result.results.filter((probe) => !probe.contained).length;
    console.log("");
    console.log(failed === 0
      ? `${result.results.length}/${result.results.length} matched. The walls held.`
      : `${failed} of ${result.results.length} did NOT behave as promised. Do not rely on this boundary.`);
    process.exit(failed === 0 ? 0 : 1);
  }

  const { config } = loadConfig();
  const projectName = projectForEdit(config, projectFlag);
  let result;
  try {
    result = await proveProject({ config, projectName });
  } catch (err) {
    failFromOperation(err);
  }

  console.log(`Prove it — Project "${result.projectName}"`);
  console.log(`  Folder: ${result.workspace}`);
  if (result.image) console.log(`  Image: ${result.image}`);
  console.log("");
  if (!result.available) {
    fail(`Cannot run the proof — ${result.detail}\n\nNext:\n  container system start`);
  }
  for (const probe of result.results) {
    console.log(`  ${probe.pass ? "✓" : "✗"} ${probe.title}`);
    console.log(`      expected ${probe.expect} · observed ${probe.observed}`);
    console.log(`      ${probe.evidence}`);
  }
  console.log("");
  console.log(result.allMatch
    ? `${result.passed}/${result.total} matched the boundary this Project promises.`
    : `${result.total - result.passed} of ${result.total} did NOT match. This Project is marked as failing until it does.`);
  if (result.launchBlocked) {
    console.log("Protected launch is blocked for this Project until the checks match.");
  }
  process.exit(result.allMatch ? 0 : 1);
}

/** `bumper github connect|list|refresh|disconnect` — the owner-level surface. */
async function cmdGitHub(argv: string[]): Promise<void> {
  const usage = [
    "Usage: bumper github list                    Owners Bumper can reach",
    "       bumper github connect [--org <name>]  Create a GitHub App (opens a local page)",
    "       bumper github refresh [<connection>]  Re-read installations and repositories",
    "       bumper github disconnect <connection>",
  ].join("\n");

  const [sub, ...rest] = argv;
  if (!sub) fail(usage);

  const { GitHubAppService } = await import("./github-app.js");
  const service = new GitHubAppService();
  const isConnected = (id: string) => service.forConnection(id).connected();

  if (sub === "list") {
    const { config } = loadConfig();
    const connections = listGitHubConnections(config, isConnected);
    if (connections.length === 0) {
      console.log("No GitHub connections yet.");
      console.log("");
      console.log("Create one: bumper github connect");
      console.log(GITHUB_APP_BROWSER_REASON);
      return;
    }
    for (const connection of connections) {
      console.log(`${connection.connected ? "●" : " "} ${connection.ownerLogin || connection.id}  (${connection.ownerType || "?"})`);
      console.log(`    id: ${connection.id}`);
      for (const installation of connection.installations) {
        console.log(`    installation ${installation.id} → ${installation.accountLogin}  ${installation.repositorySelection}  ${installation.repositoryCount} repo(s)`);
      }
    }
    return;
  }

  if (sub === "connect") {
    let organization = "";
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--org" || arg === "--organization") organization = rest[++i] ?? "";
      else if (arg.startsWith("--org=")) organization = arg.slice("--org=".length);
      else fail(`Unknown option "${arg}".\n\n${usage}`);
    }

    /*
     * The manifest flow is not reimplemented here. Bumper starts the same local
     * server the app uses and prints its URL, so there is exactly one
     * implementation of a flow that mints a private key.
     */
    console.log(GITHUB_APP_BROWSER_REASON);
    console.log("");
    const { config } = ensureConfig();
    const handle = await startApp(config, () => loadConfig().config, resolve(process.argv[1]));
    try {
      const response = await fetch(`${handle.url}/api/github/connect`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: handle.url },
        body: JSON.stringify(organization
          ? { accountType: "organization", organization }
          : { accountType: "personal" }),
      });
      const payload = await response.json() as { startUrl?: string; error?: string; expiresAt?: number };
      if (!response.ok || !payload.startUrl) {
        fail(`GitHub connect could not start: ${payload.error ?? response.status}`);
      }
      console.log("Open this on this Mac, then finish on GitHub:");
      console.log("");
      console.log(`  ${payload.startUrl}`);
      console.log("");
      if (argv.includes("--open")) {
        const { spawn } = await import("node:child_process");
        spawn("open", [payload.startUrl!], { stdio: "ignore", detached: true }).unref();
      }
      console.log("Waiting for GitHub to hand the App back… (Ctrl-C to stop)");

      const before = new Set(Object.keys(loadConfig().config.githubApps ?? {}));
      const deadline = payload.expiresAt ?? Date.now() + 15 * 60_000;
      let added: string | undefined;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const apps = loadConfig().config.githubApps ?? {};
        added = Object.keys(apps).find((id) => !before.has(id) || isConnected(id));
        if (added && isConnected(added)) break;
        added = undefined;
      }
      if (!added) {
        fail("Timed out waiting for GitHub. Re-run: bumper github connect");
      }
      const app = loadConfig().config.githubApps?.[added!];
      console.log("");
      console.log(`Connected: ${app?.ownerLogin ?? added} (${added})`);
      console.log("The App's private key stays in your Keychain and never enters a Sandbox.");
      console.log("");
      console.log("Next:");
      console.log("  bumper git repo add https://github.com/owner/repo --access read");
    } finally {
      await handle.close();
    }
    return;
  }

  if (sub === "refresh") {
    const { path, config } = loadConfig();
    const ids = rest.length ? rest : Object.keys(config.githubApps ?? {});
    if (ids.length === 0) fail("No GitHub connections to refresh.\n\nCreate one: bumper github connect");
    for (const id of ids) {
      try {
        const fetched = await service.forConnection(id).installations();
        const app = config.githubApps?.[id];
        if (app) {
          app.installations = storedInstallations(fetched) as typeof app.installations;
          app.lastRefreshedAt = new Date().toISOString();
        }
        const summary = summarizeRefresh(id, fetched);
        console.log(`${id}: ${summary.installations} installation(s), ${summary.repositories} repositor${summary.repositories === 1 ? "y" : "ies"}${summary.allRepositories ? " (All repositories)" : ""}`);
      } catch (err) {
        console.error(`${id}: ${(err as Error).message}`);
      }
    }
    saveConfigFile(path, config);
    console.log("");
    console.log("Bind a repository: bumper git repo add <url> --access read");
    return;
  }

  if (sub === "disconnect") {
    const id = rest[0];
    if (!id || rest.length > 1) fail("Usage: bumper github disconnect <connection-id>");
    const { path, config } = loadConfig();
    if (!config.githubApps?.[id]) fail(`Unknown connection "${id}".\n\nbumper github list`);
    try {
      await service.forConnection(id).disconnect();
    } catch (err) {
      console.error(`Revoke reported: ${(err as Error).message}`);
    }
    const apps = { ...config.githubApps };
    delete apps[id];
    config.githubApps = apps;
    for (const context of Object.values(config.contexts)) {
      const bindings = (context.gitRepositories ?? []).filter((row) => row.connectionId !== id);
      Object.assign(context, withGitBindings(context, bindings));
    }
    saveConfigFile(path, config);
    console.log(`Disconnected ${id}. Projects that bound its repositories no longer do.`);
    return;
  }

  fail(usage);
}

/** `bumper git status|sessions|off|read|write` — Git access, including live Sessions. */
async function cmdGit(argv: string[]): Promise<void> {
  const usage = [
    "Usage: bumper git status [-p project]      What this Project may reach on GitHub",
    "       bumper git repo add <url> [--access read|write|pr|workflow] [-p project]",
    "       bumper git repo remove <owner/repo> [-p project]",
    "       bumper git sessions [-p project]    Live Sessions and their current access",
    "       bumper git off|read|write <session-id>   Change one live Session (write = 15 min)",
  ].join("\n");

  let projectFlag: string | undefined;
  let rest: string[];
  try {
    ({ projectFlag, rest } = parseProjectFlag(argv));
  } catch (err) {
    fail((err as Error).message);
  }
  const [sub, ...args] = rest;
  if (!sub) fail(usage);

  const { path, config } = loadConfig();

  if (sub === "repo") {
    const [verb, ...repoArgs] = args;
    if (verb !== "add" && verb !== "remove" && verb !== "rm") fail(usage);
    let capability = "read";
    const positional: string[] = [];
    for (let i = 0; i < repoArgs.length; i++) {
      const arg = repoArgs[i]!;
      if (arg === "--access" || arg === "-a") capability = repoArgs[++i] ?? "";
      else if (arg.startsWith("--access=")) capability = arg.slice("--access=".length);
      else if (arg.startsWith("-")) fail(`Unknown option "${arg}".\n\n${usage}`);
      else positional.push(arg);
    }
    const repository = positional[0];
    if (!repository || positional.length > 1) fail(usage);

    const projectName = projectForEdit(config, projectFlag);
    const { GitHubAppService } = await import("./github-app.js");
    const service = new GitHubAppService();

    if (verb === "add") {
      let result;
      try {
        result = bindProjectRepository({
          config, projectName, repository, capability,
          isConnected: (id) => service.forConnection(id).connected(),
        });
      } catch (err) {
        failFromOperation(err);
      }
      saveConfigFile(path, config);
      console.log(`Project "${projectName}" now binds ${result.fullName} at ${result.capability}`);
      console.log("");
      console.log("Bound repositories:");
      for (const binding of result.bindings) {
        console.log(`  · ${binding.fullName.padEnd(36)} ${binding.capability}`);
      }
      console.log("");
      console.log("GitHub enforces that level. The token is minted per Session and revoked when it ends.");
      return;
    }

    let removed;
    try {
      removed = unbindProjectRepository({ config, projectName, repository });
    } catch (err) {
      failFromOperation(err);
    }
    saveConfigFile(path, config);
    console.log(`Project "${projectName}" no longer binds ${removed.fullName}`);
    return;
  }

  if (sub === "status") {
    const projectName = projectForEdit(config, projectFlag);
    let view;
    try {
      view = describeProjectGit(config, projectName);
    } catch (err) {
      failFromOperation(err);
    }
    console.log(`Project: ${view.projectName}`);
    console.log(`Highest Git access this Project allows: ${view.ceiling}`);
    if (view.bindings.length === 0) {
      console.log("Repositories: (none bound)");
      console.log("");
      console.log("Bind one in the Bumper app → Project → Git. Creating a GitHub App needs a browser form,");
      console.log("which is GitHub's flow, not Bumper's.");
    } else {
      console.log("Repositories:");
      for (const binding of view.bindings) {
        console.log(`  · ${binding.fullName.padEnd(36)} ${binding.capability}`);
      }
    }
    console.log("");
    console.log("GitHub enforces repository and contents scope. Bumper does not inspect git commands.");
    return;
  }

  if (sub === "sessions") {
    const projectName = projectFlag ? projectForEdit(config, projectFlag) : undefined;
    const sessions = listGitSessions(config, projectName);
    if (sessions.length === 0) {
      console.log("No Git Sessions. A Session exists while an AI CLI is running.");
      return;
    }
    for (const session of sessions) {
      console.log(`${session.live ? "●" : " "} ${session.id}`);
      console.log(`    Project: ${session.projectName}  ·  ${session.agentName}`);
      console.log(`    Repositories: ${session.repository || "(none)"}`);
      console.log(`    Access now: ${session.effectiveAccess}${session.writeUntil ? `  (write until ${session.writeUntil})` : ""}`);
    }
    console.log("");
    console.log("Change one: bumper git off|read|write <session-id>");
    return;
  }

  if (sub !== "off" && sub !== "read" && sub !== "write") fail(usage);
  const sessionId = args[0];
  if (!sessionId || args.length > 1) fail(usage);

  const { GitHubAppService } = await import("./github-app.js");
  let result;
  try {
    result = await setGitSessionAccess({
      config,
      sessionId,
      action: sub === "off" ? "disable" : sub,
      revokeSession: (connectionId, id) => new GitHubAppService().forConnection(connectionId).revokeSession(id),
    });
  } catch (err) {
    failFromOperation(err);
  }
  console.log(`Session ${result.sessionId} (${result.projectName}) → ${result.effectiveAccess}`);
  if (result.writeUntil) console.log(`  Write until ${result.writeUntil}`);
  if (result.revoked) console.log(`  Revoked ${result.revoked} token${result.revoked === 1 ? "" : "s"} the Session was holding.`);
  if (result.pendingConnections.length) {
    console.log(`  Could not reach GitHub for: ${result.pendingConnections.join(", ")} — a later sweep retries.`);
  }
  console.log("This takes effect for the running Session immediately.");
}

/** `bumper mcp list|show|bind|unbind` alongside the existing bridge subcommands. */
function cmdMcpBindings(argv: string[], projectFlag?: string): boolean {
  const { path, config } = loadConfig();
  const [sub, ...args] = argv;

  if (sub === "list") {
    const connections = listMcpConnections(config);
    if (connections.length === 0) {
      console.log("No MCP Connections in the Library.");
      console.log("Add one in the Bumper app → Library → MCP (it holds the server command and its secrets).");
      return true;
    }
    for (const connection of connections) {
      console.log(`${connection.id}`);
      console.log(`    ${connection.name}  ·  ${connection.integrationName}`);
      if (connection.boundTo.length) console.log(`    Bound to: ${connection.boundTo.join(", ")}`);
    }
    console.log("");
    console.log(MCP_OUTSIDE_SANDBOX_NOTE);
    return true;
  }

  if (sub === "show") {
    const projectName = projectForEdit(config, projectFlag);
    let view;
    try {
      view = describeProjectMcp(config, projectName);
    } catch (err) {
      failFromOperation(err);
    }
    console.log(`Project: ${view.projectName}`);
    if (view.bindings.length === 0) {
      console.log("MCP Connections bound: (none)");
    } else {
      console.log("MCP Connections bound:");
      for (const binding of view.bindings) {
        console.log(`  · ${binding.connectionName}  (${binding.connectionId})`);
      }
    }
    console.log("");
    console.log("Reaches the Sandbox for:");
    for (const agent of view.reachedBy) {
      console.log(`  ${agent.supported ? "✓" : "·"} ${agent.agentId.padEnd(12)} ${agent.detail}`);
    }
    console.log("");
    console.log(view.note);
    return true;
  }

  if (sub === "bind" || sub === "unbind") {
    const connectionId = args[0];
    if (!connectionId || args.length > 1) {
      fail(`Usage: bumper mcp ${sub} <connection-id> [-p project]`);
    }
    const projectName = projectForEdit(config, projectFlag);
    let message: string;
    try {
      if (sub === "bind") {
        const result = bindProjectMcp({ config, projectName, connectionId });
        message = `Project "${projectName}" now binds ${result.connectionName} (${result.connectionId})`
          + (result.replaced ? `\n  Replaced ${result.replaced} for the same integration.` : "");
      } else {
        const result = unbindProjectMcp({ config, projectName, connectionId });
        message = `Project "${projectName}" no longer binds ${result.connectionId}`;
      }
    } catch (err) {
      failFromOperation(err);
    }
    saveConfigFile(path, config);
    console.log(message);
    console.log("");
    console.log(MCP_OUTSIDE_SANDBOX_NOTE);
    console.log("Applies to new Sessions.");
    return true;
  }

  return false;
}

/** `bumper setup list|save|apply|remove` — reuse one Project's boundary on another. */
function cmdSetup(argv: string[], projectFlag?: string): void {
  const usage = [
    "Usage: bumper setup list",
    "       bumper setup save <name> [-p project] [--description <text>]",
    "       bumper setup apply <name> [-p project]",
    "       bumper setup remove <name>",
  ].join("\n");

  const [sub, ...args] = argv;
  const { path, config } = loadConfig();

  if (!sub || sub === "list") {
    for (const setup of listSetups(config)) {
      console.log(`${setup.builtin ? "·" : " "} ${setup.name.padEnd(28)} ${setup.description}${setup.builtin ? "  (built-in)" : ""}`);
    }
    console.log("");
    console.log("Apply one: bumper setup apply <name> -p <project>");
    return;
  }

  const name = args[0];
  if (!name) fail(usage);

  if (sub === "save") {
    let description: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--description") description = args[++i];
      else if (args[i]!.startsWith("--description=")) description = args[i]!.slice("--description=".length);
      else fail(usage);
    }
    const projectName = projectForEdit(config, projectFlag);
    try {
      saveSetup({ config, name, fromProject: projectName, description });
    } catch (err) {
      failFromOperation(err);
    }
    saveConfigFile(path, config);
    console.log(`Saved "${name}" from Project "${projectName}".`);
    console.log(`Apply it elsewhere: bumper setup apply "${name}" -p <project>`);
    return;
  }

  if (sub === "apply") {
    const projectName = projectForEdit(config, projectFlag);
    let result;
    try {
      result = applySetupToProject({ config, name, projectName, runningSessions: leaseSessionRefs() });
    } catch (err) {
      failFromOperation(err);
    }
    Object.assign(config.contexts[projectName]!, result.applied);
    saveConfigFile(path, config);
    console.log(`Applied "${result.name}" to Project "${result.projectName}".`);
    console.log("");
    console.log("Check what changed: bumper folders list && bumper network show");
    console.log("Applies to new Sessions.");
    return;
  }

  if (sub === "remove" || sub === "rm") {
    try {
      deleteSetup({ config, name });
    } catch (err) {
      failFromOperation(err);
    }
    saveConfigFile(path, config);
    console.log(`Removed setup "${name}".`);
    return;
  }

  fail(usage);
}

/** `bumper dev sessions|preview|docker` — capabilities a live Session borrows. */
function cmdDev(argv: string[], projectFlag?: string): void {
  const usage = [
    "Usage: bumper dev sessions [-p project]",
    "       bumper dev preview on|off <session-id>",
    "       bumper dev docker on|off <session-id>",
  ].join("\n");

  const [sub, ...args] = argv;
  if (!sub) fail(usage);

  if (sub === "sessions") {
    const { config } = loadConfig();
    const projectName = projectFlag ? projectForEdit(config, projectFlag) : undefined;
    const sessions = listDevelopmentSessions(projectName);
    if (sessions.length === 0) {
      console.log("No Development Sessions. One exists while an AI CLI is running.");
      return;
    }
    for (const session of sessions) {
      console.log(`${session.live ? "●" : " "} ${session.id}`);
      console.log(`    ${session.projectName}  ·  ${session.agentName}`);
      console.log(`    Local Preview: ${session.previewEnabled ? "On" : "Off"}  ·  Docker: ${session.dockerEnabled ? "On" : "Off"}`);
    }
    console.log("");
    console.log("Change one: bumper dev preview off <session-id>");
    return;
  }

  if (sub !== "preview" && sub !== "docker") fail(usage);
  const [state, sessionId] = args;
  if ((state !== "on" && state !== "off") || !sessionId || args.length > 2) fail(usage);

  let result;
  try {
    result = setDevelopmentSessionAccess({ sessionId, capability: sub, enabled: state === "on" });
  } catch (err) {
    failFromOperation(err);
  }
  console.log(`${result.capability === "preview" ? "Local Preview" : "Docker"} ${result.enabled ? "On" : "Off"} for Session ${result.sessionId} (${result.projectName}).`);
  console.log("This takes effect for the running Session immediately.");
}

/** `bumper prefs` — including how long the local event record is kept. */
function cmdPrefs(argv: string[]): void {
  const [key, value] = argv;
  if (!key) {
    const prefs = describePrefs();
    console.log(`eventRetention  ${prefs.eventRetention}   ${retentionSentence(prefs.eventRetention)}`);
    console.log(`language        ${prefs.language ?? "(follow the app)"}`);
    console.log("");
    console.log(`Set one: bumper prefs eventRetention off|session|7d|30d`);
    return;
  }
  if (!value) fail("Usage: bumper prefs [<key> <value>]\n  Keys: eventRetention, language");
  let prefs;
  try {
    prefs = setPref({ key, value });
  } catch (err) {
    failFromOperation(err);
  }
  console.log(`${key} → ${value}`);
  if (key === "eventRetention") console.log(retentionSentence(prefs.eventRetention));
}

/** `bumper login list|remove` — signing out, which only the GUI could do. */
function cmdLogin(argv: string[]): void {
  const usage = [
    "Usage: bumper login list",
    "       bumper login remove <tool> [--identity <id>]",
    "",
    "Signing in happens inside the Sandbox session — just run bumper <cli>.",
  ].join("\n");

  const [sub, ...args] = argv;
  const { path, config } = loadConfig();

  if (!sub || sub === "list") {
    const logins = listStoredLogins(config);
    const stored = logins.filter((login) => login.present);
    if (stored.length === 0) {
      console.log("No AI logins stored on this Mac.");
      console.log("Signing in happens inside the Sandbox: bumper claude");
      return;
    }
    for (const login of stored) {
      console.log(`${login.agentName}  (${login.agentId})  identity: ${login.identityLabel}`);
      if (login.usedBy.length) console.log(`    Used by: ${login.usedBy.join(", ")}`);
    }
    console.log("");
    console.log("Remove one: bumper login remove <tool>");
    return;
  }

  if (sub !== "remove" && sub !== "rm") fail(usage);
  const tool = args[0];
  if (!tool) fail(usage);
  let identity: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--identity") identity = args[++i];
    else if (args[i]!.startsWith("--identity=")) identity = args[i]!.slice("--identity=".length);
    else fail(usage);
  }

  const agentId = resolveCliAgentId(tool) ?? tool;
  let result;
  try {
    result = removeStoredLogin({ config, agentId, identityId: identity });
  } catch (err) {
    failFromOperation(err);
  }
  saveConfigFile(path, config);
  console.log(`Removed the stored ${result.agentName} login (${result.identityId}).`);
  console.log(`  ${result.cleared} stored location${result.cleared === 1 ? "" : "s"} cleared.`);
  if (result.unbound.length) {
    console.log(`  Unbound from: ${result.unbound.join(", ")} — those Projects will ask again on next launch.`);
  }
}

/** `bumper uninstall` — G5 for people who never opened the app. */
function cmdUninstall(argv: string[]): void {
  const yes = argv.includes("--yes");
  const dryRun = argv.includes("--dry-run") || !yes;
  const rest = argv.filter((a) => a !== "--yes" && a !== "--dry-run");
  if (rest.length) fail(`Unexpected arguments: ${rest.join(" ")}\nUsage: bumper uninstall [--dry-run|--yes]`);

  const preview = previewUninstall({ includeLocalData: true, runningSessions: leaseSessionRefs() });

  console.log(dryRun ? "bumper uninstall — dry run, nothing has been removed." : "bumper uninstall");
  console.log("");
  console.log(dryRun ? "Would remove:" : "Removing:");
  for (const target of preview.localDataPaths) console.log(`  ${target}`);
  console.log("");
  console.log("Never removed:");
  for (const kept of preview.neverDeletes) console.log(`  ${kept}`);

  if (preview.liveSessions.length) {
    console.log("");
    console.log(`Running now: ${preview.liveSessions.map((s) => s.agentName || s.id).join(", ")}`);
  }

  if (dryRun) {
    console.log("");
    console.log("Remove it for real: bumper uninstall --yes");
    console.log("Then: npm uninstall -g @crostra/bumper");
    return;
  }

  let result;
  try {
    result = performUninstall({ includeLocalData: true, runningSessions: leaseSessionRefs() });
  } catch (err) {
    failFromOperation(err);
  }
  console.log("");
  for (const removed of result.removed) console.log(`Removed ${removed}`);
  for (const skipped of result.skipped) console.log(`Left alone: ${skipped}`);
  console.log("");
  console.log("Your project folders are exactly where they were.");
  console.log("Last step: npm uninstall -g @crostra/bumper");
}

/** `bumper backup list|restore` — the way back from a wrecked config. */
function cmdBackup(argv: string[]): void {
  const [sub, ...args] = argv;
  const state = describeRecovery();

  if (!sub || sub === "list") {
    if (state.inRecovery) {
      console.log(`Recovery mode: ${state.reason}`);
      console.log("");
    }
    if (state.backups.length === 0) {
      console.log("No config backups yet. One is kept each time Bumper writes the config.");
      return;
    }
    console.log("Config backups (newest first):");
    for (const backup of state.backups) {
      console.log(`  ${backup.id}   ${new Date(backup.mtimeMs).toLocaleString()}   ${backup.size} bytes`);
    }
    console.log("");
    console.log("Restore one: bumper backup restore <id>");
    return;
  }

  if (sub !== "restore") fail("Usage: bumper backup list\n       bumper backup restore <id>");
  const id = args[0];
  if (!id || args.length > 1) fail("Usage: bumper backup restore <id>");
  let result;
  try {
    result = restoreBackup({ backupId: id });
  } catch (err) {
    failFromOperation(err);
  }
  console.log(`Restored ${result.backupId} → ${result.restoredTo}`);
  console.log("Check it: bumper doctor");
}

/** `bumper feedback` — a URL, opened on request. No telemetry, ever. */
async function cmdFeedback(argv: string[]): Promise<void> {
  const bug = argv.includes("--bug");
  const rest = argv.filter((a) => a !== "--bug");
  if (rest.length) fail(`Unexpected arguments: ${rest.join(" ")}\nUsage: bumper feedback [--bug]`);

  let containerDetail: string | undefined;
  try {
    const availability = await new AppleContainerBackend().check();
    containerDetail = availability.detail;
  } catch {
    /* optional */
  }

  const target = describeFeedback({
    kind: bug ? "bug" : "discussion",
    bumperVersion: BUMPER_VERSION,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    containerDetail,
  });

  console.log(target.kind === "bug" ? "Report a bug:" : "Tell us where you wanted to narrow access:");
  console.log(`  ${target.url}`);
  console.log("");
  console.log("Worth pasting in (gathered on this Mac; Bumper sends nothing on its own):");
  for (const line of target.context) console.log(`  ${line}`);
  console.log("");
  console.log("Open it: bumper feedback --open");
  if (argv.includes("--open")) {
    const { spawn } = await import("node:child_process");
    spawn("open", [target.url], { stdio: "ignore", detached: true }).unref();
  }
}

/** Resolve which Project a boundary edit targets, or fail with the reason. */
function projectForEdit(config: Config, projectFlag?: string): string {
  const active = getActiveContext(config.defaultContext);
  const resolved = resolveProjectNameForAccessEdit(config, process.cwd(), projectFlag, active);
  if ("error" in resolved) fail(resolved.error);
  return resolved.name;
}

function saveConfigFile(path: string, config: Config): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * W1-2: `bumper folders` — the first of the two dials. Sharing rules (root vs
 * subfolder, ancestors, empty share) live in operations/folders.ts, which the
 * GUI board calls too, so a CLI-only user gets the same boundary the GUI would
 * have produced.
 */
function cmdFolders(argv: string[]): void {
  const usage = [
    "Usage: bumper folders list [-p project]",
    "       bumper folders add <path> [--read-only] [-p project]",
    "       bumper folders remove <path> [-p project]",
    "",
    "Paths are the project folder (.), a subfolder (./src), or anywhere on this Mac (~/other).",
  ].join("\n");

  let projectFlag: string | undefined;
  let rest: string[];
  try {
    ({ projectFlag, rest } = parseProjectFlag(argv));
  } catch (err) {
    fail((err as Error).message);
  }

  const readOnly = rest.includes("--read-only") || rest.includes("--look-only");
  const args = rest.filter((a) => a !== "--read-only" && a !== "--look-only");
  const [sub, ...targets] = args;
  if (!sub) fail(usage);

  const { path, config } = loadConfig();
  const projectName = projectForEdit(config, projectFlag);

  if (sub === "list") {
    if (targets.length) fail(usage);
    let view;
    try {
      view = describeProjectFolders({ config, projectName, runningSessions: leaseSessionRefs() });
    } catch (err) {
      failFromOperation(err);
    }
    console.log(`Project: ${projectName}`);
    console.log(`Project folder: ${view.workspace || "(unset)"}${view.workspace && !view.workspaceExists ? "  (missing on disk)" : ""}`);
    console.log("");
    console.log("Shared with the Sandbox:");
    if (view.rows.length === 0) {
      console.log("  (nothing — the Sandbox would see no files)");
      console.log(`  Fix: bumper folders add . -p "${projectName}"`);
    } else {
      for (const row of view.rows) {
        const described = describeShareRow(row);
        console.log(`  · ${described.label.padEnd(28)} ${accessLabel(described.access).padEnd(10)} ${described.scope}`);
      }
    }
    console.log("");
    console.log("Everything else on this Mac: Not shared.");
    if (view.blockingSessions.length) {
      console.log("");
      console.log(`Running now: ${view.blockingSessions.map((s) => s.agentName || s.id).join(", ")} — stop it before changing folders.`);
    }
    return;
  }

  if (sub !== "add" && sub !== "remove") fail(usage);
  const target = targets[0];
  if (!target || targets.length > 1) fail(usage);

  let result;
  try {
    result = sub === "add"
      ? addProjectFolder({
        config, projectName, hostPath: target,
        access: readOnly ? "read-only" : "read-write",
        runningSessions: leaseSessionRefs(),
      })
      : removeProjectFolder({ config, projectName, hostPath: target, runningSessions: leaseSessionRefs() });
  } catch (err) {
    failFromOperation(err);
  }

  const project = config.contexts[projectName]!;
  config.contexts[projectName] = applyFolderPatch(project, result.patch);
  saveConfigFile(path, config);

  console.log(`Project "${projectName}" — ${sub === "add" ? "now sharing" : "stopped sharing"} ${target}`);
  if (result.note) console.log(`  ${result.note}`);
  console.log("");
  console.log("Shared with the Sandbox:");
  for (const row of result.rows) {
    const described = describeShareRow(row);
    console.log(`  · ${described.label.padEnd(28)} ${accessLabel(described.access)}`);
  }
  console.log("");
  console.log("Applies to new Sessions. A Session already running keeps the boundary it started with.");
}

/** `bumper project list|create|remove` — Projects without opening the app. */
function cmdProject(argv: string[]): void {
  const usage = [
    "Usage: bumper project list",
    "       bumper project create <name> [--path <folder>]",
    "       bumper project remove <name>",
  ].join("\n");

  const [sub, ...rest] = argv;
  if (!sub) fail(usage);
  const { path, config } = loadConfig();

  if (sub === "list") {
    const projects = listProjects(config);
    if (projects.length === 0) {
      console.log("No Projects yet.");
      console.log("Fix: bumper init            # create one bound to this folder");
      return;
    }
    for (const project of projects) {
      const mark = project.isDefault ? "●" : " ";
      const network = project.egress === "blocked" ? "Off" : project.egress === "allowlist" ? "Allowed only" : "Open";
      console.log(`${mark} ${project.name}`);
      console.log(`    Folder: ${project.workspace || "(unset)"}`);
      console.log(`    Network: ${network}  ·  Shared roots: ${project.accessRootCount}`);
    }
    return;
  }

  if (sub === "create") {
    let name = "";
    let folder = "";
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--path" || arg === "-C") folder = rest[++i] ?? "";
      else if (arg.startsWith("--path=")) folder = arg.slice("--path=".length);
      else if (arg.startsWith("-")) fail(`Unknown option "${arg}".\n\n${usage}`);
      else if (!name) name = arg;
      else fail(usage);
    }
    let result;
    try {
      result = createProject({ config, name, workspace: folder || process.cwd() });
    } catch (err) {
      failFromOperation(err);
    }
    saveConfigFile(path, config);
    console.log(`Created Project "${result.name}"`);
    console.log(`  Folder shared with the Sandbox: ${result.workspace}`);
    console.log(`  Network: ${result.egress === "blocked" ? "Off" : result.egress === "allowlist" ? "Allowed only" : "Open"}`);
    console.log("");
    console.log("Nothing outside that folder is shared.");
    console.log("");
    console.log("Next:");
    console.log(`  bumper network off -p "${result.name}"     # cut it off the internet`);
    console.log(`  bumper -p "${result.name}" claude          # protected launch on this TTY`);
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const name = rest[0];
    if (!name || rest.length > 1) fail(usage);
    let result;
    try {
      result = deleteProject({ config, name, runningSessions: leaseSessionRefs() });
    } catch (err) {
      failFromOperation(err);
    }
    saveConfigFile(path, config);
    console.log(`Removed Project "${result.name}" from Bumper.`);
    if (result.workspace) {
      console.log(`Your folder is untouched: ${result.workspace}`);
    }
    if (result.nextDefault) console.log(`Default Project is now "${result.nextDefault}".`);
    else if (Object.keys(config.contexts).length === 0) console.log("No Projects left. Create one: bumper init");
    return;
  }

  fail(usage);
}

/**
 * W1-3: `bumper network off|allowed|open` — the second of the two dials that
 * make a Sandbox *yours*. The decision lives in operations/network.ts, shared
 * with the GUI's Network control; this function only reads argv and prints.
 */
function cmdNetwork(argv: string[]): void {
  const usage = [
    "Usage: bumper network off|allowed|open [-p project]",
    "       bumper network allowed [host…] [--template <id>…] [-p project]",
    "       bumper network show [-p project]",
  ].join("\n");

  let projectFlag: string | undefined;
  let rest: string[];
  try {
    ({ projectFlag, rest } = parseProjectFlag(argv));
  } catch (err) {
    fail((err as Error).message);
  }

  const [verb, ...args] = rest;
  if (!verb) fail(usage);

  const { path, config } = loadConfig();
  const active = getActiveContext(config.defaultContext);
  const resolved = resolveProjectNameForAccessEdit(config, process.cwd(), projectFlag, active);
  if ("error" in resolved) fail(resolved.error);
  const project = config.contexts[resolved.name]!;

  if (verb === "show") {
    if (args.length) fail(usage);
    const mode = project.room?.egress ?? "blocked";
    console.log(`Project: ${resolved.name}  (via ${resolved.source})`);
    console.log(`Network: ${networkLabel(mode)} — ${networkSentence(mode)}`);
    if (mode === "allowlist") {
      const templates = project.room?.egressTemplates ?? [];
      const hosts = project.room?.egressHosts ?? [];
      console.log(`  Templates: ${templates.length ? templates.join(", ") : "(none)"}`);
      console.log(`  Hosts: ${hosts.length ? hosts.join(", ") : "(none)"}`);
    }
    console.log("");
    console.log("Available templates:");
    for (const template of listEgressTemplates()) {
      console.log(`  ${template.id.padEnd(10)} ${template.label} — ${template.hosts.join(", ")}`);
    }
    return;
  }

  const mode = NETWORK_VERBS[verb];
  if (!mode) fail(`Unknown network mode "${verb}".\n\n${usage}`);

  const templates: string[] = [];
  const hosts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--template" || arg === "-t") {
      const value = args[++i];
      if (!value) fail("Missing value for --template.\n\n" + usage);
      templates.push(value);
    } else if (arg.startsWith("--template=")) {
      templates.push(arg.slice("--template=".length));
    } else if (arg.startsWith("-")) {
      fail(`Unknown option "${arg}".\n\n${usage}`);
    } else {
      hosts.push(arg);
    }
  }
  if (mode !== "allowlist" && (hosts.length || templates.length)) {
    fail(`Hosts and templates only apply to "allowed".\n\n${usage}`);
  }

  let result;
  try {
    result = setProjectNetwork({ config, projectName: resolved.name, mode, hosts, templates });
  } catch (err) {
    failFromOperation(err);
  }

  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  console.log(`Project "${result.projectName}" network: ${networkLabel(result.previous.egress)} → ${networkLabel(result.next.egress)}`);
  console.log(`  ${networkSentence(result.next.egress)}`);
  if (result.next.egress === "allowlist") {
    console.log(`  Reachable hosts (${result.effectiveHosts.length}): ${result.effectiveHosts.join(", ")}`);
  }
  console.log("");
  console.log("Applies to new Sessions. A Session already running keeps the boundary it started with.");
}

/**
 * Phase 5 (W1-4): `bumper doctor` — one screen for container / Node / image /
 * Access, with the next command to type. Reuses the existing probes; it adds
 * no new readiness judgement of its own.
 */
async function cmdDoctor(argv: string[]): Promise<void> {
  const quick = argv.includes("--quick");
  const noStart = argv.includes("--no-start");
  const filtered = argv.filter((a) => a !== "--quick" && a !== "--no-start");
  let projectFlag: string | undefined;
  let leftover: string[];
  try {
    ({ projectFlag, rest: leftover } = parseProjectFlag(filtered));
  } catch (err) {
    fail((err as Error).message);
  }
  if (leftover.length) {
    fail(`Unexpected arguments: ${leftover.join(" ")}\nUsage: bumper doctor [-p project] [--quick] [--no-start]`);
  }

  const facts = await collectDoctorFacts({
    cwd: process.cwd(),
    projectFlag,
    skipImageProbe: quick,
    noStart,
  });
  const report = buildDoctorReport(facts);
  console.log(formatDoctorReport(report));
  process.exit(report.ready ? 0 : 1);
}

function cmdContexts(): void {
  const { config } = loadConfig();
  const active = getActiveContext(config.defaultContext);
  const names = Object.keys(config.contexts);
  if (names.length === 0) fail("No contexts defined in config.");
  for (const name of names) {
    const ctx = config.contexts[name];
    const marker = name === active ? "●" : " ";
    const desc = ctx.description ? ` — ${ctx.description}` : "";
    const roots = projectAccessRoots(ctx).length;
    const access = roots ? `${roots} Access root${roots === 1 ? "" : "s"}` : "Access empty";
    console.log(`${marker} ${name}  [${ctx.mode}]  ${access}${desc}`);
  }
}

/**
 * bumper access set|show — fix empty Access roots so cwd resolve / status are useful.
 */
function cmdAccess(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (sub !== "set" && sub !== "show") {
    fail("Usage: bumper access set [-p project] [folder]\n       bumper access show [-p project]");
  }

  let projectFlag: string | undefined;
  let leftover: string[];
  try {
    ({ projectFlag, rest: leftover } = parseProjectFlag(rest));
  } catch (err) {
    fail((err as Error).message);
  }

  const { path, config } = loadConfig();
  const active = getActiveContext(config.defaultContext);
  const resolved = resolveProjectNameForAccessEdit(config, process.cwd(), projectFlag, active);
  if ("error" in resolved) fail(resolved.error);

  const project = config.contexts[resolved.name]!;
  if (sub === "show") {
    if (leftover.length) fail(`Unexpected arguments: ${leftover.join(" ")}\nUsage: bumper access show [-p project]`);
    const roots = projectAccessRoots(project);
    console.log(`Project: ${resolved.name}  (via ${resolved.source})`);
    console.log(`Workspace: ${project.workspace?.trim() || "(unset)"}`);
    console.log("Access roots:");
    if (roots.length === 0) {
      console.log("  (none)");
      console.log(`Fix: bumper access set -p "${resolved.name}"`);
      console.log("     or Bumper app → Projects → Access → choose workspace");
      console.log("Bumper does not invent a home-wide door.");
    } else {
      for (const root of roots) {
        const access = root.access ? ` [${root.access}]` : "";
        console.log(`  · ${root.role}: ${root.path}${access}`);
      }
    }
    return;
  }

  // set
  const folder = leftover[0]?.trim() || process.cwd();
  if (leftover.length > 1) {
    fail(`Unexpected arguments: ${leftover.slice(1).join(" ")}\nUsage: bumper access set [-p project] [folder]`);
  }

  let result;
  try {
    result = setProjectAccessWorkspace(config, resolved.name, folder);
  } catch (err) {
    fail((err as Error).message);
  }

  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Project "${result.projectName}" workspace (primary Access root) → ${result.workspace}`);
  if (result.previous && result.previous !== result.workspace) {
    console.log(`Previous: ${result.previous}`);
  }
  if (result.bindsHome) {
    console.log(
      "Warning: this binds your home directory as Access — a very large share. Prefer a project folder.",
    );
  }
  console.log("cwd resolve: bumper status / bumper <cli> from this folder (or a subfolder) can match.");
  console.log("GUI: Projects → Access shows the same root. Bumper never invents Access doors.");
}

function cmdUse(name?: string): void {
  if (!name) fail("Usage: bumper use <context>");
  const { config } = loadConfig();
  if (!config.contexts[name!]) {
    fail(`Context "${name}" not found. Available: ${Object.keys(config.contexts).join(", ")}`);
  }
  setActiveContext(name!);
  console.log(`Active context is now "${name}".`);
  console.log(`Restart your AI client (or reconnect the MCP server) to apply.`);
}

/**
 * Phase 2 status: Project cage summary without starting a session.
 * Sandbox-first Project summary.
 */
async function cmdStatus(argv: string[]): Promise<void> {
  const filtered = argv;
  let projectFlag: string | undefined;
  let rest: string[];
  try {
    ({ projectFlag, rest } = parseProjectFlag(filtered));
  } catch (err) {
    fail((err as Error).message);
  }
  if (rest.length) fail(`Unexpected arguments: ${rest.join(" ")}\nUsage: bumper status [-p project]`);

  const { path, config } = loadConfig();
  void path;


  const resolved = await resolveProjectForStatus({
    config,
    cwd: process.cwd(),
    flag: projectFlag,
  });
  if ("error" in resolved) fail(resolved.error);

  const snapshot = await buildProjectStatusSnapshot({
    config,
    projectName: resolved.name,
    source: resolved.source,
    cwd: process.cwd(),
  });
  console.log(formatProjectStatus(snapshot));

  // Compact today counts when log exists for this project name
  try {
    const counts = todayCounts(resolved.name);
    console.log(`Today (audit): ${counts.blocked} blocked · ${counts.allowed} allowed`);
  } catch {
    /* optional */
  }
}

/**
 * bumper [-p project] <cli> [args…]
 * Resolve Project → readiness → TTY-attach Sandbox. Refuse without starting if not ready.
 */
async function cmdRoomAgent(cliName: string, argv: string[]): Promise<void> {
  let projectFlag: string | undefined;
  let rest: string[];
  try {
    ({ projectFlag, rest } = parseProjectFlag(argv));
  } catch (err) {
    fail((err as Error).message);
  }

  // Support: bumper grok -p Demo  (flag after command)
  if (!projectFlag) {
    try {
      const again = parseProjectFlag(rest);
      projectFlag = again.projectFlag;
      rest = again.rest;
    } catch (err) {
      fail((err as Error).message);
    }
  }

  // Same reason as doctor: the services being down is not a decision the user
  // made, so it should not become an error they have to decode.
  const system = ensureContainerSystem();
  if (system.started) {
    console.error("bumper: Apple container services were stopped — started them (stop again: container system stop)");
  }

  const agentId = resolveCliAgentId(cliName);
  if (!agentId) {
    fail(
      `Unknown AI CLI "${cliName}". Supported: ${listCliAgentAliases().join(", ")}.\n` +
        `Host vendor installs are not used — Sandbox image CLI is canonical.`,
    );
  }

  const { path, config } = loadConfig();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  // Peel --account from agent args (rebind already-bound Projects).
  let accountFlag: string | undefined;
  try {
    const pealed = parseProjectFlag(rest);
    accountFlag = pealed.accountFlag;
    rest = pealed.rest;
  } catch (err) {
    fail((err as Error).message);
  }

  const resolved = await resolveProjectForCli({
    config,
    configPath: path,
    cwd: process.cwd(),
    flag: projectFlag,
    interactive,
  });

  if (!resolved.ok) {
    fail(resolved.message);
  }

  // Phase 9-3: ensure (Project, tool) has an account before Sandbox launch.
  const { ensureProjectAccountForLaunch } = await import("./room/accounts-cli.js");
  const accountReady = await ensureProjectAccountForLaunch({
    config,
    configPath: path,
    projectName: resolved.name,
    agentId,
    accountFlag,
    interactive,
  });
  if (!accountReady.ok) {
    fail(accountReady.message);
  }

  const result = await runCliRoomAgent({
    config,
    projectName: resolved.name,
    agentId,
    cwd: process.cwd(),
    agentArgs: rest,
  });

  if (!result.started) {
    console.error(result.message);
    process.exit(result.exitCode);
  }
  process.exit(result.exitCode);
}

async function cmdMcp(argv: string[]): Promise<void> {
  // Binding subcommands first; `connect` / `client-config` are the bridge.
  let projectFlag: string | undefined;
  let bindingArgs = argv;
  if (["list", "show", "bind", "unbind"].includes(argv[0] ?? "")) {
    try {
      const parsed = parseProjectFlag(argv);
      projectFlag = parsed.projectFlag;
      bindingArgs = parsed.rest;
    } catch (err) {
      fail((err as Error).message);
    }
    if (cmdMcpBindings(bindingArgs, projectFlag)) return;
  }

  const [sub, ...rest] = argv;
  if (sub === "connect") {
    let projectId = "";
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--project" || a === "-p") {
        projectId = rest[++i] ?? "";
      } else if (a.startsWith("--project=")) {
        projectId = a.slice("--project=".length);
      } else if (a.startsWith("-p=")) {
        projectId = a.slice(3);
      }
    }
    if (!projectId.trim()) {
      fail("Usage: bumper mcp connect --project <id>\n\nMCP-only external bridge: files/shell/network are not Bumper-protected on this path.");
    }
    const { config } = loadConfig();
    if (!config.contexts[projectId]) fail(`Unknown project "${projectId}".`);
    console.error(
      `bumper: MCP Hub bridge for project "${projectId}" (MCP-only — files/shell/network not Bumper-protected).`,
    );
    return void (await startProxy(config, { projectName: projectId }));
  }
  if (sub === "client-config") {
    return cmdMcpClientConfig(rest);
  }
  fail([
    `Unknown mcp subcommand "${sub ?? ""}".`,
    "Usage:",
    "  bumper mcp list                        MCP Connections in the Library",
    "  bumper mcp show [-p project]           What this Project binds, and which CLIs receive it",
    "  bumper mcp bind|unbind <connection-id> [-p project]",
    "  bumper mcp connect --project <id>      Stdio bridge for one Project",
    "  bumper mcp client-config --project <id> [--path file] [--apply|--rollback <backup>]",
  ].join("\n"));
}

function cmdMcpClientConfig(argv: string[]): void {
  let projectId = "";
  let targetPath = "";
  let apply = false;
  let rollback: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") projectId = argv[++i] ?? "";
    else if (a.startsWith("--project=")) projectId = a.slice("--project=".length);
    else if (a === "--path") targetPath = argv[++i] ?? "";
    else if (a.startsWith("--path=")) targetPath = a.slice("--path=".length);
    else if (a === "--apply") apply = true;
    else if (a === "--rollback") rollback = argv[++i] ?? "";
    else if (a.startsWith("--rollback=")) rollback = a.slice("--rollback=".length);
  }
  if (!projectId.trim()) fail("Usage: bumper mcp client-config --project <id> [--path file] [--apply|--rollback <backup>]");
  const { config } = loadConfig();
  if (!config.contexts[projectId]) fail(`Unknown project "${projectId}".`);
  const configPath = resolveConfigPath();
  const binPath = resolve(process.argv[1]);
  const snippet = buildExternalMcpSnippet({ binPath, configPath, projectId });
  if (rollback) {
    if (!targetPath) fail("--rollback requires --path <mcp-config.json>");
    rollbackExternalMcpConfig(targetPath, rollback);
    console.log(`Rolled back ${targetPath} from ${rollback}`);
    console.log(EXTERNAL_MCP_MODE_LABEL);
    return;
  }
  const path = targetPath || join(homedir(), ".cursor", "mcp.json");
  const diff = previewExternalMcpConfig(path, snippet);
  console.log(`# External MCP client config (${diff.mode})`);
  console.log(`# ${diff.warning}`);
  console.log(`# Target: ${diff.path}`);
  console.log(`# Changed: ${diff.changed}`);
  console.log(diff.after);
  if (apply) {
    const { backupPath } = applyExternalMcpConfig(path, snippet);
    console.error(`Applied. Backup: ${backupPath}`);
    console.error(`Rollback: bumper mcp client-config --project ${projectId} --path ${path} --rollback ${backupPath}`);
  } else {
    console.error(`\nDiff preview only. Pass --apply to write (creates backup). ${EXTERNAL_MCP_MODE_LABEL}`);
  }
}

function cmdClientConfig(): void {
  const path = resolveConfigPath();
  const binPath = resolve(process.argv[1]);
  const snippet = {
    mcpServers: {
      "bumper": {
        command: "node",
        args: [binPath, "mcp", "connect", "--project", "<project-id>"],
        env: { BUMPER_CONFIG: path },
      },
    },
  };
  console.log(`# 1. MCP Hub bridge — add to your Claude Code / Cursor MCP config:\n`);
  console.log(`# WARNING: MCP-only — files / shell / network are NOT Bumper-protected on this external path.`);
  console.log(`# Prefer: bumper mcp client-config --project <id> [--path …] [--apply]\n`);
  console.log(JSON.stringify(snippet, null, 2));
  console.log(`\n(Point your AI client ONLY at bumper. Remove other MCP servers so the proxy is the sole path.)`);

  // Native-tool enforcement via a PreToolUse hook (Claude Code).
  const hookSettings = {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `BUMPER_CONFIG=${path} node ${binPath} hook`,
            },
          ],
        },
      ],
    },
  };
  console.log(`\n# 2. Native-tool enforcement — add to your Claude Code settings.json`);
  console.log(`#    (this blocks file writes / git push / shell mutations in read-only contexts):\n`);
  console.log(JSON.stringify(hookSettings, null, 2));
}

async function cmdRun(rest: string[]): Promise<void> {
  const sep = rest.indexOf("--");
  const command = sep >= 0 ? rest.slice(sep + 1) : rest;
  if (command.length === 0) {
    fail("Usage: bumper run -- <command…>   e.g. bumper run -- claude");
  }
  const { path, config } = loadConfig();
  const { name, context } = resolveActiveContext(config);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUMPER_CONFIG: path,
    GIT_TERMINAL_PROMPT: "0",
    HISTFILE: "/dev/null",
  };
  console.error(`bumper: launching in context "${name}" — writes confined to this context.`);
  const { code } = await runSandboxed(context, command, env);
  process.exit(code);
}

function cmdAllow(action: "allow" | "deny", arg?: string): void {
  let spec;
  if (action === "allow" && (!arg || arg === "last")) {
    spec = lastBlockedSpec();
    if (!spec) fail("Nothing was blocked recently. Try: bumper allow \"Bash:git push\"");
  } else {
    if (!arg) fail(`Usage: bumper ${action} <rule>   e.g. bumper ${action} "Bash:git push"  or  bumper ${action} Write`);
    try {
      spec = inferSpecFromString(arg!);
    } catch (err) {
      fail((err as Error).message);
    }
  }
  const { context, message } = applyRule(action, spec!, undefined);
  console.log(message);
  console.log(`Restart the client (or re-run \`bumper run\`) in "${context}" to apply.`);
}

function cmdLog(argv: string[]): void {
  const blocked = argv.includes("--blocked");
  const exportJson = argv.includes("--export");
  const rest = argv.filter((a) => a !== "--blocked" && a !== "--export");
  if (rest.length) {
    fail(`Unexpected arguments: ${rest.join(" ")}\nUsage: bumper log [--blocked] [--export]`);
  }
  const decision = blocked ? "blocked" : undefined;

  if (exportJson) {
    // The audit record as data you can keep. Same rows the GUI exports.
    console.log(JSON.stringify(exportEvents({ decision }), null, 2));
    return;
  }

  const events = readEvents({ limit: 50, decision });
  if (events.length === 0) {
    console.log("No events yet. Run a protected client session first.");
    return;
  }
  for (const e of events) {
    const mark = e.decision === "blocked" ? "⛔" : "✓";
    const t = new Date(e.ts).toLocaleTimeString();
    console.log(`${mark} ${t}  [${e.context}/${e.surface}]  ${e.target}  — ${e.reason}`);
  }
}

function cmdInstallClaude(dir?: string): void {
  const binPath = resolve(process.argv[1]);
  const notes = installClaude(dir ?? process.cwd(), binPath);
  console.log(`Wired bumper into Claude Code:`);
  for (const n of notes) console.log(`  ${n}`);
  console.log(`\nActive context: ${getActiveContext() ?? "(none — run: bumper use <context>)"}`);
  console.log(`\nRestart Claude Code in this directory. Then verify:`);
  console.log(`  • ask it to read a file → allowed`);
  console.log(`  • in a read-only context, ask it to edit a file or 'git push' → blocked by bumper`);
  console.log(`  • run \`bumper status\` to see the Project cage summary`);
}

function applyProjectSandboxImage(configPath: string, projectName: string, image: string): void {
  const { config } = loadConfig(configPath);
  const project = config.contexts[projectName];
  if (!project) fail(`Unknown project: ${projectName}`);
  project.room = { ...project.room, enabled: true, image };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

/**
 * bumper room-image build|verify — reliable recommended image path (materialize_path_bin).
 */
async function cmdSandboxImage(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub !== "build" && sub !== "verify") {
    fail("Usage: bumper room-image build [-p project] [--force]\n       bumper room-image verify");
  }

  if (sub === "verify") {
    if (rest.length) fail("Usage: bumper room-image verify");
    const recipe = inspectRecommendedRoomRecipe();
    console.log(recipe.detail);
    if (!recipe.present) process.exit(1);
    const verify = verifyRecommendedRoomAuthOverlay();
    console.log(verify.ok ? `Verify: ${verify.detail}` : `Verify failed: ${verify.detail}`);
    process.exit(verify.ok ? 0 : 1);
  }

  const force = rest.includes("--force") || rest.includes("--no-cache");
  const filtered = rest.filter((a) => a !== "--force" && a !== "--no-cache");
  let projectFlag: string | undefined;
  let leftover: string[];
  try {
    ({ projectFlag, rest: leftover } = parseProjectFlag(filtered));
  } catch (err) {
    fail((err as Error).message);
  }
  if (leftover.length) fail(`Unexpected arguments: ${leftover.join(" ")}\nUsage: bumper room-image build [-p project] [--force]`);

  const backend = new AppleContainerBackend();
  const availability = await backend.check();
  if (!availability.usable) fail(`Apple container not usable: ${availability.detail}`);
  const system = ensureContainerSystem();
  if (system.started) {
    console.log("Apple container services were stopped — started them (stop again: container system stop)");
  } else if (!system.running) {
    fail(`Apple container is not ready — ${system.detail}\n\nNext:\n  container system start`);
  }

  const existing = inspectRecommendedRoomRecipe();
  const useNoCache = force || existing.stale || !existing.present;
  if (existing.present && existing.stale && !force) {
    console.log(`Note: local ${RECOMMENDED_ROOM_IMAGE} looks stale — using --no-cache automatically.`);
  } else if (useNoCache && !force) {
    console.log(`Building ${RECOMMENDED_ROOM_IMAGE} (recipe ${RECOMMENDED_ROOM_RECIPE})…`);
  } else {
    console.log(`Building ${RECOMMENDED_ROOM_IMAGE} (recipe ${RECOMMENDED_ROOM_RECIPE}${useNoCache ? ", --no-cache" : ""})…`);
  }

  const result = await buildRecommendedRoomImage((line) => {
    process.stdout.write(`${line}\n`);
  }, { noCache: useNoCache, verify: true });

  if (!result.ok) {
    console.error(`\nbumper: Sandbox image build failed — ${result.failedTool}: ${result.hint}`);
    process.exit(1);
  }

  console.log(`\nBuilt ${result.image}`);
  if (result.verifyDetail) console.log(`Verify: ${result.verifyDetail}`);

  if (projectFlag) {
    const { path, config } = loadConfig();
    if (!config.contexts[projectFlag]) fail(`Unknown project: ${projectFlag}`);
    applyProjectSandboxImage(path, projectFlag, result.image);
    console.log(`Project "${projectFlag}" Sandbox image → ${result.image}`);
  } else {
    console.log(`Tip: bumper room-image build -p <project> also switches that Project to ${RECOMMENDED_ROOM_IMAGE}.`);
  }
  console.log("Next: bumper status && bumper grok");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Global -p before subcommand: bumper -p Demo grok
  let projectFlag: string | undefined;
  let rest = argv;
  try {
    const parsed = parseProjectFlag(argv);
    // Only peel -p when the first non-flag token is a known agent, "status", or "doctor"
    if (parsed.projectFlag && parsed.rest[0]
      && (isCliAgentCommand(parsed.rest[0])
        || ["status", "doctor", "network", "folders", "git", "prove", "setup", "dev"]
          .includes(parsed.rest[0]))) {
      projectFlag = parsed.projectFlag;
      rest = parsed.rest;
    }
  } catch (err) {
    // If -p is malformed at the front, fail early
    if (argv[0] === "-p" || argv[0] === "--project" || argv[0]?.startsWith("-p=") || argv[0]?.startsWith("--project=")) {
      fail((err as Error).message);
    }
  }

  const [cmd, ...cmdRest] = rest;
  const withProject = projectFlag
    ? ["-p", projectFlag, ...cmdRest]
    : cmdRest;

  switch (cmd) {
    case "init": return void (await cmdInit(cmdRest));
    case "doctor": return void (await cmdDoctor(withProject));
    case "contexts": return cmdContexts();
    case "access": return cmdAccess(cmdRest);
    case "folders": return cmdFolders(withProject);
    case "network": return cmdNetwork(withProject);
    case "project": return cmdProject(cmdRest);
    case "git": return void (await cmdGit(withProject));
    case "github": return void (await cmdGitHub(cmdRest));
    case "prove": return void (await cmdProve(withProject));
    case "setup": return cmdSetup(cmdRest, projectFlag);
    case "dev": return cmdDev(cmdRest, projectFlag);
    case "prefs": return cmdPrefs(cmdRest);
    case "login": return cmdLogin(cmdRest);
    case "uninstall": return cmdUninstall(cmdRest);
    case "backup": return cmdBackup(cmdRest);
    case "feedback": return void (await cmdFeedback(cmdRest));
    case "use": return cmdUse(cmdRest[0]);
    case "allow": return cmdAllow("allow", cmdRest[0]);
    case "deny": return cmdAllow("deny", cmdRest[0]);
    case "status": return void (await cmdStatus(withProject));
    case "room-image": return void (await cmdSandboxImage(cmdRest));
    case "mcp": return void (await cmdMcp(cmdRest));
    case "app": {
      const { config } = ensureConfig();
      return void (await startApp(config, () => loadConfig().config, resolve(process.argv[1])));
    }
    case "client-config": return cmdClientConfig();
    case "install-claude": return cmdInstallClaude(cmdRest[0]);
    case "hook": return void (await runHook());
    case "run": return void (await cmdRun(process.argv.slice(3)));
    case "log": return cmdLog(cmdRest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      return;
    default:
      if (isCliAgentCommand(cmd)) {
        return void (await cmdRoomAgent(cmd, withProject));
      }
      fail(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

main().catch((err) => fail((err as Error).message));
