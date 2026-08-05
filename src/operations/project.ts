/**
 * Creating, listing, and removing Projects.
 *
 * `applyCreatedProject` in ../project.ts already defines what a new Project
 * *is*; this module owns what has to happen around it — refusing a duplicate
 * name, refusing to delete a Project with a live Session, and keeping
 * `defaultContext` pointing at something that exists.
 *
 * Deleting is deliberately narrow: it forgets Bumper's settings for a Project
 * and never touches the folder on disk that the Project pointed at.
 */
import type { Config } from "../types.js";
import { applyCreatedProject, normalizeHostPath, projectAccessRoots } from "../project.js";
import { runningSessionsForProject, type FolderSessionRef } from "../folders.js";
import { OperationError } from "./error.js";

export interface ProjectSummary {
  name: string;
  workspace: string;
  accessRootCount: number;
  egress: string;
  image: string;
  isDefault: boolean;
}

export function listProjects(config: Config): ProjectSummary[] {
  return Object.entries(config.contexts).map(([name, context]) => ({
    name,
    workspace: context.workspace?.trim() || "",
    accessRootCount: projectAccessRoots(context).length,
    egress: context.room?.egress ?? "blocked",
    image: context.room?.image ?? "",
    isDefault: config.defaultContext === name,
  }));
}

export interface CreateProjectResult {
  name: string;
  workspace: string;
  egress: string;
  image: string;
}

export function createProject(input: {
  config: Config;
  name: string;
  workspace: string;
}): CreateProjectResult {
  const name = input.name.trim();
  if (!name) {
    throw new OperationError("invalid", "A Project name is required.", [
      "bumper project create <name> [--path <folder>]",
    ]);
  }
  if (input.config.contexts[name]) {
    throw new OperationError("conflict", `Project "${name}" already exists.`, [
      `bumper folders list -p "${name}"   # see what it shares`,
      "bumper project create <other-name>",
    ]);
  }
  const workspace = normalizeHostPath(input.workspace);
  if (!workspace) {
    throw new OperationError("invalid", "A project folder is required.", [
      "bumper project create <name> --path ./my-repo",
    ]);
  }

  const created = applyCreatedProject(input.config, { name, workspace });
  return {
    name,
    workspace: created.workspace ?? workspace,
    egress: created.room?.egress ?? "blocked",
    image: created.room?.image ?? "",
  };
}

export interface DeleteProjectResult {
  name: string;
  /** The folder Bumper stops sharing — it stays exactly where it was. */
  workspace: string;
  nextDefault?: string;
}

export function deleteProject(input: {
  config: Config;
  name: string;
  runningSessions: FolderSessionRef[];
}): DeleteProjectResult {
  const name = input.name.trim();
  const project = input.config.contexts[name];
  if (!project) {
    const available = Object.keys(input.config.contexts).join(", ") || "(none)";
    throw new OperationError("not-found", `Unknown project "${name}". Available: ${available}.`, [
      "bumper project list",
    ]);
  }

  const running = runningSessionsForProject(input.runningSessions, name);
  if (running.length > 0) {
    const labels = running.map((session) => session.agentName || session.id).join(", ");
    throw new OperationError("conflict", `Project "${name}" has a running Session (${labels}).`, [
      "Stop the Session (exit the AI CLI), then run this again.",
    ]);
  }

  const workspace = project.workspace?.trim() ?? "";
  delete input.config.contexts[name];

  let nextDefault: string | undefined;
  if (input.config.defaultContext === name) {
    nextDefault = Object.keys(input.config.contexts)[0];
    input.config.defaultContext = nextDefault;
  }

  return { name, workspace, nextDefault };
}
