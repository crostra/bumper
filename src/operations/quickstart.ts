/** One-command first value: choose/create a Project and apply a safe vendor egress. */
import type { AgentId } from "../agents.js";
import type { Config } from "../types.js";
import {
  applyCreatedProject,
  defaultProjectNameFromCwd,
  matchProjectsByCwd,
  normalizeHostPath,
} from "../project.js";
import { setProjectNetwork } from "./network.js";
import { OperationError } from "./error.js";

export const QUICKSTART_TEMPLATE_BY_AGENT: Record<AgentId, string> = {
  claude: "anthropic",
  codex: "openai",
  cursor: "cursor",
  antigravity: "google",
  grok: "xai",
};

export interface PrepareQuickstartResult {
  projectName: string;
  created: boolean;
  workspace: string;
  networkChanged: boolean;
  networkTemplate?: string;
}

function availableName(config: Config, wanted: string): string {
  if (!config.contexts[wanted]) return wanted;
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${wanted} ${i}`;
    if (!config.contexts[candidate]) return candidate;
  }
  throw new OperationError("conflict", `Could not allocate a Project name based on "${wanted}".`, [
    "bumper project create <name>",
  ]);
}

/**
 * Explicit `quickstart` authorizes creation for cwd. Existing Projects are
 * never silently widened: their network setting remains exactly as chosen.
 */
export function prepareQuickstartProject(input: {
  config: Config;
  cwd: string;
  agentId: AgentId;
  projectFlag?: string;
}): PrepareQuickstartResult {
  const workspace = normalizeHostPath(input.cwd);
  if (!workspace) {
    throw new OperationError("invalid", "The current folder could not be resolved.", ["cd <project-folder>"]);
  }

  let projectName: string;
  let created = false;
  if (input.projectFlag?.trim()) {
    projectName = input.projectFlag.trim();
    if (!input.config.contexts[projectName]) {
      throw new OperationError("not-found", `Unknown project "${projectName}".`, ["bumper project list"]);
    }
  } else {
    const matches = matchProjectsByCwd(input.config, workspace);
    if (matches.length > 1) {
      throw new OperationError(
        "conflict",
        `Several Projects cover this folder (${matches.join(", ")}). Bumper will not guess.`,
        ["bumper quickstart -p <project>"],
      );
    }
    if (matches.length === 1) {
      projectName = matches[0]!;
    } else {
      projectName = availableName(input.config, defaultProjectNameFromCwd(workspace));
      applyCreatedProject(input.config, { name: projectName, workspace });
      created = true;
    }
  }

  let networkChanged = false;
  let networkTemplate: string | undefined;
  if (created) {
    networkTemplate = QUICKSTART_TEMPLATE_BY_AGENT[input.agentId];
    setProjectNetwork({
      config: input.config,
      projectName,
      mode: "allowlist",
      templates: [networkTemplate],
      hosts: [],
    });
    networkChanged = true;
  }

  const selectedWorkspace = normalizeHostPath(input.config.contexts[projectName]?.workspace || workspace) || workspace;
  return { projectName, created, workspace: selectedWorkspace, networkChanged, networkTemplate };
}
