/**
 * Permission setups — a named snapshot of one Project's boundary, applied to
 * another. The reason someone with five client folders does not configure the
 * same cage five times.
 *
 * Applying one is a folder change, so it takes the same live-Session guard:
 * swapping the boundary under a running Sandbox would leave the Session on the
 * old policy while every surface reported the new one.
 */
import type { Config, Context, PermissionSetup } from "../types.js";
import {
  applyPermissionSetup,
  resolvePermissionSetup,
  snapshotPermissionSetup,
} from "../setups.js";
import {
  assertCanApplyFolders,
  isBuiltinTemplateName,
  listBuiltinPermissionSetups,
  type FolderSessionRef,
} from "../folders.js";
import { OperationError } from "./error.js";

const NAME = /^[\w][\w .-]{0,63}$/;

function assertSetupName(name: string): string {
  const trimmed = name.trim();
  if (!NAME.test(trimmed)) {
    throw new OperationError("invalid", `Invalid setup name "${name}".`, [
      "Use letters, digits, spaces, dot, dash or underscore (64 max).",
    ]);
  }
  return trimmed;
}

export interface SetupView {
  name: string;
  description: string;
  builtin: boolean;
}

export function listSetups(config: Config): SetupView[] {
  const builtins = listBuiltinPermissionSetups();
  const names = new Set([...Object.keys(builtins), ...Object.keys(config.permissionSetups ?? {})]);
  return [...names].sort().map((name) => {
    const setup = resolvePermissionSetup(config, name);
    return {
      name,
      description: setup?.description ?? "",
      builtin: isBuiltinTemplateName(name),
    };
  });
}

export function saveSetup(input: {
  config: Config;
  name: string;
  fromProject: string;
  description?: string;
}): { name: string; setup: PermissionSetup } {
  const name = assertSetupName(input.name);
  if (isBuiltinTemplateName(name)) {
    throw new OperationError("invalid", `"${name}" is a built-in template and cannot be overwritten.`, [
      "bumper setup save <another-name>",
    ]);
  }
  const project = input.config.contexts[input.fromProject];
  if (!project) {
    throw new OperationError("not-found", `Unknown project "${input.fromProject}".`, ["bumper project list"]);
  }
  const setup = snapshotPermissionSetup(project, input.description);
  input.config.permissionSetups = { ...(input.config.permissionSetups ?? {}), [name]: setup };
  return { name, setup };
}

export function deleteSetup(input: { config: Config; name: string }): { name: string } {
  const name = assertSetupName(input.name);
  if (isBuiltinTemplateName(name)) {
    throw new OperationError("invalid", `"${name}" is a built-in template and cannot be removed.`, [
      "bumper setup list",
    ]);
  }
  if (!input.config.permissionSetups?.[name]) {
    throw new OperationError("not-found", `Unknown setup "${name}".`, ["bumper setup list"]);
  }
  const next = { ...input.config.permissionSetups };
  delete next[name];
  input.config.permissionSetups = next;
  return { name };
}

export interface ApplySetupResult {
  name: string;
  projectName: string;
  /** The Context fields the setup writes; the adapter merges and persists. */
  applied: Context;
  appliesToNewSessions: true;
}

export function applySetupToProject(input: {
  config: Config;
  name: string;
  projectName: string;
  runningSessions: FolderSessionRef[];
}): ApplySetupResult {
  const name = assertSetupName(input.name);
  const setup = resolvePermissionSetup(input.config, name);
  if (!setup) {
    throw new OperationError("not-found", `Unknown setup "${name}".`, ["bumper setup list"]);
  }
  const project = input.config.contexts[input.projectName];
  if (!project) {
    throw new OperationError("not-found", `Unknown project "${input.projectName}".`, ["bumper project list"]);
  }
  try {
    assertCanApplyFolders(input.runningSessions, input.projectName);
  } catch (err) {
    throw new OperationError("conflict", (err as Error).message, [
      "Stop the Session (exit the AI CLI), then run this again.",
    ]);
  }
  return {
    name,
    projectName: input.projectName,
    applied: applyPermissionSetup(project, setup),
    appliesToNewSessions: true,
  };
}
