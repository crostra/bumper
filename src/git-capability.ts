/**
 * What a Project may let an AI do with a GitHub repository.
 *
 * GitHub App permissions are a matrix — contents, pull_requests, issues,
 * workflows, each read or write. Exposing that matrix is exactly the mistake
 * the repository-intent decision set out to avoid: most people do not know
 * that pushing a change under `.github/workflows/` needs a permission beyond
 * `contents: write`, and finding out costs them a confusing rejection.
 *
 * So Bumper exposes a **ladder**, in the user's terms, and maps each rung to
 * the permission set GitHub actually needs. The ladder is honest because the
 * rungs really do nest:
 *
 *   - opening a pull request requires pushing the branch first, so PR access
 *     genuinely sits above write;
 *   - `workflows: write` is meaningless without `contents: write`, because the
 *     workflow file is repository content.
 *
 * There is therefore no useful "PR but not push" or "workflows but not code"
 * combination to lose by making this a ladder rather than checkboxes.
 */

export type GitCapability = "none" | "read" | "write" | "pr" | "workflow";

export const GIT_CAPABILITIES: GitCapability[] = ["none", "read", "write", "pr", "workflow"];

/** Ascending strength. Used to compare, cap, and elevate — never string order. */
const RANK: Record<GitCapability, number> = {
  none: 0, read: 1, write: 2, pr: 3, workflow: 4,
};

export interface GitCapabilityDescriptor {
  id: GitCapability;
  /** What the user is choosing, in their words. */
  label: string;
  /** What it actually allows — one line, no hedging. */
  detail: string;
  /** Exactly what Bumper asks GitHub to mint. Empty for "none". */
  permissions: Record<string, "read" | "write">;
}

/**
 * The ladder. `permissions` is the literal body Bumper sends to GitHub, and the
 * token response is verified against it, so what is written here is what the
 * Sandbox can actually do — not a description of it.
 */
export const GIT_CAPABILITY_DESCRIPTORS: Record<GitCapability, GitCapabilityDescriptor> = {
  none: {
    id: "none",
    label: "No access",
    detail: "This repository is not reachable. No token is issued.",
    permissions: {},
  },
  read: {
    id: "read",
    label: "Read only",
    detail: "Clone and fetch. GitHub rejects every push.",
    permissions: { contents: "read", metadata: "read" },
  },
  write: {
    id: "write",
    label: "Push code",
    detail: "Clone, fetch and push. Workflow files under .github/workflows are still rejected.",
    permissions: { contents: "write", metadata: "read" },
  },
  pr: {
    id: "pr",
    label: "Push and open pull requests",
    detail: "Everything in Push code, plus creating and updating pull requests and issues.",
    permissions: {
      contents: "write", metadata: "read", pull_requests: "write", issues: "write",
    },
  },
  workflow: {
    id: "workflow",
    label: "Also change CI workflows",
    detail: "Everything above, plus pushing changes to .github/workflows. Grant this only when the AI is meant to edit CI.",
    permissions: {
      contents: "write", metadata: "read", pull_requests: "write", issues: "write", workflows: "write",
    },
  },
};

/**
 * The permission set the GitHub App itself is created with.
 *
 * An App's permissions are fixed when it is created: a token can only be
 * *narrower* than what the installation granted, and widening later forces
 * every installation through a re-approval. An App created with `contents`
 * alone can therefore never issue a pull-request token, no matter what the
 * Project asks for.
 *
 * So the App requests the top of the ladder and every issued token stays at
 * the rung the Project chose. The gap is not hidden — it is the thing the UI
 * shows, and `issue()` verifies the minted token against the rung so the claim
 * is checked rather than asserted.
 */
export const GITHUB_APP_PERMISSIONS = GIT_CAPABILITY_DESCRIPTORS.workflow.permissions;

export function isGitCapability(value: unknown): value is GitCapability {
  return typeof value === "string" && value in RANK;
}

/**
 * Read a capability from config or an API body.
 *
 * "write"/"read"/"none" also arrive from the pre-ladder singular schema and
 * mean the same rungs, so old Projects keep working without a migration step.
 */
export function normalizeGitCapability(value: unknown): GitCapability {
  return isGitCapability(value) ? value : "none";
}

export function gitCapabilityRank(capability: GitCapability): number {
  return RANK[capability];
}

/** The weaker of the two. Used wherever a ceiling meets a request. */
export function minGitCapability(a: GitCapability, b: GitCapability): GitCapability {
  return RANK[a] <= RANK[b] ? a : b;
}

export function maxGitCapability(a: GitCapability, b: GitCapability): GitCapability {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Does this rung let git push? Drives banners and the "write" shorthand. */
export function allowsWrite(capability: GitCapability): boolean {
  return RANK[capability] >= RANK.write;
}

/** The permission body for a token at this rung. */
export function gitCapabilityPermissions(capability: GitCapability): Record<string, "read" | "write"> {
  return { ...GIT_CAPABILITY_DESCRIPTORS[capability].permissions };
}

/**
 * Did GitHub mint exactly the rung we asked for?
 *
 * Extra permissions are a mismatch, not a bonus: a token wider than the
 * Project's choice must never reach the Room, so the caller revokes it.
 */
export function tokenMatchesCapability(
  capability: GitCapability,
  granted: unknown,
): boolean {
  if (!granted || typeof granted !== "object") return false;
  const actual = granted as Record<string, unknown>;
  /*
   * `metadata: read` is mandatory on every installation token and grants
   * nothing on its own, so GitHub may report it or omit it without changing
   * what the token can do. Compare the permissions that carry real access and
   * treat metadata as noise in both directions.
   */
  const meaningful = (row: Record<string, unknown>) =>
    Object.entries(row).filter(([name, level]) => !(name === "metadata" && level === "read"));

  const expected = meaningful(gitCapabilityPermissions(capability));
  const received = meaningful(actual);
  if (expected.length !== received.length) return false;
  return expected.every(([name, level]) => actual[name] === level);
}

/** Short human summary for banners and events. */
export function describeGitCapability(capability: GitCapability): string {
  return GIT_CAPABILITY_DESCRIPTORS[capability].label;
}
