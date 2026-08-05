import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGitSessionLease,
  effectiveLeaseAccess,
  heartbeatGitSessionLease,
  listGitSessionLeases,
  readGitSessionLease,
  removeGitSessionLease,
  updateGitSessionLease,
} from "../dist/git-session-lease.js";
import { GitHubAppService } from "../dist/github-app.js";
import { startApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { projectGitBroker } from "../dist/git-broker.js";

class Secrets {
  constructor() { this.items = new Map(); }
  get(key) { return this.items.get(key); }
  set(key, value) { this.items.set(key, value); }
  delete(key) { this.items.delete(key); }
}

function isolatedState(t) {
  const root = mkdtempSync(join(tmpdir(), "bumper-git-lease-"));
  const previous = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  t.after(() => {
    if (previous === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("a live Git Session lease changes Off, Read and temporary Write without entering the Sandbox", (t) => {
  isolatedState(t);
  const startedAt = new Date().toISOString();
  const lease = createGitSessionLease({
    id: "session-lease-1",
    pid: process.pid,
    projectName: "Demo",
    agentId: "antigravity",
    agentName: "Antigravity",
    repository: "acme/app",
    connectionId: "gh-acme",
    enabled: true,
    startedAt,
  });

  assert.equal(readGitSessionLease(lease.id, "read")?.effectiveAccess, "read");
  updateGitSessionLease(lease.id, { enabled: false });
  assert.equal(readGitSessionLease(lease.id, "read")?.effectiveAccess, "none");

  const until = new Date(Date.now() + 15 * 60_000).toISOString();
  updateGitSessionLease(lease.id, { enabled: true, writeUntil: until });
  assert.equal(readGitSessionLease(lease.id, "read")?.effectiveAccess, "write");
  assert.equal(effectiveLeaseAccess("read", { enabled: true, writeUntil: until }), "write");

  const files = listGitSessionLeases(() => "read");
  assert.equal(files.length, 1);
  assert.equal(files[0].connectionId, "gh-acme");
  assert.equal(files[0].live, true);

  removeGitSessionLease(lease.id);
  assert.equal(readGitSessionLease(lease.id, "read"), undefined);
});

test("a missed heartbeat fails the Session lease closed even while the PID still exists", (t) => {
  isolatedState(t);
  const old = new Date(Date.now() - 60_000).toISOString();
  const lease = createGitSessionLease({
    id: "session-lease-2",
    pid: process.pid,
    projectName: "Demo",
    agentId: "codex",
    agentName: "Codex",
    repository: "acme/app",
    connectionId: "gh-acme",
    enabled: true,
    startedAt: old,
  });
  heartbeatGitSessionLease(lease.id, old);

  const stale = readGitSessionLease(lease.id, "read");
  assert.equal(stale?.live, false);
  assert.equal(stale?.effectiveAccess, "read",
    "the reader reports desired access separately; the broker must require live=true");
});

test("the credential broker follows its live lease and revokes on every scope change", async (t) => {
  const root = isolatedState(t);
  const lease = createGitSessionLease({
    id: "session-broker-1",
    pid: process.pid,
    projectName: "Demo",
    agentId: "antigravity",
    agentName: "Antigravity",
    repository: "acme/app",
    connectionId: "gh-acme",
    enabled: true,
  });
  const brokerRoot = join(root, "broker");
  const issued = [];
  const revoked = [];
  const context = {
    gitAccess: "read",
    gitRepository: "acme/app",
    gitProviderConnectionId: "gh-acme",
    gitInstallationId: 42,
    gitRepositoryId: 7,
  };
  const installations = [{
    connectionId: "gh-acme",
    id: 42,
    repositories: [{ id: 7, fullName: "acme/app" }],
  }];
  const broker = projectGitBroker({
    dir: brokerRoot,
    sessionId: lease.id,
    projectName: "Demo",
    context,
    installations,
    github: {
      async issue(_connectionId, _installationId, _repo, scope) {
        issued.push(scope);
        return {
          token: `TOKEN_${scope}`,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          scope,
          connectionId: "gh-acme",
        };
      },
      async revoke(_connectionId, token) { revoked.push(token); },
    },
    onEvent() {},
  });
  broker.setup();
  t.after(() => broker.stop());

  async function credential(stem) {
    writeFileSync(join(brokerRoot, "queue", `${stem}.req`), JSON.stringify({
      protocol: "https",
      host: "github.com",
      path: "acme/app.git",
    }));
    await broker.drain();
    const response = join(brokerRoot, "queue", `${stem}.res`);
    return existsSync(response) ? readFileSync(response, "utf8") : "";
  }

  assert.match(await credential("read"), /TOKEN_read/);
  updateGitSessionLease(lease.id, { enabled: false });
  await broker.drain();
  assert.deepEqual(revoked, ["TOKEN_read"]);
  assert.match(await credential("off"), /quit=1/);

  updateGitSessionLease(lease.id, {
    enabled: true,
    writeUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  await broker.drain();
  assert.match(await credential("write"), /TOKEN_write/);
  assert.deepEqual(issued, ["read", "write"]);

  heartbeatGitSessionLease(lease.id, new Date(Date.now() - 60_000).toISOString());
  await broker.drain();
  assert.deepEqual(revoked, ["TOKEN_read", "TOKEN_write"]);
  assert.match(await credential("stale"), /quit=1/);
});

test("the app controls one live lease and revokes a lost lease by Session id", async (t) => {
  const root = isolatedState(t);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const configPath = join(root, "config.json");
  process.env.BUMPER_CONFIG = configPath;
  t.after(() => { delete process.env.BUMPER_CONFIG; });
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    contexts: {
      Demo: {
        description: "",
        workspace,
        mode: "read-write",
        gitRepository: "acme/app",
        gitProviderConnectionId: "gh-acme",
        gitInstallationId: 42,
        gitRepositoryId: 7,
        gitAccess: "read",
        room: {
          enabled: true,
          image: "docker.io/library/alpine:3.20",
          egress: "blocked",
          workspaceShare: "whole",
          shareSubpaths: [],
          shareEntries: [],
          doors: [],
        },
      },
    },
    defaultContext: "Demo",
  }));

  const secrets = new Secrets();
  const revoked = [];
  const github = new GitHubAppService({
    async request(method, path, _body, headers) {
      if (method === "DELETE" && path === "/installation/token") {
        revoked.push(headers.authorization);
        return { status: 204, body: {} };
      }
      return { status: 404, body: {} };
    },
  }, secrets, () => {});
  const handle = await startApp(
    loadConfig().config,
    () => loadConfig().config,
    join(process.cwd(), "dist", "cli.js"),
    { githubAppService: github, gitSessionMonitoring: true },
  );
  t.after(async () => handle.close());

  const active = createGitSessionLease({
    id: "session-live-api",
    pid: process.pid,
    projectName: "Demo",
    agentId: "antigravity",
    agentName: "Antigravity",
    repository: "acme/app",
    connectionId: "gh-acme",
    enabled: true,
  });
  secrets.set("github-app:gh-acme:tokens", JSON.stringify([{
    token: "LIVE_TOKEN",
    sessionId: active.id,
    projectName: "Demo",
    repository: "acme/app",
    scope: "read",
    purpose: "git",
  }]));

  const state = await (await fetch(`${handle.url}/api/state`)).json();
  assert.equal(state.gitSessions.find((session) => session.id === active.id)?.effectiveAccess, "read");
  const disabled = await (await fetch(`${handle.url}/api/github/session-access`, {
    method: "POST",
    headers: { origin: handle.url, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: active.id, action: "disable" }),
  })).json();
  assert.equal(disabled.access, "none");
  assert.equal(disabled.revoked, 1);
  assert.equal(readGitSessionLease(active.id, "read")?.control.enabled, false);
  assert.ok(revoked.includes("token LIVE_TOKEN"));

  const old = new Date(Date.now() - 60_000).toISOString();
  const lost = createGitSessionLease({
    id: "session-lost-api",
    pid: process.pid,
    projectName: "Demo",
    agentId: "codex",
    agentName: "Codex",
    repository: "acme/app",
    connectionId: "gh-acme",
    enabled: true,
    startedAt: old,
  });
  secrets.set("github-app:gh-acme:tokens", JSON.stringify([{
    token: "LOST_TOKEN",
    sessionId: lost.id,
    projectName: "Demo",
    repository: "acme/app",
    scope: "read",
    purpose: "git",
  }]));
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  assert.equal(readGitSessionLease(lost.id, "read"), undefined,
    "the app monitor must remove a lost host lease after revocation");
  assert.ok(revoked.includes("token LOST_TOKEN"));

  const events = await (await fetch(`${handle.url}/api/events/export?context=Demo&type=git`)).json();
  assert.ok(events.some((event) =>
    event.sessionId === active.id
      && event.target === "Live Git access disabled"
      && event.access === "none"));
  assert.ok(events.some((event) =>
    event.sessionId === lost.id
      && event.target === "Git Session lease expired"));
  assert.doesNotMatch(JSON.stringify(events), /LIVE_TOKEN|LOST_TOKEN/);
  removeGitSessionLease(active.id);
});
