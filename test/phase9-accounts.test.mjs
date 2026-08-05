/**
 * Phase 9-3 account model — pure helpers + ensure launch binding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function withState(fn) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "bumper-p9-acct-"));
    const prev = process.env.BUMPER_STATE;
    process.env.BUMPER_STATE = join(root, "state.json");
    try {
      await fn(root);
    } finally {
      if (prev === undefined) delete process.env.BUMPER_STATE;
      else process.env.BUMPER_STATE = prev;
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("slugAccountId + allocateAccountId never asks the user for a name", withState(async (root) => {
  const {
    slugAccountId, allocateAccountId, accountDisplayLabel,
  } = await import("../dist/room/accounts.js");
  assert.equal(slugAccountId("Client A"), "client-a");
  assert.equal(slugAccountId("default"), "project"); // reserved
  assert.equal(accountDisplayLabel("default"), "Existing login");
  assert.equal(accountDisplayLabel("client-a"), "client-a");

  const config = { contexts: {}, authProfiles: ["default"] };
  assert.equal(allocateAccountId(config, "claude", "Client A"), "client-a");

  // Collision → -2
  const { hostAuthDir } = await import("../dist/room/auth.js");
  const host = hostAuthDir("claude", "/root/.claude", "client-a");
  mkdirSync(host, { recursive: true });
  writeFileSync(join(host, ".credentials.json"), "{}");
  assert.equal(allocateAccountId(config, "claude", "Client A"), "client-a-2");
  void root;
}));

test("listAccountsForAgent derives used-by from loginProfiles only", withState(async () => {
  const { listAccountsForAgent, projectsUsingAccount, formatAccountChoiceLine, parseAccountPromptAnswer } =
    await import("../dist/room/accounts.js");
  const { hostAuthDir } = await import("../dist/room/auth.js");

  const personal = hostAuthDir("claude", "/root/.claude", "personal");
  mkdirSync(personal, { recursive: true });
  writeFileSync(join(personal, ".credentials.json"), "{}");

  const config = {
    authProfiles: ["default", "personal"],
    contexts: {
      alpha: { loginProfiles: { claude: "personal" } },
      beta: { loginProfiles: { claude: "personal" } },
      gamma: { loginProfiles: { claude: "default" } },
    },
  };
  const using = projectsUsingAccount(config, "claude", "personal");
  assert.deepEqual(using, ["alpha", "beta"]);

  const accounts = listAccountsForAgent(config, "claude");
  const personalRow = accounts.find((a) => a.id === "personal");
  assert.ok(personalRow);
  assert.equal(personalRow.signedIn, true);
  assert.equal(personalRow.projectCount, 2);
  assert.match(formatAccountChoiceLine(personalRow), /signed in · used by 2 Projects/);

  assert.deepEqual(
    parseAccountPromptAnswer("1", accounts),
    { action: "select", accountId: accounts[0].id },
  );
  assert.deepEqual(parseAccountPromptAnswer("n", accounts), { action: "new" });
  assert.deepEqual(parseAccountPromptAnswer("q", accounts), { action: "cancel" });
}));

test("ensureProjectAccountForLaunch: silent when bound, allocate when none, prompt when many", withState(async (root) => {
  const { ensureProjectAccountForLaunch } = await import("../dist/room/accounts-cli.js");
  const { hostAuthDir } = await import("../dist/room/auth.js");
  const configPath = join(root, "cfg.json");

  // Seed one signed-in account "work"
  const work = hostAuthDir("codex", "/root/.codex", "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "auth.json"), "{}");

  const config = {
    authProfiles: ["default", "work"],
    contexts: {
      p1: {
        description: "",
        backends: [],
        mode: "read-write",
        inheritMode: false,
        policies: {},
        native: { allow: [], deny: [] },
        commands: { gitRemoteWrite: "block" },
        writePaths: [],
        readPaths: [],
        denyReadPaths: [],
        denyWritePaths: [],
        gitIgnored: "visible",
        repos: [],
        allowedHosts: [],
        loginProfiles: {},
        room: { enabled: true, image: "x", egress: "open", doors: [] },
        autoApprove: false,
      },
    },
    defaultContext: "p1",
  };

  // Zero for claude → allocate from project name
  writeFileSync(configPath, JSON.stringify(config));
  const first = await ensureProjectAccountForLaunch({
    config,
    configPath,
    projectName: "p1",
    agentId: "claude",
    interactive: false,
  });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.accountId, "p1");
    assert.equal(first.created, true);
    assert.equal(config.contexts.p1.loginProfiles.claude, "p1");
  }

  // Already bound → silent
  const again = await ensureProjectAccountForLaunch({
    config,
    configPath,
    projectName: "p1",
    agentId: "claude",
    interactive: false,
  });
  assert.equal(again.ok, true);
  if (again.ok) assert.equal(again.accountId, "p1");

  // codex: unbound with existing "work" → needs interactive or --account
  const noTty = await ensureProjectAccountForLaunch({
    config,
    configPath,
    projectName: "p1",
    agentId: "codex",
    interactive: false,
  });
  assert.equal(noTty.ok, false);

  const picked = await ensureProjectAccountForLaunch({
    config,
    configPath,
    projectName: "p1",
    agentId: "codex",
    interactive: true,
    ask: async () => ({ action: "select", accountId: "work" }),
  });
  assert.equal(picked.ok, true);
  if (picked.ok) assert.equal(picked.accountId, "work");
  assert.equal(config.contexts.p1.loginProfiles.codex, "work");

  // --account rebind
  const rebound = await ensureProjectAccountForLaunch({
    config,
    configPath,
    projectName: "p1",
    agentId: "codex",
    accountFlag: "other",
    interactive: false,
  });
  assert.equal(rebound.ok, true);
  if (rebound.ok) assert.equal(rebound.accountId, "other");
  assert.equal(config.contexts.p1.loginProfiles.codex, "other");
}));
