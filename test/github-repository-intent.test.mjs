import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseGitHubOwnerInput,
  parseGitHubRepositoryIntent,
  resolveGitHubRepositoryIntent,
} from "../dist/github-repository-intent.js";

test("GitHub repository intent accepts common clone references and canonicalizes them", () => {
  for (const input of [
    "https://github.com/crostra/bumper",
    "https://github.com/crostra/bumper.git",
    "git@github.com:crostra/bumper.git",
    "crostra/bumper",
  ]) {
    assert.deepEqual(parseGitHubRepositoryIntent(input), {
      owner: "crostra",
      repository: "bumper",
      fullName: "crostra/bumper",
      httpsUrl: "https://github.com/crostra/bumper",
      cloneUrl: "https://github.com/crostra/bumper.git",
    });
  }
});

test("GitHub repository intent rejects ambiguous or navigational input", () => {
  for (const input of [
    "",
    "https://gitlab.com/crostra/bumper",
    "http://github.com/crostra/bumper",
    "https://user:secret@github.com/crostra/bumper",
    "https://github.com/crostra/bumper/issues",
    "https://github.com/crostra/bumper?tab=readme",
    "https://github.com/crostra/bumper#readme",
    "crostra",
  ]) {
    assert.equal(parseGitHubRepositoryIntent(input), undefined, input);
  }
  assert.equal(parseGitHubOwnerInput("https://github.com/crostra"), "crostra");
  assert.equal(parseGitHubOwnerInput("https://github.com/crostra/bumper"), "crostra");
});

const connections = [{
  id: "gh-crostra",
  ownerLogin: "crostra",
  ownerType: "Organization",
  connected: true,
  installations: [{
    id: 149,
    settingsUrl: "https://github.com/organizations/crostra/settings/installations/149",
    repositories: [{ id: 1305, fullName: "crostra/bumper" }],
  }],
}];

test("local resolver distinguishes owner, key, repository, available and exact bound states", () => {
  assert.equal(resolveGitHubRepositoryIntent("other/repo", connections).status, "owner-missing");
  assert.equal(resolveGitHubRepositoryIntent("crostra/bumper", [
    { ...connections[0], connected: false },
  ]).status, "reconnect-required");
  assert.equal(resolveGitHubRepositoryIntent("crostra/missing", connections).status, "repository-missing");

  const available = resolveGitHubRepositoryIntent("crostra/bumper", connections);
  assert.equal(available.status, "available");
  assert.deepEqual(available.selected, {
    connectionId: "gh-crostra",
    installationId: 149,
    repositoryId: 1305,
    fullName: "crostra/bumper",
    ownerLogin: "crostra",
    ownerType: "Organization",
    settingsUrl: "https://github.com/organizations/crostra/settings/installations/149",
  });

  assert.equal(resolveGitHubRepositoryIntent("crostra/bumper", connections, {
    gitProviderConnectionId: "gh-crostra",
    gitInstallationId: 149,
    gitRepositoryId: 1305,
    gitRepository: "crostra/bumper",
  }).status, "bound");
});

test("renderer keeps Library as the single create surface and Project as URL-first", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const renderer = readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
  assert.match(renderer, /id="git-repository-intent"/);
  assert.match(renderer, /\/api\/github\/repository-intent/);
  assert.match(renderer, /My personal account/);
  assert.match(renderer, /An Organization/);
  assert.match(renderer, /openLibraryGitHubAccess\(\{\s*intent:/);
  assert.match(renderer, /Live Sessions/);
  /*
   * Access is chosen per repository from the host-defined ladder, never from a
   * list of rungs written into the renderer — a second copy of the labels would
   * drift from the permission set actually requested from GitHub.
   */
  assert.match(renderer, /What the AI may do/);
  assert.match(renderer, /function gitCapabilityOptions/);
  assert.match(renderer, /state\.gitCapabilities/);
  assert.match(renderer, /gitRepositories: bindings/);
  assert.doesNotMatch(renderer, /<option value="workflow">/,
    "capability labels must come from the host, not be hard-coded here");
  assert.equal((renderer.match(/\/api\/github\/connect/g) || []).length, 1,
    "only Library may create a GitHub App connection");
});
