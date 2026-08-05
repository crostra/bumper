export interface GitHubRepositoryIntent {
  owner: string;
  repository: string;
  fullName: string;
  httpsUrl: string;
  cloneUrl: string;
}

export interface GitHubIntentInstallation {
  id: number | string;
  settingsUrl?: string;
  repositories: Array<{ id: number; fullName: string }>;
}

export interface GitHubIntentConnection {
  id: string;
  ownerLogin?: string;
  ownerType?: string;
  connected: boolean;
  installations: GitHubIntentInstallation[];
}

export interface GitHubIntentBinding {
  gitProviderConnectionId?: string | null;
  gitInstallationId?: number | null;
  gitRepositoryId?: number | null;
  gitRepository?: string | null;
}

export interface GitHubIntentMatch {
  connectionId: string;
  installationId: number | string;
  repositoryId: number;
  fullName: string;
  ownerLogin: string;
  ownerType: string;
  settingsUrl?: string;
}

export type GitHubRepositoryIntentResolution =
  | { status: "invalid"; input: string; error: string }
  | {
    status: "owner-missing" | "reconnect-required" | "repository-missing";
    intent: GitHubRepositoryIntent;
    connections: Array<{
      id: string;
      ownerLogin: string;
      ownerType: string;
      connected: boolean;
      settingsUrls: string[];
    }>;
  }
  | {
    status: "available" | "bound";
    intent: GitHubRepositoryIntent;
    matches: GitHubIntentMatch[];
    selected: GitHubIntentMatch;
  };

const OWNER = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
const REPOSITORY = /^(?!\.{1,2}$)[a-z\d._-]{1,100}$/i;

function repositoryIntent(owner: string, repository: string): GitHubRepositoryIntent | undefined {
  const cleanOwner = owner.trim();
  const cleanRepository = repository.trim().replace(/\.git$/i, "");
  if (!OWNER.test(cleanOwner) || !REPOSITORY.test(cleanRepository)) return undefined;
  const fullName = `${cleanOwner}/${cleanRepository}`;
  return {
    owner: cleanOwner,
    repository: cleanRepository,
    fullName,
    httpsUrl: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
  };
}

/**
 * Parse only an unambiguous github.com repository reference.
 *
 * Query, fragment, credentials, ports and extra path components are rejected so
 * pasted text can never smuggle an unrelated navigation target into the UI.
 */
export function parseGitHubRepositoryIntent(input: unknown): GitHubRepositoryIntent | undefined {
  const value = String(input ?? "").trim();
  if (!value) return undefined;

  const scp = /^git@github\.com:([^/]+)\/([^/]+)\/?$/i.exec(value);
  if (scp) return repositoryIntent(scp[1], scp[2]);

  if (!value.includes("://")) {
    const short = /^([^/]+)\/([^/]+)\/?$/.exec(value);
    return short ? repositoryIntent(short[1], short[2]) : undefined;
  }

  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com"
    || url.port || url.username || url.password || url.search || url.hash) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return undefined;
  // Percent-encoded owner/repository text is deliberately not normalized.
  if (parts.some((part) => part.includes("%"))) return undefined;
  return repositoryIntent(parts[0], parts[1]);
}

/** Organization field accepts a login or a normal GitHub owner/repository URL. */
export function parseGitHubOwnerInput(input: unknown): string | undefined {
  const value = String(input ?? "").trim();
  if (OWNER.test(value)) return value;
  const repository = parseGitHubRepositoryIntent(value);
  if (repository) return repository.owner;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com"
      || url.port || url.username || url.password || url.search || url.hash) return undefined;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 1 && OWNER.test(parts[0]) && !parts[0].includes("%")) return parts[0];
  } catch { /* invalid owner input */ }
  return undefined;
}

/** Pure/local resolver. It never contacts GitHub or guesses another owner. */
export function resolveGitHubRepositoryIntent(
  input: unknown,
  connections: GitHubIntentConnection[],
  binding: GitHubIntentBinding = {},
): GitHubRepositoryIntentResolution {
  const intent = parseGitHubRepositoryIntent(input);
  if (!intent) {
    return {
      status: "invalid",
      input: String(input ?? ""),
      error: "Enter a GitHub repository URL such as https://github.com/owner/repository.",
    };
  }
  const ownerConnections = connections.filter((connection) =>
    String(connection.ownerLogin ?? "").toLowerCase() === intent.owner.toLowerCase());
  const summaries = ownerConnections.map((connection) => ({
    id: connection.id,
    ownerLogin: String(connection.ownerLogin ?? intent.owner),
    ownerType: String(connection.ownerType ?? "Account"),
    connected: connection.connected,
    settingsUrls: [...new Set(connection.installations.map((item) => item.settingsUrl).filter(Boolean))] as string[],
  }));
  if (!ownerConnections.length) return { status: "owner-missing", intent, connections: [] };

  const connected = ownerConnections.filter((connection) => connection.connected);
  if (!connected.length) return { status: "reconnect-required", intent, connections: summaries };

  const matches = connected.flatMap((connection) => connection.installations.flatMap((installation) =>
    installation.repositories
      .filter((repository) => repository.fullName.toLowerCase() === intent.fullName.toLowerCase())
      .map((repository) => ({
        connectionId: connection.id,
        installationId: installation.id,
        repositoryId: repository.id,
        fullName: repository.fullName,
        ownerLogin: String(connection.ownerLogin ?? intent.owner),
        ownerType: String(connection.ownerType ?? "Account"),
        settingsUrl: installation.settingsUrl,
      }))));
  if (!matches.length) return { status: "repository-missing", intent, connections: summaries };

  const exact = matches.find((match) =>
    match.connectionId === String(binding.gitProviderConnectionId ?? "")
    && Number(match.installationId) === Number(binding.gitInstallationId ?? 0)
    && match.repositoryId === Number(binding.gitRepositoryId ?? 0)
    && match.fullName.toLowerCase() === String(binding.gitRepository ?? "").toLowerCase());
  const selected = exact ?? matches[0];
  return { status: exact ? "bound" : "available", intent, matches, selected };
}
