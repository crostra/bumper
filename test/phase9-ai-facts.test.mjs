/**
 * Phase 9-6 F1/F2: Project AI fact rows are in-use instances only.
 * Asserts exact row counts (A8) — not merely "not equal to catalog size".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectAiFactRows } from "../dist/room/ai-facts.js";

const CATALOG = [
  { id: "claude", shortName: "Claude", roomCommand: ["claude"] },
  { id: "codex", shortName: "Codex", roomCommand: ["codex"] },
  { id: "cursor", shortName: "Cursor", roomCommand: ["cursor-agent"] },
  { id: "grok", shortName: "Grok", roomCommand: ["grok"] },
  { id: "antigravity", shortName: "Antigravity", roomCommand: ["agy"] },
];

test("projectAiFactRows: empty project → 0 rows (not catalog of 5)", () => {
  const rows = projectAiFactRows({ loginProfiles: {} }, CATALOG.map((a) => ({ ...a, signedIn: false })));
  assert.equal(rows.length, 0);
  assert.notEqual(rows.length, CATALOG.length);
});

test("projectAiFactRows: one named bind → exactly 1 fact row", () => {
  const agents = CATALOG.map((a) => ({ ...a, signedIn: false }));
  const rows = projectAiFactRows({ loginProfiles: { claude: "client-a" } }, agents);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, "claude");
  assert.equal(rows[0].accountLabelKey, "named");
  assert.equal(rows[0].accountLabel, "client-a");
  assert.equal(rows[0].shortName, "Claude");
});

test("projectAiFactRows: default bind labels as Existing login key", () => {
  const agents = CATALOG.map((a) => ({ ...a, signedIn: a.id === "codex" }));
  const rows = projectAiFactRows({ loginProfiles: { codex: "default" } }, agents);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountId, "default");
  assert.equal(rows[0].accountLabelKey, "existing");
  assert.equal(rows[0].accountLabel, "Existing login");
});

test("projectAiFactRows: shared default login via signedIn without bind", () => {
  const agents = CATALOG.map((a) => ({
    ...a,
    signedIn: a.id === "cursor",
  }));
  const rows = projectAiFactRows({ loginProfiles: {} }, agents);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, "cursor");
  assert.equal(rows[0].accountLabel, "Existing login");
});

test("projectAiFactRows: two binds + one persisted only → exactly 3", () => {
  const agents = CATALOG.map((a) => ({
    ...a,
    signedIn: a.id === "grok",
  }));
  const rows = projectAiFactRows(
    { loginProfiles: { claude: "work", codex: "personal" } },
    agents,
  );
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.agentId).sort(), ["claude", "codex", "grok"]);
});

test("renderProjectAi does not map the full roomAgents catalog (A8 static)", () => {
  const appJs = readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
  const start = appJs.indexOf("function renderProjectAi(");
  assert.ok(start > 0);
  const next = appJs.indexOf("\n  function ", start + 1);
  const body = appJs.slice(start, next === -1 ? appJs.length : next);
  // Must filter in-use, not roomAgents.map entire catalog.
  assert.doesNotMatch(body, /roomAgents\.map\(/);
  // Per-Project login state comes from toolSignedInForProject, never the cached
  // agents list (which belongs to whichever Project was fetched last).
  assert.match(body, /toolSignedInForProject\(project, a\.id\)/);
  assert.match(body, /loginProfiles/);
  assert.match(body, /aiAccountDisplayLabel/);
  // Shared helper maps default → Existing login locale key (F2/A9).
  assert.match(appJs, /function aiAccountDisplayLabel[\s\S]*?account_existing/);
  // No English hardcodes for the three F6 strings.
  assert.doesNotMatch(body, /Approval prompts:/);
  assert.doesNotMatch(body, />Tool default</);
  assert.doesNotMatch(body, />Skip approval prompts</);
  assert.match(body, /project\.ai\.approval_prompts/);
  assert.match(body, /project\.ai\.tool_default/);
  assert.match(body, /project\.ai\.skip_approval/);
});

test("renderPermissionLedger never prints raw default profile id (F2/A9)", () => {
  const appJs = readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
  const start = appJs.indexOf("function renderPermissionLedger(");
  assert.ok(start > 0);
  const next = appJs.indexOf("\n  function ", start + 1);
  const body = appJs.slice(start, next === -1 ? appJs.length : next);
  assert.doesNotMatch(body, /· \$\{profile\}/);
  assert.doesNotMatch(body, /\|\| "default"/);
  assert.match(body, /aiAccountDisplayLabel/);
  assert.match(appJs, /function aiAccountDisplayLabel[\s\S]*?account_existing/);
  // In-use filter, not agent.detected catalog dump.
  assert.doesNotMatch(body, /agent\.detected/);
  assert.match(body, /signedIn/);
});

/**
 * Regression (2026-07-25 review): the helper was correct but its *input* was not.
 *
 * `/api/agents` fed `signedIn` from the loose `signedIn()` check,
 * which counts directory entries — and `roomAuthDoors` mkdirs those trees itself.
 * Result: Project → AI tools and the Overview ledger claimed "Existing login" for
 * all five catalog tools, including ones that were never signed in.
 *
 * Asserting the pure helper is not enough; this drives the real endpoint.
 */
test("GET /api/agents: an auth tree of only empty dirs is not a login", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { startApp } = await import("../dist/app.js");
  const { loadConfig } = await import("../dist/config.js");

  const dir = mkdtempSync(join(tmpdir(), "p9-agents-"));
  const workspace = join(dir, "ws");
  mkdirSync(workspace, { recursive: true });

  // claude: a real credential file → is a login.
  mkdirSync(join(dir, "room-auth", "claude", "root_claude"), { recursive: true });
  writeFileSync(join(dir, "room-auth", "claude", "root_claude", ".credentials.json"), "{}");
  // antigravity / codex / cursor: only directories, zero files — what a single
  // launch or probe leaves behind. Must NOT read as a login.
  mkdirSync(join(dir, "room-auth", "antigravity", "root_gemini", "antigravity-cli", "conversations"), { recursive: true });
  mkdirSync(join(dir, "room-auth", "codex", "root_codex", "sessions"), { recursive: true });
  mkdirSync(join(dir, "room-auth", "cursor", "root_config_cursor"), { recursive: true });

  const configPath = join(dir, "bumper.config.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    contexts: {
      Demo: {
        description: "", workspace, mode: "read-write", loginProfiles: {},
        room: {
          enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked",
          workspaceShare: "whole", shareSubpaths: [], shareEntries: [], doors: [],
        },
      },
    },
    defaultContext: "Demo",
    authProfiles: ["default"],
  }));

  const prevConfig = process.env.BUMPER_CONFIG;
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = join(dir, "state.json");
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

  const agents = await (await fetch(`${handle.url}/api/agents`)).json();
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));

  assert.equal(byId.claude?.signedIn, true, "real credential file is a login");
  for (const id of ["antigravity", "codex", "cursor"]) {
    assert.equal(byId[id]?.signedIn, false, `${id}: empty dirs must not be a login`);
    assert.equal(byId[id]?.authStatus, "needs-signin", `${id}: status must be needs-signin`);
  }

  // What the UI would actually draw from this payload.
  const rows = projectAiFactRows({ loginProfiles: {} }, agents);
  assert.deepEqual(rows.map((r) => r.agentId), ["claude"], "only the signed-in tool is a fact row");
  assert.notEqual(rows.length, agents.filter((a) => a.roomCommand?.length).length);
});
