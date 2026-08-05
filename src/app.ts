import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, realpathSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { Config } from "./types.js";
import { getActiveContext, setActiveContext } from "./state.js";
import {
  readEvents, todayCounts, latestEventAtByContext, type Decision, type Surface, type EventSource, type EventType,
  logEvent, groupEvents, pruneEvents, normalizeEvent, eventLogPath,
} from "./log.js";
import { mutateRawConfig, listConfigBackups, restoreConfigBackup, isRecoveryMode, readRecoveryReason, clearRecoveryMode, describeUninstall, executeUninstallCleanup } from "./config-store.js";
import { readPrefs, writePrefs, markAppSessionStart, type EventRetention } from "./prefs.js";
import {
  blocksProtectedLaunch, clearProtectionMismatch, getProtectionMismatch, listProtectionMismatches,
  setProtectionMismatch,
} from "./protection-status.js";
import {
  getGitConnection,
  listGitConnections,
  normalizeGitConnectionId,
  projectsUsingGitConnection,
  purgeLegacyGitConnectionSecrets,
  upsertGitConnection,
} from "./git-connections.js";
import { readGitWorkspaceStatus } from "./git-workspace.js";
import {
  deleteAllMcpConnectionSecrets,
  deleteMcpConnectionSecret,
  listMcpConnections,
  listMcpIntegrations,
  listProjectMcpBindings,
  normalizeMcpId,
  projectsUsingMcpConnection,
  projectsUsingMcpIntegration,
  setMcpConnectionSecret,
  upsertMcpConnection,
  upsertMcpIntegration,
} from "./mcp-hub.js";
import {
  applyMcpServerImports,
  buildImportCandidates,
  listMcpImportProbes,
  loadServersFromSource,
  parseMcpServersDocument,
  writeImportedMcpSecrets,
  type McpImportSourceId,
} from "./mcp-import.js";
import { loadConfig } from "./config.js";
import { inferSpecFromEvent, applyRule } from "./rules.js";
import { resolveConfigPath, stateDir } from "./paths.js";
import { SessionManager } from "./sessions.js";
import { detectAgents, getAgent } from "./agents.js";
import { buildProfile, gitIgnoredPaths } from "./sandbox.js";
import { effectiveContext } from "./effective.js";
import {
  APP_CSS, APP_HTML, APP_JS, APP_LAUNCH_GATE_JS, GITHUB_APP_BADGE_PNG, GITHUB_APP_BADGE_SVG,
  TERMINAL_HTML, TERMINAL_JS,
} from "./ui.js";
import { AppleContainerBackend } from "./room/apple-container.js";
import { sealedRoomSpec, runBreakout } from "./room/breakout.js";
import { roomSpecForContext } from "./room/spec.js";
import { roomExecutablePreflight, roomPreflightFailureDetail, roomPreflightSuccessDetail } from "./room/preflight.js";
import { roomSpecForAgentLaunch } from "./room/launch.js";
import { roomMcpDeliveryReport } from "./room/mcp-broker.js";
import { McpGateway } from "./mcp-gateway.js";
import {
  buildRecommendedRoomImage,
  RECOMMENDED_ROOM_IMAGE,
  SAFE_BASE_ROOM_IMAGE,
  describeImageSource,
  initialRoomImage,
  inspectRecommendedRoomRecipe,
  type RoomBuildResult,
} from "./room/setup.js";
import { roomAssurance, ASSURANCE_LEGEND } from "./room/assurance.js";
import { aiProofProbes, runAiProof } from "./room/aiproof.js";
import {
  roomAuthPaths,
  DEFAULT_AUTH_PROFILE,
  normalizeAuthProfileId,
  profileAuthStatus,
  verifyProfileAuth,
  resetRoomAuth,
  projectAgentStatePath,
  listAiLogins,
  agentsWithIdentityOnDisk,
} from "./room/auth.js";
import { terminalWindowFocusKey } from "./room/launch.js";
import { EGRESS_TEMPLATES } from "./room/egress-proxy.js";
import { normalizeEgress } from "./operations/network.js";
import { applyFolderPatch, applyProjectFolders } from "./operations/folders.js";
import { mergeSweepConnections, setGitSessionAccess, type GitSessionAction } from "./operations/git.js";
import { storedInstallations, summarizeRefresh } from "./operations/github.js";
import { leaseSessionRefs, mergeSessionRefs } from "./operations/running-sessions.js";
import { isOperationError, statusForOperationError } from "./operations/error.js";
import {
  GIT_CAPABILITY_DESCRIPTORS,
  GITHUB_APP_PERMISSIONS,
  normalizeGitCapability,
} from "./git-capability.js";
import {
  projectGitBindings,
  projectGitCeiling,
  withGitBindings,
} from "./git-repositories.js";
import { projectAccessRoots, setProjectAccessWorkspace } from "./project.js";
import {
  applyPermissionSetup,
  assertSetupName,
  isBuiltinTemplateName,
  listAuthProfileIds,
  listBuiltinPermissionSetups,
  projectAuthProfileId,
  resolvePermissionSetup,
  snapshotPermissionSetup,
} from "./setups.js";
import {
  applyFolderDraft,
  assertCanApplyFolders,
  draftFromContext,
  FOLDER_CAPABILITIES,
  folderMatrix,
  folderPolicyDiff,
  normalizeFolderDraft,
  runningSessionsForProject,
  workspacePresence,
  type FolderDraft,
} from "./folders.js";
import { PermissionSetupSchema } from "./types.js";
import { GitHubAppService, githubAppManifest } from "./github-app.js";
import {
  parseGitHubOwnerInput,
  resolveGitHubRepositoryIntent,
} from "./github-repository-intent.js";
import {
  effectiveLeaseAccess,
  listGitSessionLeases,
  readGitSessionLease,
  removeGitSessionLease,
  updateGitSessionLease,
} from "./git-session-lease.js";
import {
  listDevelopmentSessionLeases,
  readDevelopmentSessionLease,
  removeDevelopmentSessionLease,
  updateDevelopmentSessionControl,
} from "./development-session-lease.js";
import type { GitAccess } from "./git-broker.js";

const require = createRequire(import.meta.url);
const VENDOR: Record<string, { file: string; type: string }> = {
  "/vendor/xterm.js": { file: require.resolve("@xterm/xterm/lib/xterm.js"), type: "text/javascript" },
  "/vendor/xterm.css": { file: require.resolve("@xterm/xterm/css/xterm.css"), type: "text/css" },
  "/vendor/addon-fit.js": { file: require.resolve("@xterm/addon-fit/lib/addon-fit.js"), type: "text/javascript" },
  "/vendor/lucide.js": { file: require.resolve("lucide/dist/umd/lucide.js"), type: "text/javascript" },
};

export interface TerminalWindowRequest {
  sessionId: string;
  windowKey?: string;
  title?: string;
}

export interface TerminalWindowResult {
  ok: true;
  focused: boolean;
  created: boolean;
  url: string;
}

export interface AppHooks {
  /** Electron opens/focuses a fixed-size utility BrowserWindow. Absent in plain HTTP. */
  openTerminalWindow?: (request: TerminalWindowRequest) => TerminalWindowResult;
  /** Electron reveals one server-approved settings location in Finder. */
  revealPath?: (path: string) => void;
  /** Electron opens a broker-validated live Preview URL in the default browser. */
  openExternal?: (url: string) => void;
  /** Hermetic tests inject a non-network GitHub service. */
  githubAppService?: GitHubAppService;
  /** Tests opt in explicitly so parallel app fixtures never inspect user leases. */
  gitSessionMonitoring?: boolean;
  /** Tests opt in explicitly so fixtures never clean real development leases. */
  developmentSessionMonitoring?: boolean;
}

export interface AppHandle {
  server: Server;
  sessions: SessionManager;
  url: string;
  close: () => Promise<void>;
  hooks: AppHooks;
}

/** Pending manifest hand-offs, keyed by state. Short-lived, host memory only. */
const manifestHandoff = new Map<string, { manifest: Record<string, unknown>; action: string; expiresAt: number }>();

/** External-browser landing page after the one-time manifest conversion. */
export function githubManifestCompletePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub connected — Bumper</title>
</head>
<body style="font:16px -apple-system,BlinkMacSystemFont,system-ui;max-width:560px;margin:64px auto;padding:0 24px;line-height:1.5">
<h1>GitHub connected</h1>
<p>The GitHub App was created. Return to the Bumper Mac app, then close this tab.</p>
<p lang="ja">GitHub App を作成しました。Bumper Mac アプリに戻り、このタブを閉じてください。</p>
</body>
</html>`;
}

function stateJson(config: Config, sessions: SessionManager, capabilities: { revealLocations?: boolean } = {}) {
  // Resolve detection once per request: fanning this out across fields is exactly how
  // /api/state grew to 5.6 s (see test/perf-budget.test.mjs).
  const agentDescriptors = detectAgents();
  const active = getActiveContext(config.defaultContext) ?? Object.keys(config.contexts)[0];
  const gitConnections = listGitConnections(config);
  const projectNames = Object.keys(config.contexts);
  const lastEventAtByProject = latestEventAtByContext(projectNames);
  const contexts: Record<string, unknown> = {};
  for (const [name, ctx] of Object.entries(config.contexts)) {
    const effective = effectiveContext(config, name);
    const accessRoots = projectAccessRoots(ctx);
    const folderDraft = draftFromContext(ctx);
    const presence = workspacePresence(ctx.workspace);
    const connection = getGitConnection(config, ctx.gitConnectionId);
    contexts[name] = {
      description: ctx.description ?? "", workspace: ctx.workspace ?? "", mode: ctx.mode,
      inheritMode: ctx.inheritMode, effectiveMode: effective.mode, backends: ctx.backends,
      native: ctx.native, effectiveNative: effective.native, commands: ctx.commands,
      effectiveCommands: effective.commands, writePaths: ctx.writePaths, readPaths: ctx.readPaths,
      denyReadPaths: ctx.denyReadPaths, denyWritePaths: ctx.denyWritePaths,
      effectiveReadPaths: effective.readPaths, effectiveWritePaths: effective.writePaths,
      effectiveDenyReadPaths: effective.denyReadPaths, effectiveDenyWritePaths: effective.denyWritePaths,
      gitIgnored: ctx.gitIgnored, allowedHosts: ctx.allowedHosts, room: ctx.room,
      gitAccess: ctx.gitAccess, gitRepository: ctx.gitRepository, gitWriteUntil: ctx.gitWriteUntil,
      gitProviderConnectionId: ctx.gitProviderConnectionId,
      gitInstallationId: ctx.gitInstallationId,
      gitRepositoryId: ctx.gitRepositoryId,
      // Authoritative Git shape: every bound repository at its own rung.
      gitRepositories: projectGitBindings(ctx),
      gitCapability: projectGitCeiling(ctx),
      autoApprove: ctx.autoApprove === true,
      development: ctx.development,
      loginProfiles: ctx.loginProfiles ?? {},
      appliedPermissionSetup: ctx.appliedPermissionSetup ?? "",
      gitConnectionId: connection?.id ?? "",
      // Connection is a name/host label only — no secret, no access grant.
      gitConnection: connection
        ? {
            id: connection.id,
            name: connection.name,
            provider: connection.provider,
            host: connection.host,
            identity: connection.identity,
          }
        : null,
      mcpBindings: listProjectMcpBindings(config, ctx),
      /** First-class Access summary: workspace + extra dirs/doors used for cwd resolve. */
      access: {
        workspace: ctx.workspace ?? "",
        roots: accessRoots,
        rootCount: accessRoots.length,
      },
      folders: {
        draft: folderDraft,
        matrix: folderMatrix(folderDraft, presence.status === "ok" ? presence.path : undefined),
        workspace: presence,
        runningSessions: runningSessionsForProject(sessions.list(), name).map((s) => ({
          id: s.id,
          agentName: s.agentName,
          status: s.status,
        })),
      },
      // Legacy `repos` is not surfaced. Provider scope comes from the selected
      // GitHub App installation repository + gitAccess instead.
      assurance: roomAssurance(effective),
      imageSource: describeImageSource(ctx.room.image),
      /** Newest Events row for this Project (retention window), ISO; empty if none. */
      lastEventAt: lastEventAtByProject[name] || "",
    };
  }
  const builtinSetups = listBuiltinPermissionSetups();
  const customSetups = Object.fromEntries(
    Object.entries(config.permissionSetups ?? {})
      .filter(([name]) => !isBuiltinTemplateName(name))
      .map(([name, setup]) => [
        name,
        {
          description: setup.description ?? "",
          mode: setup.mode,
          inheritMode: setup.inheritMode,
          repos: setup.repos?.length ?? 0,
          readPaths: setup.readPaths?.length ?? 0,
          writePaths: setup.writePaths?.length ?? 0,
          egress: setup.room?.egress ?? "",
          builtin: false,
        },
      ]),
  );
  const githubApps = Object.entries(config.githubApps ?? {}).map(([connectionId, app]) => {
    const repositories = app.installations.flatMap((installation) => installation.repositories.map((repo) => ({
      id: repo.id,
      fullName: repo.fullName,
      name: repo.fullName.split("/").at(-1) ?? repo.fullName,
      owner: repo.fullName.split("/")[0] ?? "",
      installationId: installation.id,
      connectionId,
    })));
    return {
      ...app,
      id: connectionId,
      connected: new GitHubAppService().forConnection(connectionId).connected(),
      repositories,
    };
  });
  const githubRepositories = githubApps.flatMap((app) => app.repositories);
  const gitSessions = listGitSessionLeases((projectName) => {
    // The lease only needs to know whether this Project grants anything, and
    // whether a temporary elevation is meaningful; the rung per repository is
    // resolved by the broker from the bindings themselves.
    const ceiling = projectGitCeiling(config.contexts[projectName]);
    return ceiling === "none" ? "none" : "read";
  }).map((lease) => ({
    id: lease.id,
    projectName: lease.projectName,
    agentId: lease.agentId,
    agentName: lease.agentName,
    repository: lease.repository,
    startedAt: lease.startedAt,
    heartbeatAt: lease.heartbeatAt,
    live: lease.live,
    enabled: lease.control.enabled,
    writeUntil: lease.control.writeUntil,
    effectiveAccess: lease.effectiveAccess,
  }));
  const developmentSessions = listDevelopmentSessionLeases().map((lease) => ({
    id: lease.id,
    projectName: lease.projectName,
    agentId: lease.agentId,
    agentName: lease.agentName,
    startedAt: lease.startedAt,
    heartbeatAt: lease.heartbeatAt,
    live: lease.live,
    previewEnabled: lease.control.previewEnabled,
    dockerEnabled: lease.control.dockerEnabled,
    previewPorts: lease.runtime.previewPorts,
    previewError: lease.runtime.previewError,
    dockerStatus: lease.runtime.dockerStatus,
    dockerError: lease.runtime.dockerError,
  }));
  return {
    active, contexts, counts: active ? todayCounts(active) : { blocked: 0, allowed: 0 },
    globalPolicy: config.globalPolicy, assuranceLegend: ASSURANCE_LEGEND, egressTemplates: EGRESS_TEMPLATES,
    // The ladder and the App's own ceiling, so the UI states both from one source.
    gitCapabilities: GIT_CAPABILITY_DESCRIPTORS,
    githubAppPermissions: GITHUB_APP_PERMISSIONS,
    folderCapabilities: FOLDER_CAPABILITIES,
    backends: Object.fromEntries(Object.entries(config.backends).map(([name, backend]) => [name, { command: backend.command, args: backend.args, description: backend.description ?? "", envKeys: Object.keys(backend.env) }])),
    permissionSetups: {
      ...Object.fromEntries(
        Object.entries(builtinSetups).map(([name, setup]) => [
          name,
          {
            description: setup.description ?? "",
            mode: setup.mode,
            inheritMode: setup.inheritMode,
            repos: setup.repos?.length ?? 0,
            readPaths: setup.readPaths?.length ?? 0,
            writePaths: setup.writePaths?.length ?? 0,
            egress: setup.room?.egress ?? "",
            builtin: true,
            immutable: true,
          },
        ]),
      ),
      ...customSetups,
    },
    authProfiles: listAuthProfileIds(config),
    /** Which Sandbox CLIs actually receive Hub tools (verified per CLI, not guessed). */
    roomMcpDelivery: roomMcpDeliveryReport(
      agentDescriptors.filter((agent) => agent.roomCommand?.length)
        .map((agent) => ({ id: agent.id, name: agent.name })),
    ),
    /** Library AI rows: real tool × identity instances only (not agent catalog expand). */
    aiLogins: listAiLogins(config, agentDescriptors),
    /** Add-picker type catalog — not listed on Library AI rows. */
    aiAgentCatalog: agentDescriptors
      .filter((agent) => agent.roomCommand?.length)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        shortName: agent.shortName,
        roomCommand: agent.roomCommand,
        detected: agent.detected,
      })),
    /** Public metadata only — secret handles never appear here. */
    gitConnections,
    githubApps,
    gitSessions,
    developmentSessions,
    /** Compatibility aggregate for older renderer/tests; carries no credential selector. */
    githubApp: { connected: githubApps.some((app) => app.connected), repositories: githubRepositories },
    mcpIntegrations: listMcpIntegrations(config),
    mcpConnections: listMcpConnections(config),
    sessions: sessions.list(),
    configPath: resolveConfigPath(),
    stateDir: stateDir(),
    eventsPath: eventLogPath(),
    capabilities: { revealLocations: capabilities.revealLocations === true },
    platform: { macOS: process.platform === "darwin", sandbox: existsSync("/usr/bin/sandbox-exec"), room: existsSync("/usr/local/bin/container"), telemetry: false },
    prefs: readPrefs(),
    recovery: { active: isRecoveryMode(), reason: readRecoveryReason() ?? null },
    protectionMismatches: listProtectionMismatches(),
    configBackups: listConfigBackups().map(({ id, mtimeMs, size }) => ({ id, mtimeMs, size })),
  };
}

function configuredGitAccess(config: Config, projectName: string): GitAccess {
  const ceiling = projectGitCeiling(config.contexts[projectName]);
  if (ceiling === "none") return "none";
  return ceiling === "read" ? "read" : "write";
}

function send(res: ServerResponse, code: number, type: string, body: string | Buffer) {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(body);
}

function json(res: ServerResponse, code: number, value: unknown) {
  send(res, code, "application/json; charset=utf-8", JSON.stringify(value));
}

async function body(req: IncomingMessage): Promise<any> {
  let value = "";
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 1024 * 1024) throw new Error("Request body is too large.");
  }
  return JSON.parse(value || "{}");
}

function validOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
}

function pickFolder(): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile("osascript", ["-e", 'POSIX path of (choose folder with prompt "Choose a workspace for the protected AI session")'],
      { timeout: 120000 }, (error, stdout) => resolvePromise(error ? null : stdout.trim()));
  });
}

function nearestExistingPath(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function writeRawConfig(mutator: (raw: any) => void): void {
  mutateRawConfig((raw) => {
    mutator(raw);
  });
}

function migrateLegacyGitHubApp(config: Config, github: GitHubAppService): void {
  const legacy = config.githubApp;
  if (!legacy) return;
  const connectionId = `gh-${legacy.appId}`;
  if (!github.forConnection(connectionId).migrateLegacySecrets()) return;
  writeRawConfig((raw) => {
    if (!raw.githubApp) return;
    raw.githubApps = raw.githubApps ?? {};
    raw.githubApps[connectionId] = {
      ...raw.githubApp,
      id: connectionId,
      ownerType: raw.githubApp.ownerType ?? raw.githubApp.installations?.[0]?.accountType ?? "",
    };
    for (const project of Object.values(raw.contexts ?? {}) as any[]) {
      if (!project.gitRepository) continue;
      for (const installation of raw.githubApp.installations ?? []) {
        const repo = (installation.repositories ?? []).find(
          (item: any) => String(item.fullName).toLowerCase() === String(project.gitRepository).toLowerCase(),
        );
        if (!repo) continue;
        project.gitProviderConnectionId = connectionId;
        project.gitInstallationId = Number(installation.id);
        project.gitRepositoryId = Number(repo.id);
        break;
      }
      if (!project.gitProviderConnectionId) {
        project.gitAccess = "none";
        project.gitWriteUntil = "";
      }
    }
    delete raw.githubApp;
  });
}

function saveContext(name: string, input: any, previous?: string): void {
  if (!name.trim()) throw new Error("Context name is required.");
  writeRawConfig((raw) => {
    raw.contexts = raw.contexts ?? {};
    const source = previous ? raw.contexts[previous] : raw.contexts[name];
    const loginProfiles: Record<string, string> = {};
    const profileSource = input.loginProfiles && typeof input.loginProfiles === "object"
      ? input.loginProfiles
      : (source?.loginProfiles ?? {});
    for (const [agentId, profileId] of Object.entries(profileSource)) {
      try {
        loginProfiles[String(agentId)] = normalizeAuthProfileId(String(profileId));
      } catch {
        /* skip invalid profile ids */
      }
    }
    // Ensure catalog knows every selected profile.
    raw.authProfiles = Array.isArray(raw.authProfiles) ? raw.authProfiles : [DEFAULT_AUTH_PROFILE];
    for (const id of Object.values(loginProfiles)) {
      if (!raw.authProfiles.includes(id)) raw.authProfiles.push(id);
    }
    /*
     * Git bindings.
     *
     * Every binding is re-verified against the installed repositories of its own
     * connection. A binding the caller cannot prove — wrong connection, wrong
     * installation, repository not installed — is rejected rather than stored,
     * because the broker would otherwise carry an unusable binding all the way
     * to a confusing token failure inside the Sandbox.
     */
    const verifyBinding = (row: any) => {
      const fullName = String(row?.fullName ?? "").trim();
      const connectionId = String(row?.connectionId ?? "").trim();
      const installationId = Number(row?.installationId ?? 0);
      const repositoryId = Number(row?.repositoryId ?? 0);
      if (!fullName) return undefined;
      const installation = (raw.githubApps?.[connectionId]?.installations ?? []).find(
        (item: any) => Number(item.id) === installationId,
      );
      const repository = (installation?.repositories ?? []).find(
        (repo: any) => Number(repo.id) === repositoryId
          && String(repo.fullName).toLowerCase() === fullName.toLowerCase(),
      );
      if (!repository) throw new Error(`Choose ${fullName} from a connected GitHub owner.`);
      return {
        fullName,
        connectionId,
        installationId,
        repositoryId,
        capability: normalizeGitCapability(row?.capability),
      };
    };

    const gitRepositories = Array.isArray(input.gitRepositories)
      ? input.gitRepositories.map(verifyBinding).filter(Boolean)
      // Absent field keeps what is on disk — partial saves must not unbind Git.
      : projectGitBindings(source as never).map((row) => ({ ...row }));

    // The singular fields are still accepted so an older client, and the
    // existing repository-intent flow, can bind one repository as before.
    if (!Array.isArray(input.gitRepositories) && input.gitRepository !== undefined) {
      const single = verifyBinding({
        fullName: input.gitRepository,
        connectionId: input.gitProviderConnectionId ?? source?.gitProviderConnectionId,
        installationId: input.gitInstallationId ?? source?.gitInstallationId,
        repositoryId: input.gitRepositoryId ?? source?.gitRepositoryId,
        capability: input.gitAccess ?? source?.gitAccess,
      });
      gitRepositories.length = 0;
      if (single) gitRepositories.push(single);
    }

    const bindings = projectGitBindings({ gitRepositories } as never);
    const gitWriteUntil = bindings.some((row) => row.capability === "read")
      ? String(input.gitWriteUntil ?? source?.gitWriteUntil ?? "")
      : "";
    const gitMirror = withGitBindings({}, bindings);
    const next = {
      description: String(input.description ?? ""),
      workspace: String(input.workspace ?? "").trim() || undefined,
      mode: input.mode === "read-only" ? "read-only" : "read-write",
      inheritMode: input.inheritMode !== false,
      backends: Array.isArray(input.backends) ? input.backends.filter((item: string) => raw.backends?.[item]) : (source?.backends ?? []),
      policies: source?.policies ?? {},
      native: {
        allow: Array.isArray(input.native?.allow) ? input.native.allow.filter(Boolean) : (source?.native?.allow ?? []),
        deny: Array.isArray(input.native?.deny) ? input.native.deny.filter(Boolean) : (source?.native?.deny ?? []),
      },
      commands: input.commands && typeof input.commands === "object" ? input.commands : (source?.commands ?? {}),
      writePaths: Array.isArray(input.writePaths) ? input.writePaths.filter(Boolean) : [],
      readPaths: Array.isArray(input.readPaths) ? input.readPaths.filter(Boolean) : [],
      denyReadPaths: Array.isArray(input.denyReadPaths) ? input.denyReadPaths.filter(Boolean) : [],
      denyWritePaths: Array.isArray(input.denyWritePaths) ? input.denyWritePaths.filter(Boolean) : [],
      gitIgnored: ["visible", "read-only", "hidden"].includes(input.gitIgnored) ? input.gitIgnored : "visible",
      ...gitMirror,
      gitWriteUntil,
      // Absent field keeps the stored value — partial saves (Folders, Git, …) must not reset it.
      autoApprove: input.autoApprove === undefined ? source?.autoApprove === true : input.autoApprove === true,
      development: {
        preview: {
          enabled: input.development?.preview?.enabled === undefined
            ? source?.development?.preview?.enabled !== false
            : input.development.preview.enabled === true,
        },
        docker: {
          enabled: input.development?.docker?.enabled === undefined
            ? source?.development?.docker?.enabled !== false
            : input.development.docker.enabled === true,
        },
      },
      // Legacy field: preserve whatever is already on disk; never accept UI/API writes.
      repos: Array.isArray(source?.repos) ? [...source.repos] : [],
      gitConnectionId: (() => {
        const rawId = String(input.gitConnectionId ?? source?.gitConnectionId ?? "").trim();
        if (!rawId) return undefined;
        try {
          const id = normalizeGitConnectionId(rawId);
          return raw.gitConnections?.[id] ? id : undefined;
        } catch {
          return undefined;
        }
      })(),
      mcpBindings: (() => {
        const sourceBindings = (source?.mcpBindings && typeof source.mcpBindings === "object")
          ? { ...source.mcpBindings }
          : {};
        const incoming = input.mcpBindings;
        if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
          const next: Record<string, string> = {};
          for (const [integRaw, connRaw] of Object.entries(incoming as Record<string, string>)) {
            try {
              const integId = normalizeMcpId(String(integRaw), "integration id");
              const connId = normalizeMcpId(String(connRaw), "connection id");
              const integ = raw.mcpIntegrations?.[integId];
              const conn = raw.mcpConnections?.[connId];
              if (integ && conn && conn.integrationId === integId) next[integId] = connId;
            } catch {
              /* skip invalid */
            }
          }
          return next;
        }
        return sourceBindings;
      })(),
      allowedHosts: Array.isArray(input.allowedHosts) ? input.allowedHosts.filter(Boolean) : [],
      loginProfiles,
      appliedPermissionSetup: String(input.appliedPermissionSetup ?? source?.appliedPermissionSetup ?? "").trim() || undefined,
      room: {
        enabled: true,
        image: String(input.room?.image ?? source?.room?.image ?? initialRoomImage()).trim() || SAFE_BASE_ROOM_IMAGE,
        // Shared with `bumper network` so the two write paths cannot disagree
        // about what a valid mode or a usable host is.
        ...normalizeEgress(input.room ?? {}),
        workspaceShare: input.room?.workspaceShare === "selected" ? "selected" : "whole",
        shareSubpaths: Array.isArray(input.room?.shareSubpaths)
          ? input.room.shareSubpaths.map((s: any) => String(s).trim()).filter(Boolean)
          : [],
        doors: Array.isArray(input.room?.doors)
          ? input.room.doors
            .filter((door: any) => door?.hostPath)
            .map((door: any) => ({
              hostPath: String(door.hostPath),
              roomPath: String(door.roomPath ?? "/workspace"),
              access: door.access === "read-write" ? "read-write" : "read-only",
            }))
          : [],
      },
    };
    if (previous && previous !== name) delete raw.contexts[previous];
    raw.contexts[name] = next;
    if (!raw.defaultContext || raw.defaultContext === previous) raw.defaultContext = name;
  });
}

function saveGlobalPolicy(input: any): void {
  writeRawConfig((raw) => {
    const source = raw.globalPolicy ?? {};
    raw.globalPolicy = {
      mode: input.mode === "read-only" ? "read-only" : "read-write",
      native: {
        allow: Array.isArray(input.native?.allow) ? input.native.allow.filter(Boolean) : (source.native?.allow ?? []),
        deny: Array.isArray(input.native?.deny) ? input.native.deny.filter(Boolean) : (source.native?.deny ?? []),
      },
      commands: { ...(source.commands ?? {}), ...(input.commands ?? {}) },
      readPaths: Array.isArray(input.readPaths) ? input.readPaths.filter(Boolean) : [],
      writePaths: Array.isArray(input.writePaths) ? input.writePaths.filter(Boolean) : [],
      denyReadPaths: Array.isArray(input.denyReadPaths) ? input.denyReadPaths.filter(Boolean) : [],
      denyWritePaths: Array.isArray(input.denyWritePaths) ? input.denyWritePaths.filter(Boolean) : [],
    };
  });
}

function saveBackend(name: string, input: any, previous?: string): void {
  if (!name.trim() || !String(input.command ?? "").trim()) throw new Error("Connection name and command are required.");
  writeRawConfig((raw) => {
    raw.backends = raw.backends ?? {};
    const source = previous ? raw.backends[previous] : raw.backends[name];
    const env = { ...(source?.env ?? {}) };
    for (const [key, value] of Object.entries(input.env ?? {})) {
      if (value === "" && key in env) continue;
      if (value === "") delete env[key]; else env[key] = value;
    }
    if (previous && previous !== name) {
      delete raw.backends[previous];
      for (const context of Object.values(raw.contexts ?? {}) as any[]) {
        context.backends = (context.backends ?? []).map((backend: string) => backend === previous ? name : backend);
        if (context.policies?.[previous]) { context.policies[name] = context.policies[previous]; delete context.policies[previous]; }
      }
    }
    raw.backends[name] = { command: String(input.command).trim(), args: Array.isArray(input.args) ? input.args : [], description: String(input.description ?? ""), env };
  });
}

function protectionTest(config: Config, contextName: string, workspaceInput: string) {
  if (!config.contexts[contextName]) throw new Error("Unknown project.");
  const context = effectiveContext(config, contextName);
  if (!workspaceInput || !existsSync(workspaceInput)) throw new Error("Choose an existing workspace first.");
  const workspace = realpathSync(workspaceInput);
  const testDir = mkdtempSync(join(workspace, ".bumper-protection-test-"));
  const outside = join(homedir(), `.bumper-outside-probe-${process.pid}-${Date.now()}`);
  writeFileSync(outside, "private probe\n", { mode: 0o600 });
  const ignored = context.gitIgnored === "visible" ? [] : gitIgnoredPaths(workspace);
  const profile = buildProfile(context, {
    workspace,
    deniedReadPaths: context.gitIgnored === "hidden" ? ignored : [],
    deniedWritePaths: context.gitIgnored === "visible" ? [] : ignored,
  });
  const run = (args: string[]) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, ...args], { encoding: "utf8", timeout: 5000 });
  try {
    const inside = join(testDir, "inside.txt");
    const insideResult = run(["/usr/bin/touch", inside]);
    const outsideWrite = run(["/usr/bin/touch", `${outside}-write`]);
    const outsideRead = run(["/bin/cat", outside]);
    const result = {
      workspaceWriteAllowed: insideResult.status === 0 && existsSync(inside),
      workspaceWriteExpected: context.mode === "read-write",
      outsideWriteBlocked: outsideWrite.status !== 0 && !existsSync(`${outside}-write`),
      outsideReadBlocked: outsideRead.status !== 0,
      sandboxAvailable: existsSync("/usr/bin/sandbox-exec"),
    };
    const passed = result.workspaceWriteAllowed === result.workspaceWriteExpected && result.outsideWriteBlocked && result.outsideReadBlocked && result.sandboxAvailable;
    logEvent({ context: contextName, surface: "sandbox", decision: passed ? "allowed" : "blocked", target: "Protection self-test", reason: passed ? "all containment checks passed" : "one or more containment checks failed" });
    return { ...result, passed };
  } finally {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(outside, { force: true });
    rmSync(`${outside}-write`, { force: true });
  }
}

function pathAccessTest(config: Config, contextName: string, workspaceInput: string, pathInput: string) {
  if (!config.contexts[contextName]) throw new Error("Unknown project.");
  if (!workspaceInput || !existsSync(workspaceInput)) throw new Error("Choose an existing workspace first.");
  if (!pathInput || !existsSync(pathInput)) throw new Error("Choose an existing folder to test.");
  const context = effectiveContext(config, contextName);
  const workspace = realpathSync(workspaceInput);
  const target = realpathSync(pathInput);
  const ignored = context.gitIgnored === "visible" ? [] : gitIgnoredPaths(workspace);
  const profile = buildProfile(context, {
    workspace,
    deniedReadPaths: context.gitIgnored === "hidden" ? ignored : [],
    deniedWritePaths: context.gitIgnored === "visible" ? [] : ignored,
  });
  const run = (args: string[]) => spawnSync("/usr/bin/sandbox-exec", ["-p", profile, ...args], { encoding: "utf8", timeout: 5000 });
  const probe = join(target, `.bumper-access-probe-${process.pid}-${Date.now()}`);
  const read = run(["/bin/ls", "-la", target]);
  const write = run(["/usr/bin/touch", probe]);
  const readAllowed = read.status === 0;
  const writeAllowed = write.status === 0 && existsSync(probe);
  rmSync(probe, { force: true });
  logEvent({ context: contextName, surface: "sandbox", decision: "allowed", target: `Path test ${target}`, reason: `read ${readAllowed ? "allowed" : "blocked"}; write ${writeAllowed ? "allowed" : "blocked"}` });
  // Explicit legacy identifier — not Room VM assurance. API consumers must not treat this as sealed Sandbox.
  return { path: target, readAllowed, writeAllowed, assurance: "legacy-seatbelt" };
}

function setProjectRoomImage(contextName: string, image: string): void {
  writeRawConfig((raw) => {
    if (!raw.contexts?.[contextName]) throw new Error("Unknown project.");
    raw.contexts[contextName].room = {
      ...(raw.contexts[contextName].room ?? {}),
      enabled: true,
      image,
    };
  });
}

async function roomAgentPreflight(config: Config, input: any) {
  const contextName = String(input.context ?? "");
  if (!config.contexts[contextName]) throw new Error("Unknown project.");
  const agent = getAgent(String(input.agentId ?? ""));
  if (!agent) throw new Error("Unknown AI tool.");
  if (!agent.roomCommand.length) throw new Error(`${agent.name} does not have a Sandbox command mapping yet.`);
  if (!input.workspace || !existsSync(input.workspace)) throw new Error("Choose an existing workspace first.");
  const context = effectiveContext(config, contextName);
  if (!context.room.enabled) throw new Error("Enable Sandbox backend in this project before checking the image.");
  const workspace = realpathSync(input.workspace);
  const backend = new AppleContainerBackend();
  const availability = await backend.check();
  if (!availability.usable) {
    return {
      available: false, ok: false, context: contextName, workspace, agentId: agent.id,
      agentName: agent.name, image: context.room.image, command: agent.roomCommand,
      executable: agent.roomCommand[0], detail: availability.detail,
    };
  }
  // Match launch mounts (auth doors + project doors + login profile) so preflight
  // cannot pass when an auth overlay would hide the CLI binary at real start.
  const profileId = projectAuthProfileId(context, agent.id);
  const spec = roomSpecForAgentLaunch(context, workspace, agent.id, {
    mountAuth: true,
    profileId,
    projectName: contextName,
  });
  const preflight = roomExecutablePreflight(agent.roomCommand);
  const result = await backend.run(spec, preflight.command);
  const ok = result.exitCode === 0;
  const detail = ok
    ? roomPreflightSuccessDetail(agent.name, preflight.executable, spec.image)
    : roomPreflightFailureDetail(agent.name, agent.roomCommand, spec.image, result);
  logEvent({ context: contextName, surface: "session", decision: ok ? "allowed" : "blocked", target: `${agent.name} Sandbox image preflight`, reason: detail });
  return {
    available: true, ok, context: contextName, workspace, agentId: agent.id, agentName: agent.name,
    image: spec.image, command: agent.roomCommand, executable: preflight.executable, exitCode: result.exitCode, detail,
    authMounts: spec.doors.filter((door) => door.roomPath.startsWith("/root/.")).map((door) => door.roomPath),
  };
}

/**
 * Read-only plan for the AI proof: same probe list `runAiProof` will execute,
 * without starting a backend or requiring Apple container. Cheap and pure.
 * Missing/invalid workspace still returns what can be derived; unknown context
 * returns an empty list — never a 500.
 */
function roomAiProofPlan(config: Config, contextName: string) {
  const name = String(contextName ?? "").trim();
  if (!name || !config.contexts[name]) {
    return { context: name, probes: [] as ReturnType<typeof aiProofProbes> };
  }
  const context = effectiveContext(config, name);
  // Prefer the bound workspace when it exists; otherwise any path is fine —
  // roomSpecForContext only needs a string to materialize doors, not a live mount.
  const bound = typeof context.workspace === "string" ? context.workspace.trim() : "";
  const workspace = bound && existsSync(bound)
    ? realpathSync(bound)
    : bound || "/workspace";
  try {
    const spec = roomSpecForContext(context, workspace);
    const probes = aiProofProbes(context, spec.doors);
    return { context: name, probes };
  } catch {
    // Still never 500: fall back to policy-only probes with no extra doors.
    return { context: name, probes: aiProofProbes(context, []) };
  }
}

async function roomAiProof(config: Config, input: any) {
  const contextName = String(input.context ?? "");
  if (!config.contexts[contextName]) throw new Error("Unknown project.");
  if (!input.workspace || !existsSync(input.workspace)) throw new Error("Choose an existing workspace first.");
  const context = effectiveContext(config, contextName);
  if (!context.room.enabled) throw new Error("Enable Sandbox backend in this project before running the safety proof.");
  const workspace = realpathSync(input.workspace);
  const backend = new AppleContainerBackend();
  const availability = await backend.check();
  if (!availability.usable) {
    // No room, no evidence. An empty result set is honest; a host-side stand-in
    // scored as a boundary check would not be.
    return {
      available: false, detail: availability.detail, context: contextName, workspace, results: [],
      mismatch: getProtectionMismatch(contextName) ?? null,
      launchBlocked: blocksProtectedLaunch(contextName),
    };
  }
  const spec = roomSpecForContext(context, workspace);
  const results = await runAiProof(backend, spec, context);
  const failed = results.filter((r) => !r.pass);
  const passed = results.length - failed.length;
  const allMatch = failed.length === 0;
  if (allMatch) {
    clearProtectionMismatch(contextName);
  } else {
    setProtectionMismatch(
      contextName,
      failed.map((r) => r.id),
      `${failed.length} diagnostic check(s) did not match Expected vs Observed`,
    );
  }
  logEvent({
    context: contextName, surface: "session", source: "app", type: "system",
    decision: allMatch ? "allowed" : "failed",
    target: "Security diagnostics",
    reason: `${passed}/${results.length} checks matched the promised boundary`,
  });
  return {
    available: true, detail: availability.detail, context: contextName, workspace, image: spec.image, results,
    mismatch: getProtectionMismatch(contextName) ?? null,
    launchBlocked: blocksProtectedLaunch(contextName),
  };
}

function buildDiagnosticsReport(payload: {
  context: string;
  workspace?: string;
  image?: string;
  detail?: string;
  results: Array<{
    id: string; title: string; expect: string; observed: string; pass: boolean; evidence: string;
    description?: string; command?: string[]; stdout?: string; exitCode?: number; durationMs?: number;
  }>;
}) {
  return {
    kind: "bumper-security-diagnostics",
    version: 1,
    generatedAt: new Date().toISOString(),
    project: payload.context,
    workspace: payload.workspace ?? null,
    image: payload.image ?? null,
    runtimeDetail: payload.detail ?? null,
    results: payload.results.map((r) => ({
      id: r.id,
      title: r.title,
      // The executed command and its raw verdict travel with the report: a
      // diagnostics export that says "pass" without saying what was run is an
      // assertion, not evidence.
      attempted: r.description ?? null,
      command: r.command ?? null,
      expected: r.expect,
      observed: r.observed,
      match: r.pass,
      evidence: r.evidence,
      stdout: r.stdout ?? null,
      exitCode: r.exitCode ?? null,
      durationMs: r.durationMs ?? null,
    })),
    note: "Metadata only — no file contents, prompts, tokens, or headers.",
  };
}

function openOrDescribeTerminal(
  hooks: AppHooks,
  sessions: SessionManager,
  session: { id: string; agentName?: string; windowKey?: string; kind?: string; profileId?: string; agentId?: string },
): TerminalWindowResult & { electron: boolean } {
  const windowKey = terminalWindowFocusKey(session.id, session.windowKey);
  const urlPath = `/terminal.html?session=${encodeURIComponent(session.id)}`;
  if (hooks.openTerminalWindow) {
    const result = hooks.openTerminalWindow({
      sessionId: session.id,
      windowKey,
      title: session.agentName || "Bumper terminal",
    });
    return { ...result, electron: true };
  }
  // HTTP / test mode: renderer may window.open the URL; no Electron utility window.
  const existing = sessions.findRunningByWindowKey(windowKey);
  return {
    ok: true,
    focused: Boolean(existing && existing.id === session.id),
    created: !existing || existing.id === session.id,
    url: urlPath,
    electron: false,
  };
}

export async function startApp(
  config: Config,
  reload: () => Config,
  binPath: string,
  hooks: AppHooks = {},
): Promise<AppHandle> {
  // One-shot: drop obsolete host token store so pasted PATs do not linger on disk.
  purgeLegacyGitConnectionSecrets();
  const githubApp = hooks.githubAppService ?? new GitHubAppService();
  migrateLegacyGitHubApp(config, githubApp);
  // Best effort after an interrupted previous run. GitHub's one-hour expiry is
  // still the hard upper bound if the app cannot start or is offline.
  const startupSweepConnections = new Set([
    ...Object.keys(reload().githubApps ?? {}),
    ...(reload().githubTokenSweepConnections ?? []),
  ]);
  for (const connectionId of startupSweepConnections) {
    void githubApp.forConnection(connectionId).sweep().then((result) => {
      if (result.pending !== 0) return;
      if (!(reload().githubTokenSweepConnections ?? []).includes(connectionId)) return;
      writeRawConfig((raw) => {
        raw.githubTokenSweepConnections = (raw.githubTokenSweepConnections ?? [])
          .filter((id: string) => id !== connectionId);
      });
    }).catch(() => { /* GitHub expiry remains the one-hour hard upper bound */ });
  }
  let gitSessionSweepRunning = false;
  const sweepLostGitSessions = async (): Promise<void> => {
    if (gitSessionSweepRunning) return;
    gitSessionSweepRunning = true;
    try {
      const cfg = reload();
      const lost = listGitSessionLeases(
        (projectName) => configuredGitAccess(cfg, projectName),
      ).filter((lease) => !lease.live);
      for (const lease of lost) {
        const connectionIds = lease.connectionId
          ? [lease.connectionId]
          : Object.keys(cfg.githubApps ?? {});
        let revoked = 0;
        let pending = 0;
        for (const connectionId of connectionIds) {
          try {
            const result = await githubApp.forConnection(connectionId).revokeSession(lease.id);
            revoked += result.revoked;
            pending += result.pending;
          } catch {
            pending += 1;
          }
        }
        if (pending && lease.connectionId) {
          writeRawConfig((raw) => {
            raw.githubTokenSweepConnections = [
              ...new Set([...(raw.githubTokenSweepConnections ?? []), lease.connectionId]),
            ];
          });
        }
        logEvent({
          context: lease.projectName,
          surface: "session",
          source: "app",
          type: "git",
          decision: pending ? "failed" : "allowed",
          target: "Git Session lease expired",
          reason: pending
            ? `heartbeat or host process was lost; ${revoked} token(s) revoked, ${pending} pending until retry or GitHub expiry`
            : `heartbeat or host process was lost; ${revoked} token(s) revoked`,
          sessionId: lease.id,
          repository: lease.repository,
          access: "none",
        });
        removeGitSessionLease(lease.id);
      }
    } finally {
      gitSessionSweepRunning = false;
    }
  };
  const monitorGitSessions = process.env.NODE_TEST_CONTEXT
    ? hooks.gitSessionMonitoring === true
    : hooks.gitSessionMonitoring !== false;
  const gitSessionSweepTimer = monitorGitSessions
    ? setInterval(() => void sweepLostGitSessions(), 1_000)
    : undefined;
  gitSessionSweepTimer?.unref?.();
  if (monitorGitSessions) void sweepLostGitSessions();
  const sweepLostDevelopmentSessions = (): void => {
    for (const lease of listDevelopmentSessionLeases().filter((item) => !item.live)) {
      const safe = lease.id.replace(/[^a-zA-Z0-9]/g, "");
      const engineName = `bumper-docker-${safe.slice(0, 20)}`;
      execFile("/usr/local/bin/container", ["stop", engineName], () => {
        execFile("/usr/local/bin/container", ["delete", "--force", engineName], () => {});
      });
      for (const socket of [
        `/tmp/bumper-preview-room-${safe.slice(0, 16)}.sock`,
        `/tmp/bumper-preview-docker-${safe.slice(0, 16)}.sock`,
      ]) {
        try { rmSync(socket, { force: true }); } catch { /* best effort */ }
      }
      for (const dir of [
        join(stateDir(), "room-preview-broker", lease.id),
        join(stateDir(), "room-docker-preview-broker", lease.id),
        join(stateDir(), "room-docker-broker", lease.id),
      ]) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      removeDevelopmentSessionLease(lease.id);
      logEvent({
        context: lease.projectName,
        surface: "session",
        source: "app",
        type: "system",
        decision: "blocked",
        target: "Development Session lease expired",
        reason: "heartbeat or host process was lost; Preview listeners removed and Docker Engine Sandbox stopped",
        sessionId: lease.id,
      });
    }
  };
  const monitorDevelopmentSessions = process.env.NODE_TEST_CONTEXT
    ? hooks.developmentSessionMonitoring === true
    : hooks.developmentSessionMonitoring !== false;
  const developmentSessionSweepTimer = monitorDevelopmentSessions
    ? setInterval(sweepLostDevelopmentSessions, 1_000)
    : undefined;
  developmentSessionSweepTimer?.unref?.();
  if (monitorDevelopmentSessions) sweepLostDevelopmentSessions();
  let sessions!: SessionManager;
  // Live build log so the UI can poll progress while a Sandbox image builds.
  const buildProgress: { active: boolean; lines: string[]; result?: RoomBuildResult } = { active: false, lines: [] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method !== "GET" && !validOrigin(req)) return json(res, 403, { error: "Untrusted request origin." });
      if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", APP_HTML);
      if (url.pathname === "/app.css") return send(res, 200, "text/css; charset=utf-8", APP_CSS);
      if (url.pathname === "/launch-gate.js") return send(res, 200, "text/javascript; charset=utf-8", APP_LAUNCH_GATE_JS);
      if (url.pathname === "/app.js") return send(res, 200, "text/javascript; charset=utf-8", APP_JS);
      if (url.pathname === "/github-app-badge.svg") {
        return send(res, 200, "image/svg+xml; charset=utf-8", GITHUB_APP_BADGE_SVG);
      }
      if (url.pathname === "/github-app-badge.png") {
        // Force download with a clear filename; binary Buffer (not string).
        const png = GITHUB_APP_BADGE_PNG;
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(png.length),
          "content-disposition": 'attachment; filename="bumper-github-app-badge.png"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(png);
        return;
      }
      if (url.pathname === "/terminal.html") return send(res, 200, "text/html; charset=utf-8", TERMINAL_HTML);
      if (url.pathname === "/terminal.js") return send(res, 200, "text/javascript; charset=utf-8", TERMINAL_JS);
      const vendor = VENDOR[url.pathname];
      if (vendor) return send(res, 200, vendor.type, readFileSync(vendor.file, "utf8"));
      if (url.pathname === "/api/state") {
        return json(res, 200, stateJson(reload(), sessions, {
          revealLocations: Boolean(hooks.revealPath),
        }));
      }
      if (url.pathname === "/github/manifest/callback" && req.method === "GET") {
        let completedConnectionId = "";
        try {
          // GitHub echoes the state it was given on the POST target. Fall back to
          // the single pending state if it ever arrives without one.
          const returned = String(url.searchParams.get("state") ?? "") || (githubApp.manifestState()?.state ?? "");
          const app = await githubApp.completeManifest(String(url.searchParams.get("code") ?? ""), returned);
          completedConnectionId = app.id;
          writeRawConfig((raw) => {
            raw.githubApps = raw.githubApps ?? {};
            const replacement = raw.githubApps[app.id];
            if (replacement?.ownerLogin && app.ownerLogin
              && String(replacement.ownerLogin).toLowerCase() !== String(app.ownerLogin).toLowerCase()) {
              throw new Error(`Reconnect must use the existing GitHub owner ${replacement.ownerLogin}.`);
            }
            if (replacement?.ownerType && app.ownerType
              && String(replacement.ownerType).toLowerCase() !== String(app.ownerType).toLowerCase()) {
              throw new Error("Reconnect must keep the existing personal or Organization account type.");
            }
            const duplicate = Object.entries(raw.githubApps).find(
              ([id, existing]: [string, any]) => id !== app.id
                && Boolean(app.ownerLogin)
                && String(existing.ownerLogin).toLowerCase() === String(app.ownerLogin).toLowerCase(),
            );
            if (duplicate) throw new Error(`GitHub owner ${app.ownerLogin} is already connected.`);
            raw.githubApps[app.id] = {
              id: app.id,
              appId: app.appId,
              slug: app.slug,
              ownerLogin: app.ownerLogin ?? "",
              ownerType: app.ownerType ?? "",
              installations: [],
            };
          });
          return send(res, 200, "text/html; charset=utf-8", githubManifestCompletePage());
        } catch (error) {
          if (completedConnectionId) {
            try { await githubApp.forConnection(completedConnectionId).disconnect(); } catch { /* no token was issued yet */ }
          }
          return send(res, 400, "text/html; charset=utf-8", `<!doctype html><title>Bumper</title><p>${String((error as Error).message).replace(/</g, "&lt;")}</p>`);
        }
      }
      if (url.pathname === "/api/github/connect" && req.method === "POST") {
        const input = await body(req);
        const accountType = input.accountType === "organization"
          ? "organization"
          : input.accountType === "personal" ? "personal" : (input.organization ? "organization" : "personal");
        const organization = accountType === "organization"
          ? parseGitHubOwnerInput(input.organization)
          : undefined;
        if (accountType === "organization" && !organization) {
          return json(res, 400, { error: "Enter an Organization name or GitHub Organization URL." });
        }
        const requestedReplacement = String(input.replaceConnectionId ?? "").trim();
        const replacement = requestedReplacement ? reload().githubApps?.[requestedReplacement] : undefined;
        if (requestedReplacement && !replacement) {
          return json(res, 404, { error: "The GitHub connection to replace no longer exists." });
        }
        if (replacement && githubApp.forConnection(requestedReplacement).connected()) {
          return json(res, 409, { error: "This GitHub connection is still usable; Refresh it instead." });
        }
        if (replacement && organization
          && String(replacement.ownerLogin ?? "").toLowerCase() !== organization.toLowerCase()) {
          return json(res, 409, { error: "Reconnect must use the same GitHub owner." });
        }
        if (replacement) {
          const replacementIsOrganization = String(replacement.ownerType ?? "").toLowerCase() === "organization";
          if ((accountType === "organization") !== replacementIsOrganization) {
            return json(res, 409, { error: "Reconnect must keep the existing personal or Organization account type." });
          }
        }
        const state = randomUUID();
        const connectionId = requestedReplacement || `gh-${randomUUID()}`;
        const pending = githubApp.beginManifest(state, organization || undefined, connectionId);
        const host = req.headers.host ?? "127.0.0.1";
        /*
         * The state rides on the POST target, not inside redirect_url. GitHub
         * validates redirect_url and rejects one carrying a query string with
         * "redirect_url must be a valid URL" — reproduced in a browser against
         * loopback and against a public https host alike, while GitHub's own
         * documented example (no query) passes. GitHub echoes the state back on
         * the redirect.
         */
        const callback = `http://${host}/github/manifest/callback`;
        const createPath = organization
          ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
          : "https://github.com/settings/apps/new";
        manifestHandoff.set(state, {
          manifest: githubAppManifest(callback, `Bumper Git access ${state.slice(0, 8)}`),
          action: `${createPath}?state=${encodeURIComponent(state)}`,
          expiresAt: pending.expiresAt,
        });
        // The browser must perform the POST itself. Handing a POST form to the OS
        // browser loses the body (Electron's window-open handler forwards a URL
        // only), which lands the user on a blank "Create GitHub App" form.
        return json(res, 200, { state, connectionId, expiresAt: pending.expiresAt, startUrl: `http://${host}/github/manifest/start?state=${encodeURIComponent(state)}` });
      }
      if (url.pathname === "/api/github/repository-intent" && req.method === "POST") {
        const input = await body(req);
        const cfg = reload();
        const project = cfg.contexts[String(input.context ?? "")] ?? {};
        const connections = Object.entries(cfg.githubApps ?? {}).map(([connectionId, app]) => ({
          id: connectionId,
          ownerLogin: app.ownerLogin,
          ownerType: app.ownerType,
          connected: githubApp.forConnection(connectionId).connected(),
          installations: app.installations,
        }));
        return json(res, 200, resolveGitHubRepositoryIntent(input.repository, connections, project));
      }
      /*
       * Local hand-off page: opened with GET in the external browser, it submits the
       * manifest to GitHub as a real POST from that browsing context.
       */
      if (url.pathname === "/github/manifest/start" && req.method === "GET") {
        const state = String(url.searchParams.get("state") ?? "");
        const entry = manifestHandoff.get(state);
        if (!entry || entry.expiresAt < Date.now()) {
          return send(res, 400, "text/html; charset=utf-8",
            "<!doctype html><title>Bumper</title><p>This GitHub setup link has expired. Press Connect GitHub in Bumper again.</p>");
        }
        manifestHandoff.delete(state);
        const payload = JSON.stringify(entry.manifest)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        return send(res, 200, "text/html; charset=utf-8",
          `<!doctype html><title>Bumper — creating your GitHub App</title>
<body style="font:14px -apple-system,system-ui;margin:40px">
<p>Opening GitHub…</p>
<p>If nothing happens, press the button.</p>
<form id="f" method="POST" action="${entry.action.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">
<input type="hidden" name="manifest" value="${payload}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById("f").submit()</script>`);
      }
      if (url.pathname === "/api/github/installations/refresh" && req.method === "POST") {
        try {
          const input = await body(req);
          const connectionId = String(input.connectionId ?? "").trim();
          if (!connectionId || !reload().githubApps?.[connectionId]) throw new Error("Choose a GitHub connection.");
          const installations = await githubApp.forConnection(connectionId).installations();
          writeRawConfig((raw) => {
            if (!raw.githubApps?.[connectionId]) throw new Error("Connect GitHub first.");
            // Shared with `bumper github refresh` — a field dropped on one path
            // makes a repository unbindable there and nowhere else.
            raw.githubApps[connectionId].installations = storedInstallations(installations);
            raw.githubApps[connectionId].lastRefreshedAt = new Date().toISOString();
          });
          const summary = summarizeRefresh(connectionId, installations);
          return json(res, 200, {
            ok: true,
            installations: summary.installations,
            repositories: summary.repositories,
            allRepositories: summary.allRepositories,
          });
        } catch (error) {
          return json(res, 400, { error: (error as Error).message });
        }
      }
      if (url.pathname === "/api/github/disconnect" && req.method === "POST") {
        const input = await body(req);
        const connectionId = String(input.connectionId ?? "").trim();
        if (!connectionId || !reload().githubApps?.[connectionId]) {
          return json(res, 404, { error: "Unknown GitHub connection." });
        }
        const revoked = await githubApp.forConnection(connectionId).disconnect();
        writeRawConfig((raw) => {
          raw.githubTokenSweepConnections = (raw.githubTokenSweepConnections ?? [])
            .filter((id: string) => id !== connectionId);
          if (revoked.pendingRevocations) raw.githubTokenSweepConnections.push(connectionId);
          delete raw.githubApps?.[connectionId];
          /*
           * Disconnecting one owner must take away only that owner's
           * repositories. A Project binding repos from two owners keeps the
           * other owner's access — the whole point of per-owner connections.
           */
          for (const project of Object.values(raw.contexts ?? {}) as any[]) {
            const remaining = projectGitBindings(project)
              .filter((row) => row.connectionId !== connectionId);
            if (remaining.length === projectGitBindings(project).length) continue;
            Object.assign(project, withGitBindings(project, remaining));
            if (!remaining.length) project.gitWriteUntil = "";
          }
        });
        return json(res, 200, { ok: true, ...revoked });
      }
      if (url.pathname === "/api/github/session-access" && req.method === "POST") {
        const input = await body(req);
        let result;
        try {
          result = await setGitSessionAccess({
            config: reload(),
            sessionId: String(input.sessionId ?? ""),
            action: String(input.action ?? "") as GitSessionAction,
            revokeSession: (connectionId, sessionId) =>
              githubApp.forConnection(connectionId).revokeSession(sessionId),
          });
        } catch (err) {
          if (isOperationError(err)) return json(res, statusForOperationError(err), { error: err.message });
          throw err;
        }
        if (result.pendingConnections.length) {
          writeRawConfig((raw) => {
            raw.githubTokenSweepConnections = mergeSweepConnections(
              raw.githubTokenSweepConnections,
              result.pendingConnections,
            );
          });
        }
        return json(res, 200, {
          ok: true,
          sessionId: result.sessionId,
          access: result.effectiveAccess,
          enabled: result.enabled,
          writeUntil: result.writeUntil,
          revoked: result.revoked,
          pending: result.pendingConnections.length,
        });
      }

      if (url.pathname === "/api/development/session-control" && req.method === "POST") {
        const input = await body(req);
        const sessionId = String(input.sessionId ?? "").trim();
        const capability = String(input.capability ?? "").trim();
        if (!/^[a-zA-Z0-9-]{8,96}$/.test(sessionId)) {
          return json(res, 400, { error: "Invalid Development Session id." });
        }
        const lease = readDevelopmentSessionLease(sessionId);
        if (!lease?.live) {
          return json(res, 409, { error: "This Development Session is no longer live." });
        }
        if (capability !== "preview" && capability !== "docker") {
          return json(res, 400, { error: "Unknown development capability." });
        }
        const enabled = input.enabled === true;
        const control = updateDevelopmentSessionControl(sessionId, capability === "preview"
          ? { previewEnabled: enabled }
          : { dockerEnabled: enabled });
        logEvent({
          context: lease.projectName,
          surface: "session",
          source: "app",
          type: capability === "preview" ? "network" : "system",
          decision: enabled ? "allowed" : "blocked",
          target: `${capability === "preview" ? "Local Preview" : "Docker"} ${enabled ? "enabled" : "disabled"}`,
          reason: "Session control changed in Project → Development",
          sessionId,
        });
        return json(res, 200, { ok: true, sessionId, ...control });
      }
      if (url.pathname === "/api/development/open-preview" && req.method === "POST") {
        const input = await body(req);
        const sessionId = String(input.sessionId ?? "").trim();
        const hostPort = Number(input.hostPort);
        const lease = readDevelopmentSessionLease(sessionId);
        const mapping = lease?.live && lease.control.previewEnabled
          ? lease.runtime.previewPorts.find((port) => port.hostPort === hostPort)
          : undefined;
        if (!mapping || mapping.url !== `http://127.0.0.1:${hostPort}`) {
          return json(res, 409, { error: "This Local Preview mapping is no longer live." });
        }
        hooks.openExternal?.(mapping.url);
        return json(res, 200, { ok: true, url: mapping.url, opened: Boolean(hooks.openExternal) });
      }
      if (url.pathname === "/api/github/write-window" && req.method === "POST") {
        const input = await body(req);
        const contextName = String(input.context ?? "").trim();
        const cfg = reload();
        const project = cfg.contexts[contextName];
        if (!project) return json(res, 404, { error: "Unknown Project." });
        if (!project.gitProviderConnectionId || !cfg.githubApps?.[project.gitProviderConnectionId]
          || !project.gitRepository || project.gitAccess !== "read") {
          return json(res, 409, { error: "Temporary write requires a connected repository with persistent Read access." });
        }
        const until = new Date(Date.now() + 15 * 60_000).toISOString();
        writeRawConfig((raw) => { raw.contexts[contextName].gitWriteUntil = until; });
        const revocation = await githubApp.forConnection(project.gitProviderConnectionId).revokeProject(contextName);
        logEvent({
          context: contextName,
          surface: "session",
          source: "app",
          type: "git",
          decision: "allowed",
          target: "Temporary Git write access started",
          reason: `write scope until ${until}; prior token revocations pending: ${revocation.pending}`,
        });
        return json(res, 200, { ok: true, until, ...revocation });
      }
      if (url.pathname === "/api/github/write-window" && req.method === "DELETE") {
        const input = await body(req);
        const contextName = String(input.context ?? "").trim();
        const project = reload().contexts[contextName];
        if (!project) return json(res, 404, { error: "Unknown Project." });
        writeRawConfig((raw) => { raw.contexts[contextName].gitWriteUntil = ""; });
        const revocation = project.gitProviderConnectionId
          ? await githubApp.forConnection(project.gitProviderConnectionId).revokeProject(contextName)
          : { revoked: 0, pending: 0 };
        logEvent({
          context: contextName,
          surface: "session",
          source: "app",
          type: "git",
          decision: revocation.pending ? "failed" : "allowed",
          target: "Temporary Git write access ended",
          reason: revocation.pending
            ? `${revocation.pending} token revocation(s) pending; GitHub expiry remains the one-hour hard upper bound`
            : "issued Project tokens revoked",
        });
        return json(res, 200, { ok: true, ...revocation });
      }
      if (url.pathname === "/api/agents") {
        const cfg = reload();
        const projectName = url.searchParams.get("context") || getActiveContext(cfg.defaultContext) || Object.keys(cfg.contexts)[0];
        const project = projectName ? cfg.contexts[projectName] : undefined;
        const explicitProfile = url.searchParams.get("profile");
        return json(res, 200, detectAgents().map(({ readPaths: _paths, ...agent }) => {
          const profileId = explicitProfile
            ? normalizeAuthProfileId(explicitProfile)
            : projectAuthProfileId(project, agent.id);
          const auth = profileAuthStatus(agent.id, profileId);
          return {
            ...agent,
            profileId,
            signedIn: auth.persisted,
            roomAuthPaths: roomAuthPaths(agent.id),
            authStatus: auth.status,
            authVerifiedAt: auth.verifiedAt,
            historyStatePath: projectName ? projectAgentStatePath(projectName, agent.id) : undefined,
            /** Auth is never a hard launch gate for bumper <cli>. */
            authLaunchGate: false,
          };
        }));
      }
      if (url.pathname === "/api/events") {
        const decision = url.searchParams.get("decision") as Decision | null;
        const surface = url.searchParams.get("surface") as Surface | null;
        const source = url.searchParams.get("source") as EventSource | null;
        const type = url.searchParams.get("type") as EventType | null;
        const context = url.searchParams.get("context") ?? undefined;
        const sinceParam = url.searchParams.get("since");
        const untilParam = url.searchParams.get("until");
        const grouped = url.searchParams.get("grouped") === "1" || url.searchParams.get("grouped") === "true";
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
        const since = sinceParam ? new Date(sinceParam) : undefined;
        const until = untilParam ? new Date(untilParam) : undefined;
        // Fetch a wider window then filter so grouped mode still has members.
        const events = readEvents({
          limit: grouped ? Math.min(limit * 20, 5000) : limit,
          decision: decision ?? undefined,
          context,
          surface: surface ?? undefined,
          source: source ?? undefined,
          type: type ?? undefined,
          since: since && !Number.isNaN(since.getTime()) ? since : undefined,
          until: until && !Number.isNaN(until.getTime()) ? until : undefined,
        }).map(normalizeEvent);
        if (grouped) return json(res, 200, { grouped: true, groups: groupEvents(events).slice(0, limit) });
        return json(res, 200, events.slice(0, limit));
      }
      if (url.pathname === "/api/events/export") {
        const decision = url.searchParams.get("decision") as Decision | null;
        const surface = url.searchParams.get("surface") as Surface | null;
        const source = url.searchParams.get("source") as EventSource | null;
        const type = url.searchParams.get("type") as EventType | null;
        const context = url.searchParams.get("context") ?? undefined;
        const sinceParam = url.searchParams.get("since");
        const untilParam = url.searchParams.get("until");
        const since = sinceParam ? new Date(sinceParam) : undefined;
        const until = untilParam ? new Date(untilParam) : undefined;
        const events = readEvents({
          limit: 10000,
          context,
          decision: decision ?? undefined,
          surface: surface ?? undefined,
          source: source ?? undefined,
          type: type ?? undefined,
          since: since && !Number.isNaN(since.getTime()) ? since : undefined,
          until: until && !Number.isNaN(until.getTime()) ? until : undefined,
        }).map(normalizeEvent);
        return send(res, 200, "application/json; charset=utf-8", JSON.stringify(events, null, 2));
      }
      if (url.pathname === "/api/prefs" && req.method === "GET") {
        return json(res, 200, readPrefs());
      }
      if (url.pathname === "/api/prefs" && req.method === "PUT") {
        const input = await body(req);
        const patch: { eventRetention?: EventRetention; language?: "en" | "ja" } = {};
        if (input.eventRetention === "off" || input.eventRetention === "session" || input.eventRetention === "7d" || input.eventRetention === "30d") {
          patch.eventRetention = input.eventRetention;
        }
        if (input.language === "en" || input.language === "ja") patch.language = input.language;
        const prefs = writePrefs(patch);
        if (patch.eventRetention) pruneEvents(prefs.eventRetention);
        return json(res, 200, prefs);
      }
      if (url.pathname === "/api/reveal-location" && req.method === "POST") {
        if (!hooks.revealPath) return json(res, 501, { error: "Reveal in Finder is available in the Mac app." });
        const input = await body(req);
        const locations: Record<string, string> = {
          config: resolveConfigPath(),
          state: stateDir(),
          events: eventLogPath(),
        };
        const kind = String(input.location ?? "");
        const target = locations[kind];
        if (!target) return json(res, 400, { error: "Unknown settings location." });
        const revealTarget = nearestExistingPath(target);
        hooks.revealPath(revealTarget);
        return json(res, 200, { ok: true, location: kind, path: target });
      }
      if (url.pathname === "/api/config/backups" && req.method === "GET") {
        return json(res, 200, { backups: listConfigBackups().map(({ id, mtimeMs, size }) => ({ id, mtimeMs, size })) });
      }
      if (url.pathname === "/api/config/restore" && req.method === "POST") {
        const input = await body(req);
        const path = restoreConfigBackup(String(input.id ?? input.backupId ?? ""));
        return json(res, 200, { ok: true, path, recovery: { active: isRecoveryMode(), reason: readRecoveryReason() ?? null } });
      }
      if (url.pathname === "/api/recovery/clear" && req.method === "POST") {
        clearRecoveryMode();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/uninstall/plan" && req.method === "POST") {
        const input = await body(req);
        return json(res, 200, describeUninstall({
          includeLocalData: Boolean(input.includeLocalData),
          appBundlePath: typeof input.appBundlePath === "string" ? input.appBundlePath : undefined,
        }));
      }
      if (url.pathname === "/api/uninstall/execute" && req.method === "POST") {
        const input = await body(req);
        if (!input.confirm) return json(res, 400, { error: "Set confirm: true to run uninstall cleanup." });
        const result = executeUninstallCleanup({ includeLocalData: Boolean(input.includeLocalData) });
        return json(res, 200, { ok: true, ...result, note: "Workspace folders are never deleted." });
      }
      if (url.pathname === "/api/protection/status" && req.method === "GET") {
        const context = url.searchParams.get("context") ?? undefined;
        if (context) {
          const mismatch = getProtectionMismatch(context);
          return json(res, 200, { context, mismatch: mismatch ?? null, launchBlocked: blocksProtectedLaunch(context) });
        }
        return json(res, 200, { mismatches: listProtectionMismatches() });
      }
      if (url.pathname === "/api/protection/clear" && req.method === "POST") {
        const input = await body(req);
        const context = String(input.context ?? "");
        if (!context) return json(res, 400, { error: "context is required." });
        clearProtectionMismatch(context);
        return json(res, 200, { ok: true, context });
      }
      if (url.pathname === "/api/diagnostics/report" && req.method === "POST") {
        const input = await body(req);
        const report = buildDiagnosticsReport({
          context: String(input.context ?? ""),
          workspace: input.workspace ? String(input.workspace) : undefined,
          image: input.image ? String(input.image) : undefined,
          detail: input.detail ? String(input.detail) : undefined,
          results: Array.isArray(input.results) ? input.results : [],
        });
        const action = String(input.action ?? "preview");
        if (action === "preview") return json(res, 200, { action: "preview", report });
        if (action === "save") {
          const dir = join(homedir(), "Downloads");
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          const file = join(existsSync(dir) ? dir : tmpdir(), `bumper-diagnostics-${stamp}.json`);
          writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
          return json(res, 200, { action: "save", path: file, report });
        }
        if (action === "send") {
          // No remote endpoint in free local ship — stub after explicit preview.
          return json(res, 200, {
            action: "send",
            sent: false,
            stub: true,
            message: "No report endpoint is configured. Save the report locally instead.",
            report,
          });
        }
        return json(res, 400, { error: "action must be preview, save, or send." });
      }
      if (url.pathname === "/api/pick-folder" && req.method === "POST") return json(res, 200, { dir: await pickFolder() });
      if (url.pathname === "/api/room/breakout" && req.method === "POST") {
        const backend = new AppleContainerBackend();
        const availability = await backend.check();
        if (!availability.usable) return json(res, 200, { available: false, detail: availability.detail, results: [] });
        const dir = mkdtempSync(join(tmpdir(), "bumper-room-probe-"));
        writeFileSync(join(dir, "client-secret.txt"), "SIMULATED CLIENT SECRET\n", { mode: 0o600 });
        try {
          const results = await runBreakout(backend, sealedRoomSpec(dir));
          return json(res, 200, { available: true, detail: availability.detail, results });
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      if (url.pathname === "/api/room/preflight" && req.method === "POST") {
        return json(res, 200, await roomAgentPreflight(reload(), await body(req)));
      }
      if (url.pathname === "/api/room/ai-proof" && req.method === "POST") {
        return json(res, 200, await roomAiProof(reload(), await body(req)));
      }
      if (url.pathname === "/api/room/ai-proof/plan" && req.method === "GET") {
        return json(res, 200, roomAiProofPlan(reload(), url.searchParams.get("context") || ""));
      }
      if (url.pathname === "/api/room/setup" && req.method === "GET") {
        return json(res, 200, {
          image: RECOMMENDED_ROOM_IMAGE,
          purpose: "Build a local Sandbox image with the AI CLIs Bumper can launch.",
          installs: ["claude", "codex", "cursor-agent", "agy", "grok"],
          // Default alpine/base images intentionally ship with zero AI CLIs — not a failure.
          baseImageNote: "Default plain Linux base images (for example alpine) intentionally include no AI CLIs. That is an unconfigured safe Sandbox, not five broken tools.",
          autoBuild: false,
          autoDownload: false,
        });
      }
      if (url.pathname === "/api/room/setup/log" && req.method === "GET") {
        return json(res, 200, { active: buildProgress.active, lines: buildProgress.lines.slice(-400), result: buildProgress.result });
      }
      if (url.pathname === "/api/room/setup" && req.method === "POST") {
        const input = await body(req);
        const contextName = String(input.context ?? "");
        if (!reload().contexts[contextName]) throw new Error("Unknown project.");
        const backend = new AppleContainerBackend();
        const availability = await backend.check();
        if (!availability.usable) return json(res, 200, { ok: false, image: RECOMMENDED_ROOM_IMAGE, detail: availability.detail, failedTool: "Apple container", hint: availability.detail });
        buildProgress.active = true; buildProgress.lines = []; buildProgress.result = undefined;
        // Retries / stale local tags use --no-cache so pre-materialize_path_bin images are replaced.
        const existing = inspectRecommendedRoomRecipe();
        const noCache = Boolean(input.force || input.noCache || existing.stale);
        if (noCache) buildProgress.lines.push("bumper: building with --no-cache (stale or forced recommended image)");
        const result = await buildRecommendedRoomImage(
          (line) => { buildProgress.lines.push(line); if (buildProgress.lines.length > 2000) buildProgress.lines.shift(); },
          { noCache, verify: true },
        );
        buildProgress.active = false; buildProgress.result = result;
        if (result.ok) {
          setProjectRoomImage(contextName, result.image);
          logEvent({ context: contextName, surface: "session", decision: "allowed", target: "Recommended Sandbox image built", reason: result.image });
        } else {
          logEvent({ context: contextName, surface: "session", decision: "blocked", target: "Sandbox image build failed", reason: `${result.failedTool}: ${result.hint}` });
        }
        return json(res, 200, result);
      }
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        const input = await body(req);
        const context = String(input.context ?? "");
        if (context && blocksProtectedLaunch(context) && !input.force) {
          const mismatch = getProtectionMismatch(context);
          return json(res, 409, {
            error: "Protection mismatch — new Protected launches are blocked until diagnostics match Expected.",
            mismatch,
            launchBlocked: true,
          });
        }
        const session = await sessions.createRoomAgent(input);
        return json(res, 201, { ...session, terminalWindow: openOrDescribeTerminal(hooks, sessions, session) });
      }
      if (url.pathname === "/api/room/sessions" && req.method === "POST") {
        const input = await body(req);
        const context = String(input.context ?? "");
        if (context && blocksProtectedLaunch(context) && !input.force) {
          return json(res, 409, {
            error: "Protection mismatch — new Protected launches are blocked until diagnostics match Expected.",
            mismatch: getProtectionMismatch(context),
            launchBlocked: true,
          });
        }
        const session = await sessions.createRoomShell(input);
        return json(res, 201, { ...session, terminalWindow: openOrDescribeTerminal(hooks, sessions, session) });
      }
      if (url.pathname === "/api/room/agent-sessions" && req.method === "POST") {
        const input = await body(req);
        const context = String(input.context ?? "");
        if (context && blocksProtectedLaunch(context) && !input.force) {
          return json(res, 409, {
            error: "Protection mismatch — new Protected launches are blocked until diagnostics match Expected.",
            mismatch: getProtectionMismatch(context),
            launchBlocked: true,
          });
        }
        const session = await sessions.createRoomAgent(input);
        return json(res, 201, { ...session, terminalWindow: openOrDescribeTerminal(hooks, sessions, session) });
      }
      if (url.pathname === "/api/sessions" && req.method === "GET") return json(res, 200, sessions.list());
      const stopMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/);
      if (stopMatch && req.method === "POST") return json(res, sessions.stop(stopMatch[1]) ? 200 : 409, { ok: sessions.get(stopMatch[1])?.status === "running" });
      if (url.pathname === "/api/terminal-window" && req.method === "POST") {
        const input = await body(req);
        const sessionId = String(input.sessionId ?? input.id ?? "");
        const session = sessions.get(sessionId);
        if (!session) return json(res, 404, { error: "Unknown session." });
        return json(res, 200, openOrDescribeTerminal(hooks, sessions, session));
      }
      if (url.pathname === "/api/use" && req.method === "POST") {
        const { context } = await body(req);
        if (!context || !reload().contexts[context]) return json(res, 400, { error: "Unknown context." });
        setActiveContext(context);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/global-policy" && req.method === "PUT") {
        saveGlobalPolicy(await body(req));
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/contexts" && req.method === "POST") {
        const input = await body(req); saveContext(input.name, input); setActiveContext(input.name);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/contexts" && req.method === "PUT") {
        const input = await body(req);
        const previousName = String(input.previous ?? input.name ?? "");
        const before = reload().contexts[previousName];
        try {
          saveContext(input.name, input, input.previous);
        } catch (error) {
          // A rejected Project — an unprovable repository binding, a bad name —
          // is the caller's mistake, and the reason has to reach their toast
          // rather than becoming an opaque 500.
          return json(res, 400, { error: (error as Error).message });
        }
        if (getActiveContext() === input.previous) setActiveContext(input.name);
        const after = reload().contexts[input.name];
        const describeBindings = (context: typeof before) => projectGitBindings(context)
          .map((row) => `${row.connectionId}/${row.installationId}/${row.repositoryId}=${row.capability}`)
          .sort()
          .join(" ");
        const gitChanged = previousName !== input.name
          || describeBindings(before) !== describeBindings(after)
          || before?.gitWriteUntil !== after?.gitWriteUntil;
        /*
         * Any token this Project already holds is now scoped to a binding set
         * that no longer exists, so it goes back — across every owner the
         * Project used to bind, not just the first one.
         */
        const revocation = { revoked: 0, pending: 0 };
        if (gitChanged) {
          const connectionIds = [...new Set(projectGitBindings(before).map((row) => row.connectionId))];
          for (const connectionId of connectionIds) {
            const result = await githubApp.forConnection(connectionId).revokeProject(previousName);
            revocation.revoked += result.revoked;
            revocation.pending += result.pending;
          }
        }
        return json(res, 200, { ok: true, ...revocation });
      }
      /** Bind a chosen folder as the Project's primary Access root (workspace). Never invents home. */
      if (url.pathname === "/api/access/workspace" && req.method === "POST") {
        const input = await body(req);
        const contextName = String(input.context ?? input.name ?? "").trim();
        const folder = String(input.workspace ?? input.dir ?? "").trim();
        if (!contextName) return json(res, 400, { error: "Project (context) is required." });
        if (!folder) return json(res, 400, { error: "Folder path is required. Bumper does not invent Access doors." });
        try {
          const result = setProjectAccessWorkspace(reload(), contextName, folder);
          writeRawConfig((raw) => {
            if (!raw.contexts?.[contextName]) throw new Error(`Unknown project "${contextName}".`);
            raw.contexts[contextName].workspace = result.workspace;
          });
          return json(res, 200, {
            ok: true,
            project: result.projectName,
            workspace: result.workspace,
            previous: result.previous ?? null,
            bindsHome: result.bindsHome,
          });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }
      if (url.pathname === "/api/contexts" && req.method === "DELETE") {
        const input = await body(req);
        const names = Object.keys(reload().contexts);
        if (!input.name || names.length <= 1) return json(res, 409, { error: "Bumper must keep at least one context." });
        writeRawConfig((raw) => { delete raw.contexts[input.name]; if (raw.defaultContext === input.name) raw.defaultContext = Object.keys(raw.contexts)[0]; });
        if (getActiveContext() === input.name) setActiveContext(Object.keys(reload().contexts)[0]);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/backends" && (req.method === "POST" || req.method === "PUT")) {
        const input = await body(req); saveBackend(input.name, input, req.method === "PUT" ? input.previous : undefined);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/backends" && req.method === "DELETE") {
        const input = await body(req);
        writeRawConfig((raw) => { delete raw.backends?.[input.name]; for (const context of Object.values(raw.contexts ?? {}) as any[]) { context.backends = (context.backends ?? []).filter((backend: string) => backend !== input.name); if (context.policies) delete context.policies[input.name]; } });
        return json(res, 200, { ok: true });
      }
      // --- Phase 2: Folders draft / apply ---
      if (url.pathname === "/api/folders/preview" && req.method === "POST") {
        const input = await body(req);
        const projectName = String(input.project ?? "").trim();
        const cfg = reload();
        if (!cfg.contexts[projectName]) return json(res, 400, { error: "Unknown project." });
        const draft = normalizeFolderDraft(input.draft as FolderDraft);
        const ctx = cfg.contexts[projectName];
        const presence = workspacePresence(ctx.workspace);
        return json(res, 200, {
          draft,
          matrix: folderMatrix(draft, presence.status === "ok" ? presence.path : undefined),
          diff: folderPolicyDiff(ctx, draft),
          workspace: presence,
          runningSessions: runningSessionsForProject(sessions.list(), projectName),
          capabilities: FOLDER_CAPABILITIES,
        });
      }
      if (url.pathname === "/api/folders/apply" && req.method === "POST") {
        const input = await body(req);
        const projectName = String(input.project ?? "").trim();
        let applied;
        try {
          applied = applyProjectFolders({
            config: reload(),
            projectName,
            draft: input.draft as FolderDraft,
            // Seatbelt sessions never take a lease, so the in-memory list is
            // still needed; the leases add the CLI Sessions this used to miss.
            runningSessions: mergeSessionRefs(sessions.list(), leaseSessionRefs()),
          });
        } catch (err) {
          if (isOperationError(err)) return json(res, statusForOperationError(err), { error: err.message });
          throw err;
        }
        writeRawConfig((raw) => {
          raw.contexts[projectName] = applyFolderPatch(raw.contexts[projectName], applied.patch);
        });
        return json(res, 200, { ok: true, project: projectName, draft: applied.draft });
      }

      // --- Phase 3: reusable setups ---
      if (url.pathname === "/api/permission-setups" && req.method === "POST") {
        const input = await body(req);
        const setupName = assertSetupName(String(input.name ?? ""));
        if (isBuiltinTemplateName(setupName)) {
          return json(res, 400, {
            error: `"${setupName}" is a built-in immutable template. Save a custom snapshot under a different name.`,
          });
        }
        const fromProject = String(input.fromProject ?? "");
        const cfg = reload();
        if (!cfg.contexts[fromProject]) return json(res, 400, { error: "Unknown project to snapshot." });
        const setup = snapshotPermissionSetup(cfg.contexts[fromProject], input.description ? String(input.description) : undefined);
        const parsed = PermissionSetupSchema.safeParse(setup);
        if (!parsed.success) return json(res, 400, { error: parsed.error.toString() });
        writeRawConfig((raw) => {
          raw.permissionSetups = raw.permissionSetups ?? {};
          raw.permissionSetups[setupName] = parsed.data;
        });
        return json(res, 200, { ok: true, name: setupName });
      }
      if (url.pathname === "/api/permission-setups/apply" && req.method === "POST") {
        const input = await body(req);
        const setupName = assertSetupName(String(input.name ?? ""));
        const projectName = String(input.project ?? "");
        const cfg = reload();
        const setup = resolvePermissionSetup(cfg, setupName);
        if (!setup) return json(res, 404, { error: `Unknown permission setup "${setupName}".` });
        if (!cfg.contexts[projectName]) return json(res, 400, { error: "Unknown project." });
        try {
          assertCanApplyFolders(sessions.list(), projectName);
        } catch (err) {
          return json(res, 409, { error: (err as Error).message });
        }
        writeRawConfig((raw) => {
          const current = raw.contexts[projectName];
          // Apply onto raw-shaped context via schema-normalized Context from load path.
          const applied = applyPermissionSetup(cfg.contexts[projectName], setup);
          raw.contexts[projectName] = {
            ...current,
            mode: applied.mode,
            inheritMode: applied.inheritMode,
            commands: applied.commands,
            native: applied.native,
            writePaths: applied.writePaths,
            readPaths: applied.readPaths,
            denyReadPaths: applied.denyReadPaths,
            denyWritePaths: applied.denyWritePaths,
            gitIgnored: applied.gitIgnored,
            repos: applied.repos,
            allowedHosts: applied.allowedHosts,
            room: {
              ...(current.room ?? {}),
              ...applied.room,
              enabled: true,
            },
            appliedPermissionSetup: setupName,
            // preserve project-local fields
            workspace: current.workspace,
            description: current.description,
            backends: current.backends,
            policies: current.policies,
            loginProfiles: current.loginProfiles ?? {},
          };
        });
        return json(res, 200, { ok: true, project: projectName, setup: setupName });
      }
      if (url.pathname === "/api/permission-setups" && req.method === "DELETE") {
        const input = await body(req);
        const setupName = assertSetupName(String(input.name ?? ""));
        if (isBuiltinTemplateName(setupName)) {
          return json(res, 400, { error: `Built-in template "${setupName}" cannot be deleted.` });
        }
        writeRawConfig((raw) => { if (raw.permissionSetups) delete raw.permissionSetups[setupName]; });
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/api/auth-profiles/verify" && req.method === "POST") {
        const input = await body(req);
        const agentId = String(input.agentId ?? "");
        const agent = getAgent(agentId);
        if (!agent) return json(res, 400, { error: "Unknown AI tool." });
        const profileId = normalizeAuthProfileId(String(input.profileId ?? input.id ?? DEFAULT_AUTH_PROFILE));
        return json(res, 200, { ok: true, agentId: agent.id, profileId, ...verifyProfileAuth(agent.id, profileId) });
      }
      if (url.pathname === "/api/auth-profiles/reset" && req.method === "POST") {
        const input = await body(req);
        const agentId = String(input.agentId ?? "");
        const agent = getAgent(agentId);
        if (!agent) return json(res, 400, { error: "Unknown AI tool." });
        const profileId = normalizeAuthProfileId(String(input.profileId ?? input.id ?? DEFAULT_AUTH_PROFILE));
        const result = resetRoomAuth(agent.id, profileId);
        return json(res, 200, {
          ok: true,
          agentId: agent.id,
          profileId,
          cleared: result.cleared.length,
          status: "needs-signin",
          persisted: false,
        });
      }
      if (url.pathname === "/api/auth-profiles" && req.method === "DELETE") {
        const input = await body(req);
        const id = normalizeAuthProfileId(String(input.id ?? input.name ?? ""));
        if (id === DEFAULT_AUTH_PROFILE) return json(res, 400, { error: "The default profile cannot be removed." });
        writeRawConfig((raw) => {
          raw.authProfiles = (Array.isArray(raw.authProfiles) ? raw.authProfiles : []).filter(
            (item: string) => item !== id,
          );
          if (!raw.authProfiles.includes(DEFAULT_AUTH_PROFILE)) raw.authProfiles.unshift(DEFAULT_AUTH_PROFILE);
          for (const project of Object.values(raw.contexts ?? {}) as Array<{ loginProfiles?: Record<string, string> }>) {
            if (!project?.loginProfiles) continue;
            for (const [agentId, profileId] of Object.entries(project.loginProfiles)) {
              if (profileId === id) project.loginProfiles[agentId] = DEFAULT_AUTH_PROFILE;
            }
          }
        });
        return json(res, 200, { ok: true, id });
      }
      /**
       * Remove one Library AI login row = one tool × identity.
       *
       * The row grammar is per tool, so the action must be too: clear that
       * tool's stored login, unbind the Projects that pointed at it, and only
       * drop the identity from the shared catalog once no tool still holds it.
       * (`DELETE /api/auth-profiles` remains identity-wide, for the catalog.)
       */
      if (url.pathname === "/api/ai-logins" && req.method === "DELETE") {
        const input = await body(req);
        const agent = getAgent(String(input.agentId ?? ""));
        if (!agent) return json(res, 400, { error: "Unknown AI tool." });
        const identityId = normalizeAuthProfileId(String(input.identityId ?? input.profileId ?? DEFAULT_AUTH_PROFILE));
        const cleared = resetRoomAuth(agent.id, identityId).cleared.length;
        const unbound: string[] = [];
        writeRawConfig((raw) => {
          for (const [name, project] of Object.entries(
            (raw.contexts ?? {}) as Record<string, { loginProfiles?: Record<string, string> }>,
          )) {
            const bindings = project?.loginProfiles;
            if (!bindings) continue;
            if (normalizeAuthProfileId(String(bindings[agent.id] ?? "")) !== identityId) continue;
            // Real unbind — do not silently repoint the Project at another login.
            delete bindings[agent.id];
            unbound.push(name);
          }
          if (identityId === DEFAULT_AUTH_PROFILE) return;
          const stillOnDisk = agentsWithIdentityOnDisk(
            identityId,
            detectAgents().map((item) => item.id),
          );
          const stillBound = Object.values(
            (raw.contexts ?? {}) as Record<string, { loginProfiles?: Record<string, string> }>,
          ).some((project) =>
            Object.values(project?.loginProfiles ?? {}).some(
              (value) => normalizeAuthProfileId(String(value)) === identityId,
            ),
          );
          if (stillOnDisk.length === 0 && !stillBound) {
            raw.authProfiles = (Array.isArray(raw.authProfiles) ? raw.authProfiles : []).filter(
              (item: string) => item !== identityId,
            );
            if (!raw.authProfiles.includes(DEFAULT_AUTH_PROFILE)) raw.authProfiles.unshift(DEFAULT_AUTH_PROFILE);
          }
        });
        return json(res, 200, { ok: true, agentId: agent.id, identityId, cleared, unbound });
      }
      if (url.pathname === "/api/git-connections" && req.method === "POST") {
        const input = await body(req);
        let savedId = "";
        writeRawConfig((raw) => {
          raw.gitConnections = raw.gitConnections ?? {};
          const { id, connection } = upsertGitConnection(
            { gitConnections: raw.gitConnections } as Config,
            input,
          );
          raw.gitConnections[id] = connection;
          savedId = id;
        });
        return json(res, 200, { ok: true, id: savedId });
      }
      if (url.pathname === "/api/git-connections" && req.method === "DELETE") {
        const input = await body(req);
        const id = normalizeGitConnectionId(String(input.id ?? input.name ?? ""));
        const { config } = loadConfig();
        const usedBy = projectsUsingGitConnection(config, id);
        if (usedBy.length) {
          return json(res, 400, {
            error: `Connection is used by Project(s): ${usedBy.join(", ")}. Unbind them first.`,
          });
        }
        writeRawConfig((raw) => {
          if (raw.gitConnections) delete raw.gitConnections[id];
        });
        return json(res, 200, { ok: true, id });
      }
      if (url.pathname === "/api/git/workspace" && req.method === "GET") {
        const contextName = String(url.searchParams.get("context") ?? "").trim();
        const cfg = reload();
        if (!contextName || !cfg.contexts[contextName]) {
          return json(res, 404, { error: "Unknown Project." });
        }
        const ctx = cfg.contexts[contextName];
        const workspace = ctx.workspace ?? "";
        const gitConn = getGitConnection(cfg, ctx.gitConnectionId);
        const status = await readGitWorkspaceStatus(workspace, {
          sshKeyPath: gitConn?.sshKeyPath,
          userName: gitConn?.userName,
          userEmail: gitConn?.userEmail,
        });
        return json(res, 200, status);
      }
      if (url.pathname === "/api/mcp-integrations" && req.method === "POST") {
        const input = await body(req);
        let savedId = "";
        try {
          writeRawConfig((raw) => {
            raw.mcpIntegrations = raw.mcpIntegrations ?? {};
            const { id, integration } = upsertMcpIntegration(
              { mcpIntegrations: raw.mcpIntegrations } as Config,
              input,
            );
            raw.mcpIntegrations[id] = integration;
            savedId = id;
          });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        return json(res, 200, { ok: true, id: savedId });
      }
      if (url.pathname === "/api/mcp-integrations" && req.method === "DELETE") {
        const input = await body(req);
        const id = normalizeMcpId(String(input.id ?? ""), "integration id");
        const { config } = loadConfig();
        const usedBy = projectsUsingMcpIntegration(config, id);
        if (usedBy.length) {
          return json(res, 400, {
            error: `Integration is used by Project(s): ${usedBy.join(", ")}. Unbind them first.`,
          });
        }
        const connections = Object.entries(config.mcpConnections ?? {})
          .filter(([, c]) => c.integrationId === id)
          .map(([cid]) => cid);
        if (connections.length) {
          return json(res, 400, {
            error: `Delete Connections first: ${connections.join(", ")}.`,
          });
        }
        writeRawConfig((raw) => {
          if (raw.mcpIntegrations) delete raw.mcpIntegrations[id];
        });
        return json(res, 200, { ok: true, id });
      }
      if (url.pathname === "/api/mcp-connections" && req.method === "POST") {
        const input = await body(req);
        let savedId = "";
        try {
          writeRawConfig((raw) => {
            raw.mcpConnections = raw.mcpConnections ?? {};
            const { id, connection } = upsertMcpConnection(
              {
                mcpIntegrations: raw.mcpIntegrations ?? {},
                mcpConnections: raw.mcpConnections,
              } as Config,
              input,
            );
            raw.mcpConnections[id] = connection;
            savedId = id;
          });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        return json(res, 200, { ok: true, id: savedId });
      }
      if (url.pathname === "/api/mcp-connections" && req.method === "DELETE") {
        const input = await body(req);
        const id = normalizeMcpId(String(input.id ?? ""), "connection id");
        const { config } = loadConfig();
        const usedBy = projectsUsingMcpConnection(config, id);
        if (usedBy.length) {
          return json(res, 400, {
            error: `Connection is used by Project(s): ${usedBy.join(", ")}. Unbind them first.`,
          });
        }
        writeRawConfig((raw) => {
          if (raw.mcpConnections) delete raw.mcpConnections[id];
        });
        deleteAllMcpConnectionSecrets(id);
        return json(res, 200, { ok: true, id });
      }
      if (url.pathname === "/api/mcp-connections/secret" && req.method === "POST") {
        const input = await body(req);
        const id = normalizeMcpId(String(input.id ?? ""), "connection id");
        const fieldKey = normalizeMcpId(String(input.fieldKey ?? input.key ?? ""), "field");
        const { config } = loadConfig();
        if (!config.mcpConnections?.[id]) return json(res, 404, { error: "Unknown MCP Connection." });
        try {
          setMcpConnectionSecret(id, fieldKey, String(input.value ?? input.secret ?? ""));
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
        return json(res, 200, { ok: true, id, fieldKey, hasSecret: true });
      }
      if (url.pathname === "/api/mcp-connections/secret" && req.method === "DELETE") {
        const input = await body(req);
        const id = normalizeMcpId(String(input.id ?? ""), "connection id");
        const fieldKey = normalizeMcpId(String(input.fieldKey ?? input.key ?? ""), "field");
        return json(res, 200, { ok: deleteMcpConnectionSecret(id, fieldKey), id, fieldKey });
      }
      /** Probe usual Cursor / Claude MCP config paths (no secrets returned). */
      if (url.pathname === "/api/mcp-import/probes" && req.method === "GET") {
        const workspace = String(url.searchParams.get("workspace") ?? "").trim() || undefined;
        return json(res, 200, { sources: listMcpImportProbes(workspace) });
      }
      /** List import candidates from a source or pasted JSON — env values never included. */
      if (url.pathname === "/api/mcp-import/preview" && req.method === "POST") {
        const input = await body(req);
        const source = String(input.source ?? "paste") as McpImportSourceId;
        const workspace = String(input.workspace ?? "").trim() || undefined;
        const { config } = loadConfig();
        try {
          let path = "";
          let servers;
          if (source === "paste") {
            servers = parseMcpServersDocument(String(input.json ?? input.text ?? ""));
            path = "paste";
          } else {
            const loaded = loadServersFromSource(
              source,
              String(input.path ?? "").trim() || undefined,
              workspace,
            );
            path = loaded.path;
            servers = loaded.servers;
          }
          const label = source === "paste" ? "Paste"
            : source === "cursor" ? "Cursor"
              : source === "claude-desktop" ? "Claude Desktop"
                : "Claude Code";
          const candidates = buildImportCandidates(config, servers, label, path === "paste" ? undefined : path);
          return json(res, 200, {
            source,
            path: path === "paste" ? "" : path,
            candidates: candidates.map((c) => ({
              serverKey: c.serverKey,
              command: c.command,
              args: c.args,
              envKeys: c.envKeys,
              valueKeys: c.valueKeys,
              secretKeys: c.secretKeys,
              suggestedName: c.suggestedName,
              suggestedDescription: c.suggestedDescription,
              integrationId: c.integrationId,
              integrationExists: c.integrationExists,
              skipReason: c.skipReason || "",
              // Never return secret values.
            })),
          });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }
      /** Apply selected servers from a source or paste into Library. */
      if (url.pathname === "/api/mcp-import/apply" && req.method === "POST") {
        const input = await body(req);
        const source = String(input.source ?? "paste") as McpImportSourceId;
        const workspace = String(input.workspace ?? "").trim() || undefined;
        const serverKeys = Array.isArray(input.serverKeys)
          ? input.serverKeys.map((k: unknown) => String(k))
          : [];
        const nameByKey = input.names && typeof input.names === "object" ? input.names as Record<string, string> : {};
        const descriptionByKey = input.descriptions && typeof input.descriptions === "object"
          ? input.descriptions as Record<string, string>
          : {};
        try {
          let path = "";
          let servers;
          let label = "Paste";
          if (source === "paste") {
            servers = parseMcpServersDocument(String(input.json ?? input.text ?? ""));
            path = "";
            label = "Paste";
          } else {
            const loaded = loadServersFromSource(
              source,
              String(input.path ?? "").trim() || undefined,
              workspace,
            );
            path = loaded.path;
            servers = loaded.servers;
            label = source === "cursor" ? "Cursor"
              : source === "claude-desktop" ? "Claude Desktop"
                : "Claude Code";
          }
          let results: ReturnType<typeof applyMcpServerImports>["results"] = [];
          let secrets: ReturnType<typeof applyMcpServerImports>["secretsToWrite"] = [];
          writeRawConfig((raw) => {
            const cfg = {
              mcpIntegrations: raw.mcpIntegrations ?? {},
              mcpConnections: raw.mcpConnections ?? {},
            } as Config;
            const applied = applyMcpServerImports(cfg, servers, {
              sourceLabel: label,
              sourcePath: path || undefined,
              serverKeys: serverKeys.length ? serverKeys : undefined,
              nameByKey,
              descriptionByKey,
            });
            raw.mcpIntegrations = applied.config.mcpIntegrations;
            raw.mcpConnections = applied.config.mcpConnections;
            results = applied.results;
            secrets = applied.secretsToWrite;
          });
          writeImportedMcpSecrets(secrets);
          return json(res, 200, {
            ok: true,
            path,
            imported: results.filter((r) => r.createdConnection).length,
            results: results.map((r) => ({
              serverKey: r.serverKey,
              integrationId: r.integrationId,
              connectionId: r.connectionId,
              connectionName: r.connectionName,
              createdIntegration: r.createdIntegration,
              createdConnection: r.createdConnection,
              skipped: r.skipped || "",
            })),
          });
        } catch (err) {
          return json(res, 400, { error: (err as Error).message });
        }
      }
      /*
       * "Show me what the AI will actually see."
       *
       * Bindings and secret flags only say a Connection is configured. This
       * starts the real MCP servers, lists their real tools, and runs each one
       * through the same gateway the Sandbox does — so the answer on screen is the
       * answer the agent gets, including which tools this Project's mode blocks.
       */
      if (url.pathname === "/api/project/mcp-preview" && req.method === "POST") {
        const input = await body(req);
        const projectName = String(input.project ?? "");
        const cfg = reload();
        if (!cfg.contexts[projectName]) return json(res, 400, { error: "Unknown project." });
        const context = effectiveContext(cfg, projectName);
        let gateway: McpGateway | undefined;
        try {
          gateway = await McpGateway.open(cfg, projectName, context, { source: "app" });
          const tools = gateway.entries
            .map(({ decision }) => ({
              name: decision.exposedName,
              connection: decision.backend,
              tool: decision.toolName,
              access: decision.access,
              allowed: decision.allowed,
              reason: decision.reason,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
          return json(res, 200, {
            ok: true,
            project: projectName,
            mode: context.mode,
            connected: gateway.connected,
            failed: gateway.failed,
            tools,
            allowedCount: tools.filter((tool) => tool.allowed).length,
          });
        } catch (err) {
          return json(res, 500, { error: (err as Error).message });
        } finally {
          await gateway?.close();
        }
      }
      if (url.pathname === "/api/allow" && req.method === "POST") {
        const input = await body(req); const spec = inferSpecFromEvent(input.surface, input.target);
        if (!spec) {
          const surface = String(input.surface ?? "");
          // Network (including git-prefixed targets) cannot become a local rule.
          // Git scope changes only through Project → Git and is provider-enforced.
          const error = surface === "network"
            ? "This event cannot become a local Allow rule. For Git, choose the repository and token scope in Project → Git; GitHub enforces the upper bound. For egress, change Project → Network for a new session."
            : "This event cannot be converted to a rule.";
          return json(res, 400, { error });
        }
        const result = applyRule("allow", spec, input.context); return json(res, 200, { ok: true, message: result.message });
      }
      if (url.pathname === "/api/protection-test" && req.method === "POST") {
        const input = await body(req); return json(res, 200, protectionTest(reload(), input.context, input.workspace));
      }
      if (url.pathname === "/api/path-test" && req.method === "POST") {
        const input = await body(req); return json(res, 200, pathAccessTest(reload(), input.context, input.workspace, input.path));
      }
      return send(res, 404, "text/plain; charset=utf-8", "Not found");
    } catch (error) {
      return json(res, 500, { error: (error as Error).message });
    }
  });
  sessions = new SessionManager(server, reload, binPath);
  markAppSessionStart();
  try { pruneEvents(readPrefs().eventRetention); } catch { /* ignore */ }

  const requestedPort = config.webPort;
  const actualPort = await new Promise<number>((resolvePromise, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && requestedPort !== 0) {
        server.off("error", onError);
        server.listen(0, "127.0.0.1", () => resolvePromise((server.address() as import("node:net").AddressInfo).port));
      } else reject(error);
    };
    server.once("error", onError);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.off("error", onError);
      resolvePromise((server.address() as import("node:net").AddressInfo).port);
    });
  });
  const url = `http://127.0.0.1:${actualPort}`;
  console.error(`Bumper app → ${url}`);
  return {
    server, sessions, url, hooks,
    close: () => new Promise<void>((resolvePromise) => {
      if (gitSessionSweepTimer) clearInterval(gitSessionSweepTimer);
      if (developmentSessionSweepTimer) clearInterval(developmentSessionSweepTimer);
      sessions.stopAll();
      server.close(() => resolvePromise());
    }),
  };
}
