import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  GitHubAppService, createAppJwt, createChunkedSecretStore, githubAppManifest, keychainPromptOptions,
} from "../dist/github-app.js";

class Secrets { constructor() { this.items = new Map(); } get(k) { return this.items.get(k); } set(k, v) { this.items.set(k, v); } delete(k) { this.items.delete(k); } }
const testService = (api, secrets) => new GitHubAppService(api, secrets, () => {});

test("Keychain prompt input is detached from the AI CLI TTY and absent from argv", () => {
  const options = keychainPromptOptions("SECRET_VALUE");
  assert.equal(options.detached, true);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.match(options.input, /SECRET_VALUE/);
  const argv = ["add-generic-password", "-s", "service", "-a", "account", "-w"];
  assert.doesNotMatch(argv.join(" "), /SECRET_VALUE/);
});

test("long Keychain secrets are chunked below the security prompt limit and round-trip", () => {
  const passwords = new Secrets();
  const store = createChunkedSecretStore(passwords, 80);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

  store.set("pem", pem);

  assert.equal(store.get("pem"), pem);
  assert.ok(passwords.get("pem.meta")?.startsWith("v1|"));
  assert.equal(passwords.get("pem"), undefined, "the legacy single-item value must be removed");
  for (const [name, value] of passwords.items) {
    if (name.startsWith("pem.") && name !== "pem.meta") {
      assert.ok(value.length <= 80, `${name} exceeds the safe prompt line length`);
    }
  }
});

test("chunked Keychain writes commit atomically and reject incomplete generations", () => {
  const passwords = new Secrets();
  const store = createChunkedSecretStore(passwords, 80);
  store.set("pem", "old complete value");
  const oldMeta = passwords.get("pem.meta");
  const originalSet = passwords.set.bind(passwords);
  let chunkWrites = 0;
  passwords.set = (name, value) => {
    if (/^pem\.[a-f0-9]+\.\d+$/.test(name) && ++chunkWrites === 2) throw new Error("simulated write failure");
    originalSet(name, value);
  };

  assert.throws(() => store.set("pem", "x".repeat(300)), /simulated write failure/);
  assert.equal(passwords.get("pem.meta"), oldMeta, "the committed generation must not move");
  assert.equal(store.get("pem"), "old complete value");

  passwords.set = originalSet;
  const [, generation, count] = oldMeta.split("|");
  passwords.delete(`pem.${generation}.${Number(count) - 1}`);
  assert.equal(store.get("pem"), undefined, "a missing chunk must fail closed");
});

test("chunked Keychain reads the legacy one-item base64 format", () => {
  const passwords = new Secrets();
  passwords.set("pem", Buffer.from("legacy value").toString("base64"));
  assert.equal(createChunkedSecretStore(passwords).get("pem"), "legacy value");
});

/**
 * The App is created at the top of the capability ladder on purpose: an App's
 * permissions are fixed at creation, so one created with `contents` alone could
 * never issue a pull-request token and the Project would hit a dead end only a
 * reinstall clears. What keeps that honest is that every *token* stays at the
 * rung the Project chose — asserted in the issuance tests below.
 */
test("GitHub App is created able to reach the whole capability ladder", () => {
  const manifest = githubAppManifest("http://127.0.0.1/callback");
  assert.deepEqual(manifest.default_permissions, {
    contents: "write",
    metadata: "read",
    pull_requests: "write",
    issues: "write",
    workflows: "write",
  });
  assert.equal(manifest.public, false);
  // Still deliberately absent — nothing here administers the account itself.
  assert.doesNotMatch(
    JSON.stringify(manifest),
    /actions|deployments|packages|members|administration/i,
  );
});

test("App JWT is RS256 and installation token request asserts exact provider scope", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secret = new Secrets(); secret.set("app-id", "123"); secret.set("pem", privateKey.export({ type: "pkcs1", format: "pem" }).toString());
  const calls = [];
  const api = { async request(method, path, body) {
    calls.push({ method, path, body });
    if (path.includes("access_tokens")) return {
      status: 201,
      body: {
        token: "TOKEN_VALUE",
        expires_at: "2030-01-01T00:00:00Z",
        permissions: { contents: "read" },
        repositories: [{ id: 7, full_name: "acme/app" }],
      },
    };
    return { status: 404, body: {} };
  } };
  const events = [];
  const service = new GitHubAppService(api, secret, (event) => events.push(event));
  const token = await service.issue(
    "42",
    [{ id: 7, fullName: "acme/app", owner: "acme", name: "app" }],
    "read",
    { projectName: "Demo", sessionId: "session-audit-1" },
  );
  assert.equal(token.scope, "read");
  assert.equal(token.capability, "read");
  // The App may reach the whole ladder; the token asks for one rung only.
  assert.deepEqual(calls[0].body, {
    repository_ids: [7],
    permissions: { contents: "read", metadata: "read" },
  });
  // The token is in the *response*, so asserting it is absent from the recorded
  // requests can never fail. Assert what actually matters instead: the value is
  // returned to the caller and is not smuggled into the request or the log line.
  assert.equal(token.token, "TOKEN_VALUE");
  assert.doesNotMatch(JSON.stringify(calls.map((c) => c.body)), /TOKEN_VALUE/,
    "the token must never be echoed back into a request body");
  assert.equal(events[0].sessionId, "session-audit-1");
  assert.equal(events[0].repository, "acme/app");
  assert.equal(events[0].access, "read");
  assert.equal(events[0].capability, "read");
  assert.doesNotMatch(JSON.stringify(events), /TOKEN_VALUE/,
    "structured Session audit metadata must never contain the token");
  const jwt = createAppJwt("123", secret.get("pem"), 0);
  assert.equal(JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString()).alg, "RS256");
});

test("installation token issuance fails closed when GitHub returns another repository", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secret = new Secrets();
  secret.set("app-id", "123");
  secret.set("pem", privateKey.export({ type: "pkcs1", format: "pem" }).toString());
  const calls = [];
  const api = { async request(method, path, body, headers) {
    calls.push({ method, path, body, authorization: headers?.authorization });
    if (method === "DELETE" && path === "/installation/token") {
      return { status: 204, body: {} };
    }
    return {
      status: 201,
      body: {
        token: "TOO_BROAD",
        expires_at: "2030-01-01T00:00:00Z",
        permissions: { contents: "read", metadata: "read" },
        repositories: [{ id: 8, full_name: "acme/other" }],
      },
    };
  } };
  await assert.rejects(
    () => new GitHubAppService(api, secret).issue(
      "42",
      [{ id: 7, fullName: "acme/app", owner: "acme", name: "app" }],
      "read",
    ),
    /repository did not match/,
  );
  assert.ok(calls.some((call) =>
    call.method === "DELETE"
      && call.path === "/installation/token"
      && call.authorization === "token TOO_BROAD"),
  "a rejected provider response must revoke the unexpected token");
  assert.deepEqual(JSON.parse(secret.get("tokens") ?? "[]"), [],
    "a revoked unexpected token must leave the sweep store");
});

/**
 * F2 regression (2026-07-26 review): installations() sent the App JWT to
 * /installation/repositories, which GitHub authenticates with an *installation
 * token*. Against real GitHub it 403s — and the old code swallowed the failure
 * into an empty array, so the repository picker showed nothing with no reason.
 * The mock returned 404 for that path and the function was never called by a test.
 */
test("installations() lists repos with an installation token and revokes it", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secret = new Secrets();
  secret.set("app-id", "123");
  secret.set("pem", privateKey.export({ type: "pkcs1", format: "pem" }).toString());

  const calls = [];
  const api = { async request(method, path, body, headers) {
    calls.push({ method, path, body, auth: headers?.authorization ?? "" });
    if (method === "GET" && path === "/app/installations") {
      return {
        status: 200,
        body: [{
          id: 42,
          repository_selection: "selected",
          account: { login: "acme", type: "Organization" },
        }],
      };
    }
    if (method === "POST" && path.includes("access_tokens")) {
      return { status: 201, body: { token: "LISTING_TOKEN", expires_at: "2030-01-01T00:00:00Z", permissions: {} } };
    }
    if (method === "GET" && path.startsWith("/installation/repositories")) {
      // Only an installation token is accepted here — reject a JWT like GitHub does.
      if (!headers?.authorization?.startsWith("token ")) return { status: 403, body: { message: "Bad credentials" } };
      return { status: 200, body: { repositories: [{ id: 7, full_name: "acme/alpha", name: "alpha", owner: { login: "acme" } }] } };
    }
    if (method === "DELETE" && path === "/installation/token") return { status: 204, body: {} };
    return { status: 404, body: {} };
  } };

  const service = testService(api, secret);
  const installations = await service.installations();

  assert.equal(installations.length, 1);
  assert.equal(installations[0].repositorySelection, "selected");
  assert.deepEqual(installations[0].repositories.map((r) => r.fullName), ["acme/alpha"]);

  const listing = calls.find((c) => c.path.startsWith("/installation/repositories"));
  assert.ok(listing, "repositories must actually be listed");
  assert.match(listing.auth, /^token /, "must authenticate with an installation token, not a JWT");
  const mint = calls.find((c) => c.method === "POST" && c.path.includes("access_tokens"));
  assert.deepEqual(mint.body, { permissions: { metadata: "read" } },
    "repository discovery must not mint a contents-capable token");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path === "/installation/token"),
    "the listing token must be revoked, not left alive");
  assert.deepEqual(JSON.parse(secret.get("tokens") ?? "[]"), [],
    "the listing token must leave the crash-sweep store after revocation");
});

test("All repositories is surfaced and repository listing paginates past 100", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secret = new Secrets();
  secret.set("app-id", "123");
  secret.set("pem", privateKey.export({ type: "pkcs1", format: "pem" }).toString());
  const repositoryCalls = [];
  const repos = Array.from({ length: 102 }, (_, index) => ({
    id: index + 1,
    full_name: `acme/repo-${index + 1}`,
    name: `repo-${index + 1}`,
    owner: { login: "acme" },
    private: true,
  }));
  const api = { async request(method, path) {
    if (method === "GET" && path === "/app/installations") {
      return {
        status: 200,
        body: [{
          id: 42,
          repository_selection: "all",
          account: { login: "acme", type: "Organization" },
        }],
      };
    }
    if (method === "POST" && path.includes("access_tokens")) {
      return { status: 201, body: { token: "LIST_ALL", expires_at: "2030-01-01T00:00:00Z" } };
    }
    if (method === "GET" && path.startsWith("/installation/repositories")) {
      repositoryCalls.push(path);
      const page = Number(new URL(`https://api.github.test${path}`).searchParams.get("page"));
      return {
        status: 200,
        body: { total_count: repos.length, repositories: page === 1 ? repos.slice(0, 100) : repos.slice(100) },
      };
    }
    if (method === "DELETE") return { status: 204, body: {} };
    return { status: 404, body: {} };
  } };

  const [installation] = await new GitHubAppService(api, secret).installations();
  assert.equal(installation.repositorySelection, "all");
  assert.equal(installation.repositories.length, 102);
  assert.deepEqual(repositoryCalls, [
    "/installation/repositories?per_page=100&page=1",
    "/installation/repositories?per_page=100&page=2",
  ]);
});

test("a truncated PEM is not reported as connected and produces an actionable error", async () => {
  const secret = new Secrets();
  secret.set("app-id", "123");
  secret.set("pem", "-----BEGIN RSA PRIVATE KEY-----\ntruncated");
  const service = new GitHubAppService({ async request() {
    throw new Error("the API must not be called with an invalid key");
  } }, secret);

  assert.equal(service.connected(), false);
  await assert.rejects(() => service.installations(), /key is incomplete.*Connect GitHub again/);
});

test("installations() surfaces a listing failure instead of reporting zero repos", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secret = new Secrets();
  secret.set("app-id", "123");
  secret.set("pem", privateKey.export({ type: "pkcs1", format: "pem" }).toString());
  const api = { async request(method, path) {
    if (method === "GET" && path === "/app/installations") return { status: 200, body: [{ id: 42, account: { login: "acme" } }] };
    if (method === "POST" && path.includes("access_tokens")) return { status: 201, body: { token: "T" } };
    if (method === "GET" && path.startsWith("/installation/repositories")) return { status: 403, body: {} };
    if (method === "DELETE") return { status: 204, body: {} };
    return { status: 404, body: {} };
  } };
  await assert.rejects(
    () => new GitHubAppService(api, secret).installations(),
    /Could not read repositories/,
    "a 403 must not be reported as an empty repository list",
  );
});

test("disconnect revokes remembered tokens before deleting the App key", async () => {
  const secret = new Secrets();
  secret.set("app-id", "123");
  secret.set("pem", "PRIVATE");
  secret.set("tokens", JSON.stringify([{
    token: "REMEMBERED",
    projectName: "Demo",
    repository: "acme/app",
    scope: "write",
    purpose: "git",
  }]));
  const observed = [];
  const api = { async request(method, path, body, headers) {
    observed.push({
      method,
      path,
      auth: headers?.authorization,
      pemPresent: Boolean(secret.get("pem")),
    });
    return { status: 204, body: {} };
  } };
  const result = await new GitHubAppService(api, secret).disconnect();
  assert.deepEqual(result, { pendingRevocations: 0 });
  assert.equal(observed[0].auth, "token REMEMBERED");
  assert.equal(observed[0].pemPresent, true, "revocation must precede deleting connection material");
  assert.equal(secret.get("pem"), undefined);
  assert.equal(secret.get("app-id"), undefined);
  assert.equal(secret.get("tokens"), undefined);
});

test("disconnect retains failed revocations for the next startup sweep", async () => {
  const secret = new Secrets();
  secret.set("app-id", "123");
  secret.set("pem", "PRIVATE");
  secret.set("tokens", JSON.stringify(["RETRY_ME"])); // legacy string record is migrated on read
  let offline = true;
  const api = { async request() { return { status: offline ? 503 : 204, body: {} }; } };
  const service = testService(api, secret);
  const result = await service.disconnect();
  assert.deepEqual(result, { pendingRevocations: 1 });
  assert.match(secret.get("tokens"), /RETRY_ME/);
  assert.equal(secret.get("pem"), undefined);
  offline = false;
  assert.deepEqual(await service.sweep(), { revoked: 1, pending: 0 });
  assert.equal(secret.get("tokens"), undefined, "a successful startup sweep removes the retry record");
});

test("connection namespaces isolate App keys, tokens, and disconnect", async () => {
  const secret = new Secrets();
  for (const [connectionId, appId] of [["gh-a", "101"], ["gh-b", "202"]]) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    secret.set(`github-app:${connectionId}:app-id`, appId);
    secret.set(`github-app:${connectionId}:pem`, privateKey.export({ type: "pkcs1", format: "pem" }).toString());
  }
  let sequence = 0;
  const api = { async request(method, path, body) {
    if (method === "DELETE") return { status: 204, body: {} };
    sequence += 1;
    const id = Number(body.repository_ids[0]);
    return {
      status: 201,
      body: {
        token: `TOKEN_${sequence}`,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: body.permissions,
        repositories: body.repository_ids.map((rid) => ({ id: rid })),
      },
    };
  } };
  const service = testService(api, secret);
  const a = await service.forConnection("gh-a").issue(
    "1", [{ id: 11, fullName: "acme/a", owner: "acme", name: "a" }], "read",
  );
  const b = await service.forConnection("gh-b").issue(
    "2", [{ id: 22, fullName: "other/b", owner: "other", name: "b" }], "write",
  );
  assert.equal(a.connectionId, "gh-a");
  assert.equal(b.connectionId, "gh-b");
  assert.match(secret.get("github-app:gh-a:tokens"), /TOKEN_1/);
  assert.match(secret.get("github-app:gh-b:tokens"), /TOKEN_2/);

  await service.forConnection("gh-a").disconnect();
  assert.equal(service.forConnection("gh-a").connected(), false);
  assert.equal(service.forConnection("gh-b").connected(), true);
  assert.match(secret.get("github-app:gh-b:tokens"), /TOKEN_2/,
    "disconnecting one owner must not touch another owner's token record");
});

test("an incomplete legacy Keychain pair migrates as visibly disconnected", () => {
  const secret = new Secrets();
  secret.set("app-id", "123");
  const scoped = new GitHubAppService({ async request() { return { status: 503, body: {} }; } }, secret)
    .forConnection("gh-123");
  assert.equal(scoped.migrateLegacySecrets(), true,
    "public metadata may migrate even though an incomplete secret cannot");
  assert.equal(scoped.connected(), false);
  assert.equal(secret.get("app-id"), undefined, "the unusable half-pair must not remain hidden");
});

/**
 * Hand-off regression (2026-07-26): the renderer submitted a POST form with
 * target=_blank. Electron forwards new windows to the OS browser as a **URL only**,
 * so the body was dropped and GitHub showed an empty "Create GitHub App" form —
 * the user had to fill everything by hand. The browser must perform the POST
 * itself, from a page Bumper serves.
 */
test("manifest asks for no webhook deliveries", () => {
  const manifest = githubAppManifest("http://127.0.0.1:7777/github/manifest/callback");
  assert.equal("hook_attributes" in manifest, false,
    "including a hook makes its public URL mandatory even when active is false");
  assert.equal("default_events" in manifest, false, "Bumper subscribes to no webhook events");
  assert.equal(manifest.public, false);
  assert.equal(manifest.redirect_url, "http://127.0.0.1:7777/github/manifest/callback");
});

/**
 * GitHub validates redirect_url and answers "redirect_url must be a valid URL"
 * when it carries a query string — reproduced in a browser against loopback and
 * against a public https host alike, while GitHub's documented example (no query)
 * passes. So the state must ride on the POST target instead. A domain does not
 * fix this; only the URL shape does.
 */
test("no manifest URL carries a query string", () => {
  const manifest = githubAppManifest("http://127.0.0.1:7777/github/manifest/callback");
  for (const [field, value] of [["redirect_url", manifest.redirect_url], ["url", manifest.url]]) {
    assert.doesNotMatch(String(value), /\?/, `${field} must not carry a query string`);
  }
});

test("manifest completion stays on a close-this-tab page while the Mac app refreshes", async () => {
  const { githubManifestCompletePage } = await import("../dist/app.js");
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const page = githubManifestCompletePage();
  assert.match(page, /GitHub connected/);
  assert.match(page, /Return to the Bumper Mac app/);
  assert.doesNotMatch(page, /location\.replace|github=connected|#\/projects/,
    "the external browser must not become a second Bumper SPA");

  const renderer = readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
  assert.match(renderer, /githubApps:\s*nextState\.githubApps/,
    "a completed connection must invalidate the renderer fingerprint");
  assert.match(renderer, /addEventListener\("focus",\s*async\s*\(\)\s*=>/,
    "returning to the Mac app must refresh connection state immediately");
  assert.match(renderer, /repositorySelection === "all"/,
    "Library must distinguish All repositories from Only selected");
  assert.match(renderer, /githubRefreshBusy/,
    "Refresh must expose an in-progress state instead of appearing inert");
});

test("connect returns a Bumper hand-off URL that POSTs the manifest to GitHub", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startApp } = await import("../dist/app.js");
  const { loadConfig } = await import("../dist/config.js");

  const dir = mkdtempSync(join(tmpdir(), "gh-handoff-"));
  const workspace = join(dir, "ws");
  mkdirSync(workspace, { recursive: true });
  const configPath = join(dir, "bumper.config.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    githubApp: {
      appId: 123,
      slug: "bumper-test",
      ownerLogin: "acme",
      installations: [{
        id: 42,
        accountLogin: "acme",
        accountType: "Organization",
        repositorySelection: "selected",
        repositories: [{ id: 7, fullName: "acme/alpha", private: true }],
      }],
    },
    contexts: {
      Demo: {
        description: "", workspace, mode: "read-write",
        room: {
          enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked",
          workspaceShare: "whole", shareSubpaths: [], shareEntries: [], doors: [],
        },
      },
    },
    defaultContext: "Demo",
  }));
  const prevConfig = process.env.BUMPER_CONFIG;
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = join(dir, "state.json");
  const { config } = loadConfig();
  // Never let a test server sweep or inspect the user's real macOS Keychain.
  const testSecrets = new Secrets();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  testSecrets.set("app-id", "123");
  testSecrets.set("pem", privateKey.export({ type: "pkcs1", format: "pem" }).toString());
  const testGitHub = new GitHubAppService({
    async request() { return { status: 204, body: {} }; },
  }, testSecrets);
  const handle = await startApp(
    config,
    () => loadConfig().config,
    join(process.cwd(), "dist", "cli.js"),
    { githubAppService: testGitHub },
  );
  const migrated = loadConfig().config;
  assert.equal(migrated.githubApp, undefined, "the singular config must migrate once");
  assert.equal(migrated.githubApps["gh-123"]?.ownerLogin, "acme");
  assert.equal(testSecrets.get("pem"), undefined, "the legacy Keychain name must be removed");
  assert.ok(testSecrets.get("github-app:gh-123:pem"), "the PEM must move into its connection namespace");
  t.after(async () => {
    await handle.close();
    if (prevConfig === undefined) delete process.env.BUMPER_CONFIG; else process.env.BUMPER_CONFIG = prevConfig;
    if (prevState === undefined) delete process.env.BUMPER_STATE; else process.env.BUMPER_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  });

  const saved = await fetch(`${handle.url}/api/contexts`, {
    method: "PUT",
    headers: { origin: handle.url, "content-type": "application/json" },
    body: JSON.stringify({
      previous: "Demo",
      name: "Demo",
      description: "",
      workspace,
      mode: "read-write",
      inheritMode: true,
      room: {
        enabled: true,
        image: "docker.io/library/alpine:3.20",
        egress: "blocked",
        workspaceShare: "whole",
        shareSubpaths: [],
        doors: [],
      },
      gitRepository: "acme/alpha",
      gitProviderConnectionId: "gh-123",
      gitInstallationId: 42,
      gitRepositoryId: 7,
      gitAccess: "read",
    }),
  });
  assert.equal(saved.status, 200);
  const savedState = await (await fetch(`${handle.url}/api/state`)).json();
  assert.equal(savedState.contexts.Demo.gitRepository, "acme/alpha");
  assert.equal(savedState.contexts.Demo.gitAccess, "read",
    "Project → Git must persist the provider scope, not only redraw the form");
  const intent = await (await fetch(`${handle.url}/api/github/repository-intent`, {
    method: "POST",
    headers: { origin: handle.url, "content-type": "application/json" },
    body: JSON.stringify({ context: "Demo", repository: "https://github.com/acme/alpha.git" }),
  })).json();
  assert.equal(intent.status, "bound");
  assert.equal(intent.selected.connectionId, "gh-123");
  assert.equal(intent.selected.repositoryId, 7);

  const connectedReplacement = await fetch(`${handle.url}/api/github/connect`, {
    method: "POST",
    headers: { origin: handle.url, "content-type": "application/json" },
    body: JSON.stringify({
      accountType: "organization",
      organization: "acme",
      replaceConnectionId: "gh-123",
    }),
  });
  assert.equal(connectedReplacement.status, 409,
    "Reconnect must not overwrite a connection whose Keychain key is usable");

  const writeWindow = await (await fetch(`${handle.url}/api/github/write-window`, {
    method: "POST",
    headers: { origin: handle.url, "content-type": "application/json" },
    body: JSON.stringify({ context: "Demo" }),
  })).json();
  assert.ok(Date.parse(writeWindow.until) > Date.now());
  const elevated = await (await fetch(`${handle.url}/api/state`)).json();
  assert.equal(elevated.contexts.Demo.gitWriteUntil, writeWindow.until);
  const ended = await fetch(`${handle.url}/api/github/write-window`, {
    method: "DELETE",
    headers: { origin: handle.url, "content-type": "application/json" },
    body: JSON.stringify({ context: "Demo" }),
  });
  assert.equal(ended.status, 200);
  const lowered = await (await fetch(`${handle.url}/api/state`)).json();
  assert.equal(lowered.contexts.Demo.gitWriteUntil, "");

  const started = await (await fetch(`${handle.url}/api/github/connect`, {
    method: "POST", headers: { origin: handle.url },
  })).json();
  assert.match(started.startUrl ?? "", /\/github\/manifest\/start\?state=/, "connect must return a hand-off URL");
  assert.equal(started.manifest, undefined, "the renderer must not be asked to POST the manifest itself");
  // Electron only forwards a new window to the browser when it is https or Bumper's
  // own origin (see windowOpenAction). A hand-off on any other origin opens nowhere.
  const { windowOpenAction } = await import("../dist/electron-links.js");
  assert.equal(new URL(started.startUrl).origin, new URL(handle.url).origin,
    "the hand-off must live on the app's own origin");
  assert.deepEqual(windowOpenAction(started.startUrl, new URL(handle.url).origin), { kind: "external" },
    "Electron must actually forward this URL to the browser");

  const page = await (await fetch(started.startUrl)).text();
  assert.match(page, /method="POST" action="https:\/\/github\.com\/settings\/apps\/new\?state=/, "the state must ride on the POST target");
  const manifest = JSON.parse(
    /name="manifest" value="([^"]*)"/.exec(page)[1]
      .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
  );
  assert.doesNotMatch(manifest.redirect_url, /\?/, "GitHub rejects a redirect_url with a query string");
  assert.equal(new URL(manifest.redirect_url).pathname, "/github/manifest/callback");
  assert.equal("hook_attributes" in manifest, false,
    "the real hand-off must not send a loopback webhook URL");
  assert.equal("default_events" in manifest, false,
    "the real hand-off must not subscribe to webhook events");
  assert.match(page, /name="manifest"/, "the manifest must travel in the POST body");
  assert.match(page, /contents&quot;:&quot;write/, "permissions must be pre-filled");
  assert.match(page, /Bumper Git access [a-f0-9-]{8}/i,
    "each local App needs a collision-resistant pre-filled GitHub name");
  assert.match(page, /submit\(\)/, "it must submit without the user filling anything");

  // Single use: a replayed link must not silently create a second App.
  const replay = await fetch(started.startUrl);
  assert.equal(replay.status, 400, "the hand-off link must not be reusable");

  const organization = await (await fetch(`${handle.url}/api/github/connect`, {
    method: "POST",
    headers: { origin: handle.url, "content-type": "application/json" },
    body: JSON.stringify({
      accountType: "organization",
      organization: "https://github.com/crostra/bumper",
    }),
  })).json();
  const organizationPage = await (await fetch(organization.startUrl)).text();
  assert.match(
    organizationPage,
    /action="https:\/\/github\.com\/organizations\/crostra\/settings\/apps\/new\?state=/,
    "organization repositories need a private App created under that organization",
  );
});
