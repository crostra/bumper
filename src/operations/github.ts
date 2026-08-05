/**
 * GitHub connections and repository bindings.
 *
 * One step here genuinely needs a browser: creating a GitHub App goes through
 * GitHub's manifest flow, which is an HTML form the browser must POST itself.
 * That is GitHub's design, not Bumper's, and no CLI can do it headlessly.
 *
 * Everything *else* about GitHub is local and was only missing a command —
 * refreshing installations, disconnecting, and binding a repository to a
 * Project. Without the last one `bumper git status` could report access and
 * never let anyone grant it, which made Git read-only-by-accident from a
 * terminal.
 *
 * The manifest hand-off is not reimplemented here. `bumper github connect`
 * starts the same local app server the GUI uses and prints its URL, so there is
 * exactly one implementation of the flow.
 */
import type { Config, GitRepositoryBinding } from "../types.js";
import { normalizeGitCapability, type GitCapability } from "../git-capability.js";
import { projectGitBindings, withGitBindings } from "../git-repositories.js";
import { resolveGitHubRepositoryIntent } from "../github-repository-intent.js";
import { OperationError } from "./error.js";

export interface GitHubConnectionView {
  id: string;
  ownerLogin: string;
  ownerType: string;
  connected: boolean;
  installations: { id: number; accountLogin: string; repositorySelection: string; repositoryCount: number }[];
}

export function listGitHubConnections(
  config: Config,
  isConnected: (connectionId: string) => boolean,
): GitHubConnectionView[] {
  return Object.entries(config.githubApps ?? {}).map(([id, app]) => ({
    id,
    ownerLogin: app.ownerLogin ?? "",
    ownerType: app.ownerType ?? "",
    connected: isConnected(id),
    installations: (app.installations ?? []).map((installation) => ({
      id: installation.id,
      accountLogin: installation.accountLogin,
      repositorySelection: installation.repositorySelection,
      repositoryCount: installation.repositories?.length ?? 0,
    })),
  }));
}

/** One installation as it is stored, from one as GitHub reports it. */
export interface FetchedInstallation {
  id: number;
  account: string;
  accountType: string;
  repositorySelection: string;
  settingsUrl?: string;
  repositories: { id: number; fullName: string; private?: boolean }[];
}

/**
 * Translate GitHub's installation shape into the stored one.
 *
 * Shared because both entry points refresh, and a field dropped on one path
 * would make a repository unbindable there for reasons invisible on the other.
 */
export function storedInstallations(fetched: FetchedInstallation[]) {
  return fetched.map((installation) => ({
    id: installation.id,
    accountLogin: installation.account,
    accountType: installation.accountType,
    repositorySelection: installation.repositorySelection,
    settingsUrl: installation.settingsUrl,
    repositories: installation.repositories.map((repository) => ({
      id: repository.id,
      fullName: repository.fullName,
      private: Boolean(repository.private),
    })),
  }));
}

export interface RefreshSummary {
  connectionId: string;
  installations: number;
  repositories: number;
  allRepositories: boolean;
}

export function summarizeRefresh(connectionId: string, fetched: FetchedInstallation[]): RefreshSummary {
  return {
    connectionId,
    installations: fetched.length,
    repositories: fetched.reduce((sum, item) => sum + item.repositories.length, 0),
    allRepositories: fetched.some((item) => item.repositorySelection === "all"),
  };
}

export interface BindRepositoryResult {
  projectName: string;
  fullName: string;
  capability: GitCapability;
  connectionId: string;
  installationId: number;
  repositoryId: number;
  /** Every binding after the change, so the caller can print the whole picture. */
  bindings: GitRepositoryBinding[];
}

/**
 * Bind one repository at one rung of the capability ladder.
 *
 * Resolution goes through the same local resolver the GUI uses, so a URL that
 * cannot be proven — unknown owner, App not installed there, repository not
 * selected — fails the same way here with the same wording, instead of being
 * written as an unprovable binding that fails later inside the Sandbox.
 */
export function bindProjectRepository(input: {
  config: Config;
  projectName: string;
  repository: string;
  capability: string;
  isConnected: (connectionId: string) => boolean;
}): BindRepositoryResult {
  const projectName = input.projectName.trim();
  const project = input.config.contexts[projectName];
  if (!project) {
    throw new OperationError("not-found", `Unknown project "${projectName}".`, ["bumper project list"]);
  }

  const capability = normalizeGitCapability(input.capability);
  if (capability === "none") {
    throw new OperationError("invalid", `Unknown Git access level "${input.capability}".`, [
      "Levels: read, write, pr, workflow",
      `bumper git repo add <url> --access read -p "${projectName}"`,
    ]);
  }

  const connections = Object.entries(input.config.githubApps ?? {}).map(([connectionId, app]) => ({
    id: connectionId,
    ownerLogin: app.ownerLogin,
    ownerType: app.ownerType,
    connected: input.isConnected(connectionId),
    installations: app.installations,
  }));

  const resolution = resolveGitHubRepositoryIntent(input.repository, connections, project);
  if (resolution.status === "invalid") {
    throw new OperationError("invalid", resolution.error, [
      "Pass a repository URL: bumper git repo add https://github.com/owner/repo",
    ]);
  }
  if (resolution.status !== "available" && resolution.status !== "bound") {
    // owner-missing / reconnect-required / repository-missing each need a
    // different move, and the resolver already knows which.
    const fix = resolution.status === "repository-missing"
      ? [
        "Add the repository to the App installation on GitHub, then:",
        "  bumper github refresh",
      ]
      : [
        "bumper github connect        # create or reconnect the App for this owner",
        "bumper github list           # owners Bumper can already reach",
      ];
    throw new OperationError(
      "invalid",
      `Cannot bind ${resolution.intent.fullName}: ${resolution.status.replace(/-/g, " ")}.`,
      fix,
    );
  }

  const selected = resolution.selected;
  const existing = projectGitBindings(project).filter(
    (row) => row.fullName.toLowerCase() !== selected.fullName.toLowerCase(),
  );
  const next: GitRepositoryBinding = {
    fullName: selected.fullName,
    connectionId: selected.connectionId,
    installationId: Number(selected.installationId),
    repositoryId: selected.repositoryId,
    capability,
  };
  const bindings = [...existing, next];
  Object.assign(project, withGitBindings(project, bindings));

  return {
    projectName,
    fullName: next.fullName,
    capability,
    connectionId: next.connectionId,
    installationId: next.installationId,
    repositoryId: next.repositoryId,
    bindings,
  };
}

export function unbindProjectRepository(input: {
  config: Config;
  projectName: string;
  repository: string;
}): { projectName: string; fullName: string; bindings: GitRepositoryBinding[] } {
  const projectName = input.projectName.trim();
  const project = input.config.contexts[projectName];
  if (!project) {
    throw new OperationError("not-found", `Unknown project "${projectName}".`, ["bumper project list"]);
  }
  const wanted = input.repository.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const current = projectGitBindings(project);
  const bindings = current.filter((row) => row.fullName.toLowerCase() !== wanted.toLowerCase());
  if (bindings.length === current.length) {
    throw new OperationError("not-found", `This Project does not bind "${input.repository}".`, [
      `bumper git status -p "${projectName}"`,
    ]);
  }
  Object.assign(project, withGitBindings(project, bindings));
  return { projectName, fullName: wanted, bindings };
}

/**
 * Where the browser has to take over, and why.
 *
 * Stated as data so the CLI and the GUI describe the same limit rather than
 * each inventing a sentence about it.
 */
export const GITHUB_APP_BROWSER_REASON =
  "Creating a GitHub App uses GitHub's manifest flow, which is an HTML form the browser must submit itself. "
  + "Bumper opens a local page that performs that submission; nothing is sent anywhere else.";
