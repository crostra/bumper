/**
 * A Project binding several repositories, each at its own rung, end to end
 * through the real /api/contexts handler.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";
import { projectGitBindings } from "../dist/git-repositories.js";

function installedConfig(root, workspace) {
  return {
    webPort: 0,
    defaultContext: "demo",
    githubApps: {
      "gh-acme": {
        id: "gh-acme",
        appId: 1,
        slug: "bumper-acme",
        ownerLogin: "acme",
        ownerType: "Organization",
        installations: [{
          id: 100,
          accountLogin: "acme",
          accountType: "Organization",
          repositorySelection: "selected",
          repositories: [
            { id: 11, fullName: "acme/app", private: true },
            { id: 12, fullName: "acme/infra", private: true },
            { id: 13, fullName: "acme/docs", private: true },
          ],
        }],
      },
      "gh-personal": {
        id: "gh-personal",
        appId: 2,
        slug: "bumper-personal",
        ownerLogin: "example-user",
        ownerType: "User",
        installations: [{
          id: 200,
          accountLogin: "example-user",
          accountType: "User",
          repositorySelection: "all",
          repositories: [{ id: 21, fullName: "example-user/scratch", private: false }],
        }],
      },
    },
    contexts: {
      demo: {
        mode: "read-write", workspace, inheritMode: false, backends: [],
        room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked", doors: [] },
      },
    },
  };
}

async function withApp(t, build) {
  const root = mkdtempSync(join(tmpdir(), "bumper-multi-repo-"));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  const cfgPath = join(root, "bumper.config.json");
  writeFileSync(cfgPath, JSON.stringify(build(root, workspace)));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = cfgPath;
  process.env.BUMPER_STATE = join(root, "state.json");
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(process.cwd(), "dist", "cli.js"));
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });
  return { handle, workspace };
}

function put(handle, workspace, patch) {
  return fetch(`${handle.url}/api/contexts`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      previous: "demo", name: "demo", description: "", workspace,
      mode: "read-write", inheritMode: true, gitIgnored: "visible",
      readPaths: [], writePaths: [], denyReadPaths: [], denyWritePaths: [],
      commands: {}, native: { allow: [], deny: [] }, loginProfiles: {},
      repos: [], allowedHosts: [], backends: [],
      room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked", doors: [] },
      ...patch,
    }),
  });
}

test("a Project binds repositories from several owners at different rungs", async (t) => {
  const { handle, workspace } = await withApp(t, installedConfig);
  const response = await put(handle, workspace, {
    gitRepositories: [
      { fullName: "acme/app", connectionId: "gh-acme", installationId: 100, repositoryId: 11, capability: "pr" },
      { fullName: "acme/infra", connectionId: "gh-acme", installationId: 100, repositoryId: 12, capability: "read" },
      { fullName: "example-user/scratch", connectionId: "gh-personal", installationId: 200, repositoryId: 21, capability: "workflow" },
    ],
  });
  assert.equal(response.status, 200, await response.text());

  const stored = loadConfig().config.contexts.demo;
  assert.deepEqual(
    projectGitBindings(stored).map((row) => [row.fullName, row.capability]),
    [["acme/app", "pr"], ["acme/infra", "read"], ["example-user/scratch", "workflow"]],
  );
  // The singular mirror keeps an older build readable, understating rather than
  // overstating: it cannot express "workflow", so it says write.
  assert.equal(stored.gitRepository, "example-user/scratch");
  assert.equal(stored.gitAccess, "write");

  const state = await (await fetch(`${handle.url}/api/state`)).json();
  assert.equal(state.contexts.demo.gitCapability, "workflow");
  assert.equal(state.contexts.demo.gitRepositories.length, 3);
  // The ladder itself is served, so the UI cannot invent its own rungs.
  assert.equal(state.gitCapabilities.workflow.permissions.workflows, "write");
  assert.equal(state.gitCapabilities.write.permissions.workflows, undefined);
});

test("a repository the caller cannot prove is refused, not stored", async (t) => {
  const { handle, workspace } = await withApp(t, installedConfig);
  // Right repository, wrong owner connection.
  const wrongOwner = await put(handle, workspace, {
    gitRepositories: [
      { fullName: "acme/app", connectionId: "gh-personal", installationId: 200, repositoryId: 11, capability: "read" },
    ],
  });
  assert.equal(wrongOwner.status, 400);
  // Repository that is not in any installation list.
  const notInstalled = await put(handle, workspace, {
    gitRepositories: [
      { fullName: "acme/secret", connectionId: "gh-acme", installationId: 100, repositoryId: 99, capability: "read" },
    ],
  });
  assert.equal(notInstalled.status, 400);
  assert.deepEqual(projectGitBindings(loadConfig().config.contexts.demo), []);
});

test("saving another tab does not unbind Git", async (t) => {
  const { handle, workspace } = await withApp(t, installedConfig);
  await put(handle, workspace, {
    gitRepositories: [
      { fullName: "acme/app", connectionId: "gh-acme", installationId: 100, repositoryId: 11, capability: "read" },
    ],
  });
  // A Network save carries no Git fields at all.
  const networkSave = await put(handle, workspace, {
    room: {
      enabled: true, image: "docker.io/library/alpine:3.20",
      egress: "allowlist", egressTemplates: ["anthropic"], egressHosts: [], doors: [],
    },
  });
  assert.equal(networkSave.status, 200, await networkSave.text());
  const stored = loadConfig().config.contexts.demo;
  assert.equal(stored.room.egress, "allowlist");
  assert.deepEqual(projectGitBindings(stored).map((row) => row.fullName), ["acme/app"]);
});

test("disconnecting one owner keeps the other owner's repositories", async (t) => {
  const { handle, workspace } = await withApp(t, installedConfig);
  await put(handle, workspace, {
    gitRepositories: [
      { fullName: "acme/app", connectionId: "gh-acme", installationId: 100, repositoryId: 11, capability: "read" },
      { fullName: "example-user/scratch", connectionId: "gh-personal", installationId: 200, repositoryId: 21, capability: "write" },
    ],
  });
  const response = await fetch(`${handle.url}/api/github/disconnect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId: "gh-acme" }),
  });
  assert.equal(response.status, 200, await response.text());
  const stored = loadConfig().config.contexts.demo;
  assert.deepEqual(
    projectGitBindings(stored).map((row) => row.fullName),
    ["example-user/scratch"],
    "only the disconnected owner's repositories may be dropped",
  );
});

test("a Project bound only at read still offers temporary write; nothing else does", async (t) => {
  const { handle, workspace } = await withApp(t, installedConfig);
  await put(handle, workspace, {
    gitRepositories: [
      { fullName: "acme/app", connectionId: "gh-acme", installationId: 100, repositoryId: 11, capability: "read" },
    ],
    gitWriteUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.ok(loadConfig().config.contexts.demo.gitWriteUntil, "read bindings keep the elevation window");

  await put(handle, workspace, {
    gitRepositories: [
      { fullName: "acme/app", connectionId: "gh-acme", installationId: 100, repositoryId: 11, capability: "workflow" },
    ],
    gitWriteUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(
    loadConfig().config.contexts.demo.gitWriteUntil,
    "",
    "a binding already above write has nothing to elevate to",
  );
});
