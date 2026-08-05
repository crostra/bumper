/** CLI guidance: scan-first status, layered help, and actionable failures. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { applyCreatedProject } from "../dist/project.js";

const CLI = join(process.cwd(), "dist", "cli.js");

function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    ...options,
    env: {
      ...process.env,
      BUMPER_NO_CONTAINER_AUTOSTART: "1",
      ...options.env,
    },
  });
}

test("default help is short and layered; detailed and topic help stay discoverable", () => {
  const brief = run(["help"]);
  assert.equal(brief.status, 0, brief.stderr);
  assert.ok(brief.stdout.trim().split("\n").length <= 40, "default help should fit in one terminal screen");
  assert.match(brief.stdout, /Quick start/);
  assert.match(brief.stdout, /bumper status.*boundary, runtime, Sessions, and next action/);
  assert.match(brief.stdout, /bumper help all/);
  assert.doesNotMatch(brief.stdout, /bumper hook/);

  const all = run(["help", "all"]);
  assert.equal(all.status, 0, all.stderr);
  assert.ok(all.stdout.length > brief.stdout.length);
  assert.match(all.stdout, /bumper room-image build/);
  assert.match(all.stdout, /bumper mcp client-config/);
  assert.match(all.stdout, /bumper quickstart/);
  assert.match(all.stdout, /bumper support/);

  const topic = run(["status", "--help"]);
  assert.equal(topic.status, 0, topic.stderr);
  assert.match(topic.stdout, /fast answer/);
  assert.match(topic.stdout, /configured.*not a launch proof/s);
  assert.match(topic.stdout, /--verbose/);
  assert.match(topic.stdout, /--json/);

  const quickstart = run(["quickstart", "--help"]);
  assert.equal(quickstart.status, 0, quickstart.stderr);
  assert.match(quickstart.stdout, /Allowed-only network access/);
  assert.match(quickstart.stdout, /--plan/);

  const support = run(["support", "--help"]);
  assert.equal(support.status, 0, support.stderr);
  assert.match(support.stdout, /does not.*upload/s);
});

test("fresh status explains what happened and gives the next two commands", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-guidance-fresh-"));
  try {
    const result = run(["status"], {
      cwd: root,
      env: {
        BUMPER_CONFIG: join(root, "missing.json"),
        BUMPER_STATE: join(root, "state.json"),
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No config found/);
    assert.match(result.stderr, /Next:/);
    assert.match(result.stderr, /bumper init.*create a Project/s);
    assert.match(result.stderr, /bumper doctor.*check the rest/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status JSON is parseable, structured, and contains no credential values", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-guidance-json-"));
  try {
    const config = { contexts: {}, defaultContext: undefined };
    applyCreatedProject(config, { name: "Demo", workspace: root });
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const result = run(["status", "--json"], {
      cwd: root,
      env: {
        BUMPER_CONFIG: configPath,
        BUMPER_STATE: join(root, "state.json"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.snapshot.projectName, "Demo");
    assert.match(payload.overall, /configured|needs-attention/);
    assert.ok(Array.isArray(payload.sessions));
    assert.ok(Array.isArray(payload.issues));
    assert.doesNotMatch(result.stdout, /"token"\s*:|"credential"\s*:/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown commands stay concise and point back to help and status", () => {
  const result = run(["statsu"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown command "statsu"/);
  assert.match(result.stderr, /bumper help/);
  assert.match(result.stderr, /bumper status/);
  assert.ok(result.stderr.length < 500, "a typo should not dump the full command catalog");

  const version = run(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});
