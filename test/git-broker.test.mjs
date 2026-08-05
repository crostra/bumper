import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RoomGitBroker, gitCredentialHelperScript, roomGitCredentialEnv, ROOM_GIT_CONTEXT,
} from "../dist/git-broker.js";

/** One Project binding `acme/alpha` at `capability`, plus optional extra repos. */
function fixture(capability = "read", extra = []) {
  const root = mkdtempSync(join(tmpdir(), "bumper-git-broker-"));
  let calls = 0;
  const issued = [];
  const events = [];
  const repositories = capability === "none"
    ? extra
    : [{ repository: "acme/alpha", capability }, ...extra];
  const broker = new RoomGitBroker(root, {
    repositories, host: "github.com",
  }, {
    async issue(request) {
      calls++;
      issued.push({ ...request });
      return {
        token: `TOKEN_${request.repository}_${request.capability}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        scope: request.capability === "read" ? "read" : "write",
        capability: request.capability,
      };
    },
  }, (event) => events.push(event));
  const { door } = broker.setup();
  return { root, broker, door, issued, events, calls: () => calls };
}

async function request(f, value, stem = "probe") {
  writeFileSync(join(f.root, "queue", `${stem}.req`), JSON.stringify(value));
  await f.broker.drain();
  const res = join(f.root, "queue", `${stem}.res`);
  return existsSync(res) ? readFileSync(res, "utf8") : "";
}

test("git broker scopes only from Project policy and rejects forged request repo", async (t) => {
  const f = fixture("read");
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  // Positive control: accepted request causes a token with the Project policy.
  const ok = await request(f, { protocol: "https", host: "github.com", path: "acme/alpha.git" });
  assert.match(ok, /TOKEN_acme\/alpha_read/);
  assert.deepEqual(f.issued, [{ repository: "acme/alpha", capability: "read" }]);
  // Forging another repo must not receive a broader/different token.
  const forged = await request(f, { protocol: "https", host: "github.com", path: "other/private" }, "forged");
  assert.match(forged, /quit=1/);
  assert.equal(f.calls(), 1);
  assert.ok(f.events.some((e) => e.reason === "repository is not bound to this Project"));
});

/**
 * A Project spanning several repositories must hand each one only its own
 * token: an installation token carries a single permission set, so a shared
 * token would be too wide for whichever repository is bound lower.
 */
test("each bound repository gets its own token at its own rung", async (t) => {
  const f = fixture("read", [
    { repository: "acme/infra", capability: "workflow" },
    { repository: "acme/docs", capability: "none" },
  ]);
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  assert.match(
    await request(f, { protocol: "https", host: "github.com", path: "acme/alpha" }, "a"),
    /TOKEN_acme\/alpha_read/,
  );
  assert.match(
    await request(f, { protocol: "https", host: "github.com", path: "acme/infra" }, "b"),
    /TOKEN_acme\/infra_workflow/,
  );
  // Bound at "none" is the absence of access, not a weaker access.
  assert.match(
    await request(f, { protocol: "https", host: "github.com", path: "acme/docs" }, "c"),
    /quit=1/,
  );
  assert.deepEqual(f.issued, [
    { repository: "acme/alpha", capability: "read" },
    { repository: "acme/infra", capability: "workflow" },
  ]);
});

test("a Project binding nothing does not issue a token (positive control above)", async (t) => {
  const f = fixture("none");
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  assert.match(await request(f, { protocol: "https", host: "github.com", path: "acme/alpha" }), /quit=1/);
  assert.equal(f.calls(), 0);
  assert.ok(f.events.some((e) => e.reason === "this Project binds no repository"));
});

test("temporary write expiry revokes the write token and falls back to read in the same Sandbox", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-git-window-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let policy = {
    repositories: [{ repository: "acme/alpha", capability: "read" }],
    host: "github.com",
    writeUntil: new Date(Date.now() + 60_000).toISOString(),
  };
  const issued = [];
  const revoked = [];
  const events = [];
  const broker = new RoomGitBroker(root, () => policy, {
    async issue(current) {
      issued.push(current.capability);
      return {
        token: `TOKEN_${current.capability}`,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        scope: current.capability === "read" ? "read" : "write",
        capability: current.capability,
      };
    },
    async revoke(token) { revoked.push(token.token); },
  }, (event) => events.push(event));
  broker.setup();
  broker.start(60_000);
  t.after(() => broker.stop());

  assert.equal(broker.access, "write", "the active window elevates the effective provider scope");
  assert.match(
    await request({ root, broker }, { protocol: "https", host: "github.com", path: "acme/alpha" }, "write"),
    /TOKEN_write/,
  );

  policy = { ...policy, writeUntil: new Date(Date.now() - 1).toISOString() };
  await broker.drain();
  assert.equal(broker.access, "read");
  assert.deepEqual(revoked, ["TOKEN_write"], "expiry must actively revoke, not only wait one hour");
  assert.ok(events.some((event) => event.target === "Temporary Git write access ended"));

  assert.match(
    await request({ root, broker }, { protocol: "https", host: "github.com", path: "acme/alpha" }, "read"),
    /TOKEN_read/,
  );
  assert.deepEqual(issued, ["write", "read"]);
});

test("stop is idempotent and revokes a cached token once", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-git-stop-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let revocations = 0;
  const broker = new RoomGitBroker(root, {
    repositories: [{ repository: "acme/alpha", capability: "read" }], host: "github.com",
  }, {
    async issue() {
      return { token: "ONCE", expiresAt: new Date(Date.now() + 60_000).toISOString(), scope: "read" };
    },
    async revoke() { revocations += 1; },
  });
  broker.setup();
  await request({ root, broker }, { protocol: "https", host: "github.com", path: "acme/alpha" });
  await Promise.all([broker.stop(), broker.stop()]);
  assert.equal(revocations, 1);
});

test("untrusted queue symlinks cannot make the host overwrite another file", async (t) => {
  const f = fixture("read");
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const target = join(f.root, "host-target");
  writeFileSync(target, "UNCHANGED");
  symlinkSync(target, join(f.root, "queue", "probe.res.tmp"));
  const response = await request(
    f,
    { protocol: "https", host: "github.com", path: "acme/alpha" },
  );
  assert.equal(response, "", "a pre-planted response path must fail closed");
  assert.equal(readFileSync(target, "utf8"), "UNCHANGED");
});

test("Sandbox helper transports credential fields only and Git uses HTTP path", () => {
  const script = gitCredentialHelperScript();
  assert.match(script, /case "\$key".*protocol.*host.*path/s);
  assert.doesNotMatch(script, /argv|clone|push|--upload-pack/i);
  assert.deepEqual(roomGitCredentialEnv(), {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "/bumper-git/git-credential-bumper",
    GIT_CONFIG_KEY_1: "credential.useHttpPath",
    GIT_CONFIG_VALUE_1: "true",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    BUMPER_GIT_CONTEXT: ROOM_GIT_CONTEXT,
  });
});

test("Sandbox gets non-secret Git context and denied credentials stop prompting", async (t) => {
  const f = fixture("read");
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const context = JSON.parse(readFileSync(join(f.root, "context.json"), "utf8"));
  assert.equal(context.provider, "github");
  // Singular mirror stays for older in-room readers.
  assert.equal(context.repository, "acme/alpha");
  assert.equal(context.access, "read");
  assert.equal(context.httpsUrl, "https://github.com/acme/alpha");
  assert.deepEqual(context.repositories, [{
    repository: "acme/alpha",
    capability: "read",
    access: "read",
    can: "Read only",
    httpsUrl: "https://github.com/acme/alpha",
    cloneUrl: "https://github.com/acme/alpha.git",
  }]);
  assert.match(context.instruction, /not listed is unreachable/);
  assert.doesNotMatch(JSON.stringify(context), /token.*[=:]\s*gh|private key/i);
  const denied = await request(f, { protocol: "https", host: "github.com", path: "acme/other" });
  assert.match(denied, /quit=1/, "Git must not fall back to a username or PAT prompt");
});

/**
 * F1 regression (2026-07-26 review): the broker was wired into SessionManager only.
 * SessionManager has no entry point — `bumper <cli>` is the path users run — so the
 * whole feature was unreachable and every unit test still passed.
 *
 * Behaviour first, then a convergence check that both launch paths compose through
 * the one function. A source-level check alone would be A3; a unit test alone would
 * not have caught F1.
 */
test("withGitBroker attaches the door and the fixed git config env", async () => {
  const { withGitBroker, roomGitCredentialEnv, ROOM_GIT_MOUNT } = await import("../dist/git-broker.js");
  const base = {
    image: "img", doors: [{ hostPath: "/h/ws", roomPath: "/workspace", access: "read-write" }],
    egress: { mode: "blocked" }, env: { EXISTING: "1" },
  };
  const door = { hostPath: "/h/git", roomPath: ROOM_GIT_MOUNT, access: "read-write" };
  const out = withGitBroker(base, door);

  assert.ok(out.doors.some((d) => d.roomPath === ROOM_GIT_MOUNT), "broker door must be mounted");
  assert.ok(out.doors.some((d) => d.roomPath === "/workspace"), "existing doors are kept");
  assert.equal(out.env.EXISTING, "1", "existing env is kept");
  for (const [key, value] of Object.entries(roomGitCredentialEnv())) {
    assert.equal(out.env[key], value, `${key} must reach the room`);
  }
  // useHttpPath is what lets the broker know which repo is being asked for.
  assert.ok(Object.values(out.env).includes("credential.useHttpPath"));
  assert.equal(base.doors.length, 1, "input spec is not mutated");
});

test("both launch paths compose git access through withGitBroker", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const file of ["src/cli-room.ts", "src/sessions.ts"]) {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    assert.match(src, /withGitBroker\(/, `${file} must compose git access through the shared function`);
    assert.match(src, /projectGitBroker\(/, `${file} must resolve policy through the shared resolver`);
    assert.match(src, /createGitSessionLease\(/, `${file} must register a host-side live Session lease`);
    assert.match(src, /sessionId:/, `${file} must correlate issued tokens to that Session`);
    // Scope must never be assembled locally (invariant R4).
    assert.doesNotMatch(src, /permissions:\s*\{\s*contents/, `${file} must not build a token scope itself`);
  }
});

test("projectGitBroker derives scope from Project config, never from the caller", async () => {
  const { projectGitBroker } = await import("../dist/git-broker.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "p-git-"));
  try {
    const asked = [];
    const github = {
      issue: async (connectionId, installationId, repo, scope) => {
        asked.push({ connectionId, installationId, repo: repo.fullName, name: repo.name, scope });
        return {
          token: "T",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          scope,
          connectionId,
        };
      },
      revoke: async () => {},
    };
    const installations = [{ connectionId: "gh-acme", id: 42, repositories: [{ id: 7, fullName: "acme/alpha" }] }];
    const bound = {
      gitProviderConnectionId: "gh-acme",
      gitInstallationId: 42,
      gitRepositoryId: 7,
      gitRepository: "acme/alpha",
    };

    const write = projectGitBroker({
      dir: join(dir, "w"), projectName: "P", github, installations,
      context: { ...bound, gitAccess: "write" }, onEvent: () => {},
    });
    assert.equal(write.access, "write");
    assert.equal(write.repository, "acme/alpha");

    const read = projectGitBroker({
      dir: join(dir, "r"), projectName: "P", github, installations,
      context: { ...bound, gitAccess: "read" }, onEvent: () => {},
    });
    assert.equal(read.access, "read");

    // Unknown values must fall back to none, not to something permissive.
    const bogus = projectGitBroker({
      dir: join(dir, "n"), projectName: "P", github, installations,
      context: { ...bound, gitAccess: "admin" }, onEvent: () => {},
    });
    assert.equal(bogus.access, "none", "an unrecognised access value must fail closed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * R6 / decision §6 §8: the App private key and issued tokens must never leave the
 * host. Nothing guarded this before — the absence was true but untested, so a
 * regression would have shipped silently.
 */
test("App key and issued tokens never reach /api/state, events or config", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { startApp } = await import("../dist/app.js");
  const { loadConfig } = await import("../dist/config.js");
  const { GitHubAppService, keychain } = await import("../dist/github-app.js");

  const PEM = "-----BEGIN RSA PRIVATE KEY-----\nSECRET_KEY_MARKER\n-----END RSA PRIVATE KEY-----";
  const TOKEN = "ghs_SECRET_TOKEN_MARKER";
  keychain.set("pem", PEM);
  keychain.set("app-id", "999");
  keychain.set("tokens", JSON.stringify([TOKEN]));
  t.after(() => { for (const k of ["pem", "app-id", "tokens"]) keychain.delete(k); });

  const dir = mkdtempSync(join(tmpdir(), "git-secret-"));
  const workspace = join(dir, "ws");
  mkdirSync(workspace, { recursive: true });
  const configPath = join(dir, "bumper.config.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    contexts: {
      Demo: {
        description: "", workspace, mode: "read-write", gitAccess: "read", gitRepository: "acme/alpha",
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
  const hermeticGitHub = new GitHubAppService({
    async request() { return { status: 503, body: {} }; },
  }, keychain);
  const handle = await startApp(
    config,
    () => loadConfig().config,
    join(process.cwd(), "dist", "cli.js"),
    { githubAppService: hermeticGitHub },
  );
  t.after(async () => {
    await handle.close();
    if (prevConfig === undefined) delete process.env.BUMPER_CONFIG; else process.env.BUMPER_CONFIG = prevConfig;
    if (prevState === undefined) delete process.env.BUMPER_STATE; else process.env.BUMPER_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  });

  // Positive control: the secrets really are in the store this process reads.
  assert.equal(keychain.get("pem"), PEM, "fixture must actually be stored");
  assert.match(keychain.get("tokens"), /SECRET_TOKEN_MARKER/);

  for (const path of ["/api/state", "/api/events/export", "/api/agents"]) {
    const body = await (await fetch(`${handle.url}${path}`)).text();
    assert.doesNotMatch(body, /SECRET_KEY_MARKER/, `${path} leaked the App private key`);
    assert.doesNotMatch(body, /SECRET_TOKEN_MARKER/, `${path} leaked an installation token`);
    assert.doesNotMatch(body, /BEGIN RSA PRIVATE KEY/, `${path} leaked key material`);
  }

  // The Project's git settings are public metadata and should be visible.
  const state = await (await fetch(`${handle.url}/api/state`)).json();
  assert.equal(state.contexts?.Demo?.gitAccess, "read");
  assert.equal(state.contexts?.Demo?.gitRepository, "acme/alpha");

  const onDisk = readFileSync(configPath, "utf8");
  assert.doesNotMatch(onDisk, /SECRET_KEY_MARKER|SECRET_TOKEN_MARKER/, "config must not hold secrets");
});
