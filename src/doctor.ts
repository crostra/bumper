/**
 * Phase 5 (W1-4): `bumper doctor` — one prerequisite diagnosis for the
 * CLI-only journey.
 *
 * Everything here is a *reuse* of an existing judgement:
 *   container   → AppleContainerBackend.check()
 *   image       → inspectRecommendedRoomRecipe() + verifyRecommendedRoomAuthOverlay()
 *                 (the same pair `bumper room-image verify` runs)
 *   project     → matchProjectsByCwd() / projectAccessRoots()
 *   fix hints   → nextCommandsForAction() (same strings the launch gate prints)
 *
 * No new readiness logic lives here. The only thing doctor adds is collecting
 * those answers into one screen and naming the next command.
 *
 * Honesty rule (docs/threat-model.md): a check that could not run reports
 * "skipped" with the reason. It never reports ok. False green is the one
 * failure mode this command exists to avoid.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { Config, Context } from "./types.js";
import { loadConfig } from "./config.js";
import { isRecoveryMode, readRecoveryReason } from "./config-store.js";
import { resolveConfigPath } from "./paths.js";
import { matchProjectsByCwd, projectAccessRoots } from "./project.js";
import { AppleContainerBackend } from "./room/apple-container.js";
import {
  describeImageSource,
  inspectRecommendedRoomRecipe,
  RECOMMENDED_ROOM_IMAGE,
  RECOMMENDED_ROOM_RECIPE,
  SAFE_BASE_ROOM_IMAGE,
  verifyRecommendedRoomAuthOverlay,
  type RecommendedRoomRecipeStatus,
} from "./room/setup.js";
import { nextCommandsForAction } from "./cli-room.js";
import { ensureContainerSystem } from "./operations/container-system.js";

/** Node floor. Below this, `npm i -g @crostra/bumper` is not supported. */
export const MINIMUM_NODE_MAJOR = 20;
/** Apple container 1.1 is supported by its maintainers on macOS 26+. */
export const MINIMUM_MACOS_MAJOR = 26;
/** Apple container floor (docs/packaging.md prerequisites). */
export const MINIMUM_CONTAINER_VERSION = "1.1.0";

export type DoctorStatus = "ok" | "blocked" | "warn" | "skipped";

export type DoctorCheckId =
  | "platform"
  | "node"
  | "container"
  | "config"
  | "project"
  | "access"
  | "image"
  | "image-overlay";

export interface DoctorCheck {
  id: DoctorCheckId;
  label: string;
  status: DoctorStatus;
  detail: string;
  /** Next commands to type. Empty when there is nothing to fix. */
  fix: string[];
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** True only when no check is blocked. Skipped checks never make this true. */
  ready: boolean;
  blocked: DoctorCheck[];
  configPath: string;
  projectName?: string;
  projectSource?: string;
}

/**
 * Everything doctor needs, already measured. Kept separate from the report so
 * tests can state a host situation without a Mac, a container CLI, or a config.
 */
export interface DoctorFacts {
  platform: string;
  /**
   * Hardware architecture, not `process.arch`. An x64 Node under Rosetta on an
   * M-series Mac reports x64, and telling that user to "get an Apple Silicon
   * Mac" is both wrong and unfixable — they already have one.
   */
  arch: string;
  /** Host product version from `sw_vers`, e.g. 26.4.1. */
  osVersion: string;
  /** True when this Node is an x64 build translated by Rosetta. */
  nodeTranslated?: boolean;
  nodeVersion: string;
  cwd: string;
  configPath: string;
  /** Missing / unreadable config is a fact, not an exception. */
  config?: Config;
  configError?: string;
  recoveryReason?: string;
  container: { usable: boolean; detail: string };
  /**
   * Set when the `container` CLI is installed but its background system service
   * is not running. That is a different failure from "image not built", and
   * needs a different command, so it must not be reported as a missing image.
   */
  containerSystemDetail?: string;
  /** True when doctor started the services itself (reported, never silent). */
  containerSystemAutoStarted?: boolean;
  projectFlag?: string;
  /**
   * Local recommended-image recipe status. Undefined means "not probed"
   * (container unusable, or the Project does not use the recommended image).
   */
  recipe?: RecommendedRoomRecipeStatus;
  /** Auth-overlay probe result. Undefined means "not probed". */
  overlay?: { ok: boolean; detail: string };
  /** Why the image probes were not run, when they were not. */
  imageProbeSkipReason?: string;
}

function parseVersion(text: string): number[] | undefined {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Which Project does this invocation concern?
 * flag → unique cwd Access match → defaultContext. Never invents one.
 */
export function doctorProject(
  config: Config | undefined,
  cwd: string,
  flag?: string,
): { name: string; source: string } | { error: string } | undefined {
  if (!config) return undefined;
  const names = Object.keys(config.contexts);
  if (flag?.trim()) {
    const name = flag.trim();
    if (!config.contexts[name]) {
      return { error: `Unknown project "${name}". Available: ${names.join(", ") || "(none)"}.` };
    }
    return { name, source: "flag" };
  }
  if (names.length === 0) return undefined;
  const matches = matchProjectsByCwd(config, cwd);
  if (matches.length === 1) return { name: matches[0]!, source: "cwd" };
  if (matches.length > 1) {
    return { error: `Multiple Projects cover this folder (${matches.join(", ")}). Pass -p <project>.` };
  }
  const fallback = config.defaultContext?.trim();
  if (fallback && config.contexts[fallback]) return { name: fallback, source: "default" };
  return { error: "No Project covers this folder and no default is set. Pass -p <project>." };
}

function platformCheck(facts: DoctorFacts): DoctorCheck {
  if (facts.platform !== "darwin") {
    return {
      id: "platform",
      label: "Host",
      status: "blocked",
      detail: `${facts.platform} is not supported. The Sandbox is an Apple container microVM, which is macOS only.`,
      fix: [`Run Bumper on macOS ${MINIMUM_MACOS_MAJOR}+ (Apple Silicon).`],
    };
  }
  if (facts.arch !== "arm64") {
    return {
      id: "platform",
      label: "Host",
      status: "blocked",
      detail: `macOS on ${facts.arch}. Apple container requires Apple Silicon.`,
      fix: ["Run Bumper on an Apple Silicon Mac."],
    };
  }
  const macOS = parseVersion(facts.osVersion);
  if (!macOS) {
    return {
      id: "platform",
      label: "Host",
      status: "warn",
      detail: `macOS on Apple Silicon, but the product version could not be measured (need ${MINIMUM_MACOS_MAJOR}+).`,
      fix: ["Check: sw_vers -productVersion"],
    };
  }
  if (macOS && macOS[0]! < MINIMUM_MACOS_MAJOR) {
    return {
      id: "platform",
      label: "Host",
      status: "blocked",
      detail: `macOS ${facts.osVersion} is below the supported floor. Apple container ${MINIMUM_CONTAINER_VERSION}+ requires macOS ${MINIMUM_MACOS_MAJOR}+.`,
      fix: [`Upgrade this Mac to macOS ${MINIMUM_MACOS_MAJOR} or newer.`],
    };
  }
  if (facts.nodeTranslated) {
    return {
      id: "platform",
      label: "Host",
      status: "warn",
      detail:
        `macOS ${facts.osVersion || "(unknown version)"} on Apple Silicon, but this Node is an x64 build running under Rosetta. ` +
        "The Sandbox is unaffected (it is a separate microVM); native npm modules will build x64.",
      fix: ["Optional: install an arm64 Node, then: npm i -g @crostra/bumper"],
    };
  }
  return {
    id: "platform",
    label: "Host",
    status: "ok",
    detail: `macOS ${facts.osVersion || "(version unknown)"} on Apple Silicon (need ${MINIMUM_MACOS_MAJOR}+).`,
    fix: [],
  };
}

function nodeCheck(facts: DoctorFacts): DoctorCheck {
  const parsed = parseVersion(facts.nodeVersion);
  const major = parsed?.[0] ?? 0;
  if (major >= MINIMUM_NODE_MAJOR) {
    return {
      id: "node",
      label: "Node",
      status: "ok",
      detail: `v${facts.nodeVersion.replace(/^v/, "")} (need ${MINIMUM_NODE_MAJOR}+).`,
      fix: [],
    };
  }
  return {
    id: "node",
    label: "Node",
    status: "blocked",
    detail: `v${facts.nodeVersion.replace(/^v/, "")} is below the supported floor (Node ${MINIMUM_NODE_MAJOR}+).`,
    fix: [
      `Install Node ${MINIMUM_NODE_MAJOR} or newer, then: npm i -g @crostra/bumper`,
    ],
  };
}

function containerCheck(facts: DoctorFacts): DoctorCheck {
  if (!facts.container.usable) {
    return {
      id: "container",
      label: "Apple container",
      status: "blocked",
      detail: facts.container.detail || "`container` CLI not found.",
      fix: nextCommandsForAction("install-container"),
    };
  }
  const found = parseVersion(facts.container.detail);
  const floor = parseVersion(MINIMUM_CONTAINER_VERSION)!;
  if (found && compareVersions(found, floor) < 0) {
    return {
      id: "container",
      label: "Apple container",
      status: "blocked",
      detail: `${facts.container.detail.trim()} — below the supported floor ${MINIMUM_CONTAINER_VERSION}.`,
      fix: nextCommandsForAction("install-container"),
    };
  }
  if (facts.containerSystemDetail) {
    return {
      id: "container",
      label: "Apple container",
      status: "blocked",
      detail: `${facts.container.detail.trim()} is installed, but its system service is not running. ${facts.containerSystemDetail}`,
      fix: ["container system start"],
    };
  }
  return {
    id: "container",
    label: "Apple container",
    status: "ok",
    detail: facts.containerSystemAutoStarted
      ? `${facts.container.detail.trim() || "available"} — services were stopped; Bumper started them (stop again: container system stop)`
      : facts.container.detail.trim() || "available",
    fix: [],
  };
}

function configCheck(facts: DoctorFacts): DoctorCheck {
  if (facts.recoveryReason) {
    return {
      id: "config",
      label: "Config",
      status: "blocked",
      detail: `Recovery mode: ${facts.recoveryReason}`,
      fix: [
        "Open the Bumper app → Settings → Recovery to restore a backup,",
        `or fix ${facts.configPath} by hand. Bumper never invents Projects to recover.`,
      ],
    };
  }
  if (facts.configError) {
    return {
      id: "config",
      label: "Config",
      status: "blocked",
      detail: facts.configError,
      fix: [
        "bumper init            # create a Project config for this folder",
        `Config path: ${facts.configPath}`,
      ],
    };
  }
  if (!facts.config) {
    return {
      id: "config",
      label: "Config",
      status: "blocked",
      detail: `No config at ${facts.configPath}.`,
      fix: ["bumper init            # create a Project config for this folder"],
    };
  }
  const count = Object.keys(facts.config.contexts).length;
  return {
    id: "config",
    label: "Config",
    status: "ok",
    detail: `${facts.configPath} — ${count} Project${count === 1 ? "" : "s"}.`,
    fix: [],
  };
}

function projectCheck(
  facts: DoctorFacts,
  resolved: ReturnType<typeof doctorProject>,
): DoctorCheck {
  if (!facts.config) {
    return {
      id: "project",
      label: "Project",
      status: "skipped",
      detail: "No config to read Projects from.",
      fix: [],
    };
  }
  if (Object.keys(facts.config.contexts).length === 0) {
    return {
      id: "project",
      label: "Project",
      status: "blocked",
      detail: "No Projects yet. A Project is what holds the folders, network, and tools a Sandbox gets.",
      fix: ["bumper init            # create one bound to this folder"],
    };
  }
  if (!resolved) {
    return {
      id: "project",
      label: "Project",
      status: "skipped",
      detail: "Could not determine which Project this folder belongs to.",
      fix: nextCommandsForAction("choose-project"),
    };
  }
  if ("error" in resolved) {
    return {
      id: "project",
      label: "Project",
      status: "warn",
      detail: resolved.error,
      fix: [
        "bumper doctor -p <project>",
        ...nextCommandsForAction("choose-workspace"),
      ],
    };
  }
  return {
    id: "project",
    label: "Project",
    status: "ok",
    detail: `${resolved.name} (resolved via ${resolved.source}).`,
    fix: [],
  };
}

function accessCheck(facts: DoctorFacts, project: Context | undefined, name?: string): DoctorCheck {
  if (!project) {
    return {
      id: "access",
      label: "Access",
      status: "skipped",
      detail: "No Project resolved, so there are no Access roots to check.",
      fix: [],
    };
  }
  const roots = projectAccessRoots(project);
  if (roots.length === 0) {
    return {
      id: "access",
      label: "Access",
      status: "blocked",
      detail:
        `Project "${name}" shares no folder. cwd resolve cannot match it and the Sandbox would see nothing. ` +
        "Bumper does not invent a home-wide door.",
      fix: [`bumper access set -p "${name}"   # binds this folder as the primary Access root`],
    };
  }
  const missing = roots.filter((root) => !existsSync(root.path));
  if (missing.length > 0) {
    return {
      id: "access",
      label: "Access",
      status: "warn",
      detail: `${roots.length} root${roots.length === 1 ? "" : "s"}; ${missing.length} no longer exist${missing.length === 1 ? "s" : ""} on disk: ${missing.map((r) => r.path).join(", ")}`,
      fix: [`bumper access set -p "${name}" <folder>`],
    };
  }
  return {
    id: "access",
    label: "Access",
    status: "ok",
    detail: roots.map((root) => `${root.role}: ${root.path}${root.access ? ` [${root.access}]` : ""}`).join("; "),
    fix: [],
  };
}

function imageCheck(facts: DoctorFacts, project: Context | undefined, name?: string): DoctorCheck {
  const image = project?.room?.image || RECOMMENDED_ROOM_IMAGE;
  const source = describeImageSource(image);
  const buildFix = nextCommandsForAction("build-image");

  if (facts.imageProbeSkipReason) {
    return {
      id: "image",
      label: "Sandbox image",
      status: "skipped",
      detail: `${image} — not checked: ${facts.imageProbeSkipReason}`,
      fix: [],
    };
  }

  if (source.kind === "base") {
    return {
      id: "image",
      label: "Sandbox image",
      status: "blocked",
      detail: `${image} is a plain Linux base image — it carries no AI CLIs by design, so \`bumper <cli>\` cannot start.`,
      fix: name ? [`bumper room-image build -p "${name}"`, ...buildFix.slice(1)] : buildFix,
    };
  }

  if (source.kind === "custom") {
    return {
      id: "image",
      label: "Sandbox image",
      status: "warn",
      detail: `${image} — ${source.label}. Bumper does not verify custom images; it must provide the AI CLI on PATH inside the Sandbox.`,
      fix: [],
    };
  }

  const recipe = facts.recipe;
  if (!recipe) {
    return {
      id: "image",
      label: "Sandbox image",
      status: "skipped",
      detail: `${image} — recipe not probed.`,
      fix: [],
    };
  }
  if (!recipe.present) {
    return {
      id: "image",
      label: "Sandbox image",
      status: "blocked",
      detail: `${image} is not built on this Mac. ${recipe.detail}`,
      fix: name ? [`bumper room-image build -p "${name}"`, ...buildFix.slice(1)] : buildFix,
    };
  }
  if (recipe.stale) {
    return {
      id: "image",
      label: "Sandbox image",
      status: "blocked",
      detail: recipe.detail,
      fix: ["bumper room-image build --force", `Needed recipe: ${RECOMMENDED_ROOM_RECIPE}`],
    };
  }
  return {
    id: "image",
    label: "Sandbox image",
    status: "ok",
    detail: recipe.detail,
    fix: [],
  };
}

function overlayCheck(facts: DoctorFacts, image: DoctorCheck): DoctorCheck {
  if (!facts.overlay) {
    return {
      id: "image-overlay",
      label: "CLIs survive auth mounts",
      status: "skipped",
      detail:
        image.status === "ok"
          ? "Probe not run."
          : `Not run — the image check is ${image.status}.`,
      fix: [],
    };
  }
  if (facts.overlay.ok) {
    return {
      id: "image-overlay",
      label: "CLIs survive auth mounts",
      status: "ok",
      detail: facts.overlay.detail,
      fix: [],
    };
  }
  return {
    id: "image-overlay",
    label: "CLIs survive auth mounts",
    status: "blocked",
    detail: facts.overlay.detail,
    fix: ["bumper room-image build --force"],
  };
}

/** Pure: facts in, report out. All ordering and severity live here. */
export function buildDoctorReport(facts: DoctorFacts): DoctorReport {
  const resolved = doctorProject(facts.config, facts.cwd, facts.projectFlag);
  const projectName = resolved && !("error" in resolved) ? resolved.name : undefined;
  const project = projectName ? facts.config?.contexts[projectName] : undefined;

  const image = imageCheck(facts, project, projectName);
  const checks: DoctorCheck[] = [
    platformCheck(facts),
    nodeCheck(facts),
    containerCheck(facts),
    configCheck(facts),
    projectCheck(facts, resolved),
    accessCheck(facts, project, projectName),
    image,
    overlayCheck(facts, image),
  ];

  const blocked = checks.filter((check) => check.status === "blocked");
  return {
    checks,
    ready: blocked.length === 0,
    blocked,
    configPath: facts.configPath,
    projectName,
    projectSource: resolved && !("error" in resolved) ? resolved.source : undefined,
  };
}

/**
 * Real hardware architecture. `process.arch` is the Node build's architecture,
 * which is x64 for a Rosetta-translated Node on an M-series Mac.
 */
export function hostArch(): { arch: string; nodeTranslated: boolean } {
  if (process.platform !== "darwin") return { arch: process.arch, nodeTranslated: false };
  if (process.arch === "arm64") return { arch: "arm64", nodeTranslated: false };
  const probe = spawnSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const isAppleSilicon = probe.status === 0 && probe.stdout.trim() === "1";
  return {
    arch: isAppleSilicon ? "arm64" : process.arch,
    nodeTranslated: isAppleSilicon,
  };
}

/** Read the product version without importing any GUI/runtime dependency. */
export function hostMacOSVersion(): string {
  if (process.platform !== "darwin") return "";
  const probe = spawnSync("/usr/bin/sw_vers", ["-productVersion"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return probe.status === 0 ? probe.stdout.trim() : "";
}

/** Measure the host. Everything expensive is skipped with a stated reason. */
export async function collectDoctorFacts(opts: {
  cwd: string;
  projectFlag?: string;
  /** Skip the container-backed auth-overlay probe (fast path). */
  skipImageProbe?: boolean;
  /** Report the stopped service instead of starting it (`--no-start`). */
  noStart?: boolean;
}): Promise<DoctorFacts> {
  const configPath = resolveConfigPath();
  let config: Config | undefined;
  let configError: string | undefined;
  try {
    config = loadConfig().config;
  } catch (err) {
    configError = (err as Error).message;
  }

  const backend = new AppleContainerBackend();
  const container = await backend.check();

  /*
   * Bring the services up before anything probes an image. Discovering
   * `container system start` from an XPC error is friction a first-time user
   * should never meet — the service is user-scoped and stopping it again is one
   * command. The report says when Bumper started it.
   */
  let systemDetail: string | undefined;
  let systemAutoStarted = false;
  if (container.usable) {
    const system = ensureContainerSystem({ allowStart: !opts.noStart });
    if (system.running) {
      systemAutoStarted = system.started;
    } else {
      systemDetail = system.detail;
    }
  }

  const { arch, nodeTranslated } = hostArch();
  const facts: DoctorFacts = {
    platform: process.platform,
    arch,
    osVersion: hostMacOSVersion(),
    nodeTranslated,
    nodeVersion: process.versions.node,
    cwd: opts.cwd,
    configPath,
    config,
    configError,
    recoveryReason: isRecoveryMode() ? (readRecoveryReason() || "Config recovery required.") : undefined,
    container: { usable: container.usable, detail: container.detail },
    containerSystemDetail: systemDetail,
    containerSystemAutoStarted: systemAutoStarted,
    projectFlag: opts.projectFlag,
  };

  const resolved = doctorProject(config, opts.cwd, opts.projectFlag);
  const projectName = resolved && !("error" in resolved) ? resolved.name : undefined;
  const image = (projectName ? config?.contexts[projectName]?.room?.image : undefined) || RECOMMENDED_ROOM_IMAGE;

  if (!container.usable) {
    facts.imageProbeSkipReason = "Apple container is not available on this Mac.";
    return facts;
  }
  if (systemDetail) {
    facts.imageProbeSkipReason = "the Apple container system service is not running.";
    return facts;
  }
  if (image !== RECOMMENDED_ROOM_IMAGE && image !== SAFE_BASE_ROOM_IMAGE) {
    // Custom image: imageCheck reports it honestly without probing.
    return facts;
  }
  if (image === SAFE_BASE_ROOM_IMAGE) return facts;

  // Same pair as `bumper room-image verify`. The service state was already
  // settled above, so a failure here really is about the image.
  const recipe = inspectRecommendedRoomRecipe(image);
  facts.recipe = recipe;
  if (!opts.skipImageProbe && recipe.present && !recipe.stale) {
    facts.overlay = verifyRecommendedRoomAuthOverlay(image);
  }
  return facts;
}

const MARK: Record<DoctorStatus, string> = {
  ok: "✓",
  blocked: "✗",
  warn: "!",
  skipped: "·",
};

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("bumper doctor — can this Mac run a protected Sandbox?");
  lines.push("");
  for (const check of report.checks) {
    // Probe output can be multi-line; keep the checklist one item per row.
    const [head, ...tail] = check.detail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    lines.push(`  ${MARK[check.status]} ${check.label}: ${head ?? ""}`);
    for (const extra of tail) lines.push(`      ${extra}`);
  }
  lines.push("");

  if (report.ready) {
    const skipped = report.checks.filter((check) => check.status === "skipped");
    const warned = report.checks.filter((check) => check.status === "warn");
    lines.push("Ready. Nothing is blocking a Sandbox launch.");
    if (warned.length) {
      lines.push(`Worth a look: ${warned.map((check) => check.label).join(", ")}.`);
    }
    if (skipped.length) {
      lines.push(`Not checked: ${skipped.map((check) => check.label).join(", ")} — these are unknown, not passing.`);
    }
    lines.push("");
    lines.push(
      report.projectName
        ? `Next: bumper status -p "${report.projectName}"  then  bumper -p "${report.projectName}" claude`
        : "Next: bumper status   then  bumper claude",
    );
    return lines.join("\n");
  }

  const first = report.blocked[0]!;
  lines.push(`Blocked: ${report.blocked.map((check) => check.label).join(", ")}`);
  lines.push("");
  lines.push(`Next — fix ${first.label}:`);
  for (const cmd of first.fix) lines.push(`  ${cmd}`);
  lines.push("");
  lines.push(
    report.blocked.length > 1
      ? `Then re-run: bumper doctor   (${report.blocked.length - 1} more blocked)`
      : "Then re-run: bumper doctor",
  );
  lines.push("");
  lines.push("A Sandbox was not started. Bumper reports what it could not check as unknown, never as passing.");
  return lines.join("\n");
}
