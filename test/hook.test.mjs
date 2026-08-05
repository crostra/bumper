// End-to-end test of the `bumper hook` command: pipe a Claude Code
// PreToolUse payload in, assert the deny/defer decision comes out.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(repo, "dist", "cli.js");

let dir, configPath, statePath;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "bumper-hook-"));
  configPath = join(dir, "config.json");
  statePath = join(dir, "state.json");
  writeFileSync(configPath, JSON.stringify({
    defaultContext: "clientA",
    backends: {},
    contexts: { clientA: { backends: [], mode: "read-only" } },
  }));
});

after(() => rmSync(dir, { recursive: true, force: true }));

function hook(payload) {
  const res = spawnSync("node", [cli, "hook"], {
    input: JSON.stringify(payload),
    env: { ...process.env, BUMPER_CONFIG: configPath, BUMPER_STATE: statePath },
    encoding: "utf8",
  });
  return JSON.parse(res.stdout).hookSpecificOutput.permissionDecision;
}

test("write is denied in read-only context", () => {
  assert.equal(hook({ tool_name: "Write", tool_input: { file_path: "/x", content: "y" } }), "deny");
});

test("git push is denied", () => {
  assert.equal(hook({ tool_name: "Bash", tool_input: { command: "git push origin main" } }), "deny");
});

test("read is deferred", () => {
  assert.equal(hook({ tool_name: "Read", tool_input: { file_path: "/x" } }), "defer");
});

test("git status is deferred", () => {
  assert.equal(hook({ tool_name: "Bash", tool_input: { command: "git status" } }), "defer");
});
