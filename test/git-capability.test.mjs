/**
 * The Git capability ladder, and the multi-repository bindings built on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GIT_CAPABILITY_DESCRIPTORS,
  GITHUB_APP_PERMISSIONS,
  allowsWrite,
  gitCapabilityPermissions,
  maxGitCapability,
  minGitCapability,
  normalizeGitCapability,
  tokenMatchesCapability,
} from "../dist/git-capability.js";
import {
  findGitBinding,
  gitTokenGroups,
  projectGitBindings,
  projectGitCeiling,
  withGitBindings,
} from "../dist/git-repositories.js";

const BOUND = {
  fullName: "acme/app", connectionId: "gh-a", installationId: 1, repositoryId: 11,
};

test("the ladder nests: each rung is a superset of the one below", () => {
  const order = ["read", "write", "pr", "workflow"];
  for (let i = 1; i < order.length; i += 1) {
    const lower = gitCapabilityPermissions(order[i - 1]);
    const upper = gitCapabilityPermissions(order[i]);
    for (const [name, level] of Object.entries(lower)) {
      const widened = level === "read" && upper[name] === "write";
      assert.ok(upper[name] === level || widened, `${order[i]} must keep ${name} from ${order[i - 1]}`);
    }
  }
  assert.deepEqual(gitCapabilityPermissions("none"), {});
});

test("only rungs at write and above can push", () => {
  assert.equal(allowsWrite("none"), false);
  assert.equal(allowsWrite("read"), false);
  assert.equal(allowsWrite("write"), true);
  assert.equal(allowsWrite("pr"), true);
  assert.equal(allowsWrite("workflow"), true);
});

test("workflow access is never implied by push access", () => {
  assert.equal(gitCapabilityPermissions("write").workflows, undefined);
  assert.equal(gitCapabilityPermissions("pr").workflows, undefined);
  assert.equal(gitCapabilityPermissions("workflow").workflows, "write");
});

test("the App is created at the top of the ladder so no rung is unreachable later", () => {
  assert.deepEqual(GITHUB_APP_PERMISSIONS, GIT_CAPABILITY_DESCRIPTORS.workflow.permissions);
});

test("a token wider than the rung is rejected, metadata aside", () => {
  assert.ok(tokenMatchesCapability("read", { contents: "read" }));
  assert.ok(tokenMatchesCapability("read", { contents: "read", metadata: "read" }));
  // Wider than asked: contents write when read was requested.
  assert.equal(tokenMatchesCapability("read", { contents: "write" }), false);
  // Wider than asked: a permission the rung never includes.
  assert.equal(tokenMatchesCapability("write", { contents: "write", workflows: "write" }), false);
  // Narrower than asked is also a mismatch — the Sandbox would fail confusingly.
  assert.equal(tokenMatchesCapability("pr", { contents: "write" }), false);
  assert.equal(tokenMatchesCapability("read", null), false);
});

test("unknown capability values fall back to no access", () => {
  assert.equal(normalizeGitCapability("admin"), "none");
  assert.equal(normalizeGitCapability(undefined), "none");
  assert.equal(normalizeGitCapability("workflow"), "workflow");
  assert.equal(minGitCapability("workflow", "read"), "read");
  assert.equal(maxGitCapability("workflow", "read"), "workflow");
});

test("the singular pre-ladder binding is read as a one-entry list", () => {
  const bindings = projectGitBindings({
    gitRepository: "acme/app",
    gitAccess: "write",
    gitProviderConnectionId: "gh-a",
    gitInstallationId: 1,
    gitRepositoryId: 11,
  });
  assert.deepEqual(bindings, [{ ...BOUND, capability: "write" }]);
});

test("a binding that cannot name its provider ids is dropped, not guessed", () => {
  assert.deepEqual(projectGitBindings({
    gitRepositories: [
      { fullName: "acme/app", connectionId: "", installationId: 1, repositoryId: 11, capability: "read" },
      { fullName: "acme/b", connectionId: "gh-a", installationId: 0, repositoryId: 2, capability: "read" },
      { fullName: "", connectionId: "gh-a", installationId: 1, repositoryId: 3, capability: "read" },
    ],
  }), []);
});

test("a repository bound at none is an absent binding, not a weak one", () => {
  assert.deepEqual(projectGitBindings({
    gitRepositories: [{ ...BOUND, capability: "none" }],
  }), []);
});

test("a repository listed twice keeps the stronger rung", () => {
  const bindings = projectGitBindings({
    gitRepositories: [
      { ...BOUND, capability: "read" },
      { ...BOUND, capability: "pr" },
    ],
  });
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].capability, "pr");
});

test("the singular mirror reports the strongest binding, never wider than write", () => {
  const next = withGitBindings({}, [
    { ...BOUND, capability: "read" },
    { fullName: "acme/infra", connectionId: "gh-a", installationId: 1, repositoryId: 12, capability: "workflow" },
  ]);
  assert.equal(next.gitRepository, "acme/infra");
  // The legacy field cannot express "workflow"; understating is the safe way to be wrong.
  assert.equal(next.gitAccess, "write");
  assert.equal(next.gitRepositoryId, 12);
  assert.equal(next.gitRepositories.length, 2);
});

test("an empty binding list clears the singular mirror", () => {
  const next = withGitBindings({ gitRepository: "acme/app", gitAccess: "write" }, []);
  assert.equal(next.gitRepository, "");
  assert.equal(next.gitAccess, "none");
  assert.equal(next.gitRepositoryId, undefined);
});

/**
 * An installation token carries one permission set for a list of repositories,
 * so repositories at different rungs cannot share one. Grouping is what keeps
 * a read-only repository read-only when a sibling is bound to push.
 */
test("tokens group by connection, installation and rung", () => {
  const groups = gitTokenGroups([
    { fullName: "acme/app", connectionId: "gh-a", installationId: 1, repositoryId: 11, capability: "read" },
    { fullName: "acme/web", connectionId: "gh-a", installationId: 1, repositoryId: 12, capability: "read" },
    { fullName: "acme/infra", connectionId: "gh-a", installationId: 1, repositoryId: 13, capability: "workflow" },
    { fullName: "other/x", connectionId: "gh-b", installationId: 2, repositoryId: 21, capability: "read" },
  ]);
  assert.equal(groups.length, 3);
  const read = groups.find((g) => g.connectionId === "gh-a" && g.capability === "read");
  assert.deepEqual(read.repositories.map((r) => r.fullName), ["acme/app", "acme/web"]);
  // Same owner, stronger rung — must not ride along on the read token.
  assert.equal(groups.find((g) => g.capability === "workflow").repositories.length, 1);
  // Different owner — a separate App and a separate key entirely.
  assert.equal(groups.find((g) => g.connectionId === "gh-b").repositories.length, 1);
});

test("lookups and the ceiling read from the same bindings", () => {
  const project = {
    gitRepositories: [
      { ...BOUND, capability: "read" },
      { fullName: "acme/infra", connectionId: "gh-a", installationId: 1, repositoryId: 12, capability: "pr" },
    ],
  };
  assert.equal(findGitBinding(project, "ACME/APP").capability, "read");
  assert.equal(findGitBinding(project, "nope/missing"), undefined);
  assert.equal(projectGitCeiling(project), "pr");
  assert.equal(projectGitCeiling({}), "none");
});
