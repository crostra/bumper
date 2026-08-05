// The hook and proxy should record enforcement events to the audit log.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(repo, "dist", "cli.js");

let dir, configPath, statePath, logPath;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "bumper-log-"));
  configPath = join(dir, "config.json");
  statePath = join(dir, "state.json");
  logPath = join(dir, "log", "events.jsonl");
  writeFileSync(configPath, JSON.stringify({
    defaultContext: "clientA",
    backends: {},
    contexts: { clientA: { backends: [], mode: "read-only" } },
  }));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function hook(payload) {
  spawnSync("node", [cli, "hook"], {
    input: JSON.stringify(payload),
    env: { ...process.env, BUMPER_CONFIG: configPath, BUMPER_STATE: statePath },
    encoding: "utf8",
  });
}

test("a blocked native action is written to the log", () => {
  hook({ tool_name: "Bash", tool_input: { command: "git push origin main" } });
  assert.ok(existsSync(logPath), "log file created");
  const events = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const blocked = events.find((e) => e.decision === "blocked" && e.surface === "native");
  assert.ok(blocked, "a blocked native event exists");
  assert.equal(blocked.context, "clientA");
  assert.match(blocked.target, /git push/);
});

test("an allowed (deferred) read is also recorded", () => {
  hook({ tool_name: "Read", tool_input: { file_path: "/x" } });
  const events = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(events.some((e) => e.decision === "allowed" && /Read/.test(e.target)));
});
