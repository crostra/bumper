/** First-run setup and opt-in diagnostics stay safe, predictable, and testable. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ConfigSchema } from "../dist/types.js";
import { applyCreatedProject } from "../dist/project.js";
import {
  prepareQuickstartProject,
  QUICKSTART_TEMPLATE_BY_AGENT,
} from "../dist/operations/quickstart.js";
import { buildSupportBundle, redactDiagnosticText } from "../dist/support.js";

const CLI = join(process.cwd(), "dist", "cli.js");

test("quickstart creates a cwd Project with vendor-only egress", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-quickstart-op-"));
  try {
    const config = ConfigSchema.parse({});
    const result = prepareQuickstartProject({ config, cwd: root, agentId: "codex" });
    const project = config.contexts[result.projectName];
    assert.equal(result.created, true);
    assert.equal(result.networkTemplate, QUICKSTART_TEMPLATE_BY_AGENT.codex);
    assert.equal(project.workspace, result.workspace);
    assert.equal(project.room.egress, "allowlist");
    assert.deepEqual(project.room.egressTemplates, ["openai"]);
    assert.deepEqual(project.room.egressHosts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quickstart reuses an existing Project without widening its boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-quickstart-existing-"));
  try {
    const config = ConfigSchema.parse({});
    applyCreatedProject(config, { name: "Existing", workspace: root });
    config.contexts.Existing.room.egress = "blocked";
    config.contexts.Existing.room.egressTemplates = [];
    config.contexts.Existing.room.image = "ghcr.io/acme/agents:locked";

    const result = prepareQuickstartProject({ config, cwd: root, agentId: "claude" });
    assert.equal(result.created, false);
    assert.equal(result.projectName, "Existing");
    assert.equal(result.networkChanged, false);
    assert.equal(config.contexts.Existing.room.egress, "blocked");
    assert.equal(config.contexts.Existing.room.image, "ghcr.io/acme/agents:locked");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quickstart refuses to silently enable an existing disabled Sandbox", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-quickstart-disabled-"));
  try {
    const config = ConfigSchema.parse({});
    applyCreatedProject(config, { name: "Disabled", workspace: root });
    config.contexts.Disabled.room.enabled = false;
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const before = JSON.stringify(config);
    const result = spawnSync(process.execPath, [CLI, "quickstart", "--plan"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, BUMPER_CONFIG: configPath, BUMPER_STATE: join(root, "state.json") },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /will not silently enable/);
    assert.equal(JSON.stringify(JSON.parse(readFileSync(configPath, "utf8"))), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quickstart plan works from empty state and writes nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-quickstart-plan-"));
  try {
    const configPath = join(root, "missing", "config.json");
    const result = spawnSync(process.execPath, [CLI, "quickstart", "codex", "--plan"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        BUMPER_CONFIG: configPath,
        BUMPER_STATE: join(root, "state.json"),
        BUMPER_NO_CONTAINER_AUTOSTART: "1",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /plan only/);
    assert.match(result.stdout, /would create/);
    assert.match(result.stdout, /Allowed only \(openai\)/);
    assert.match(result.stdout, /bumper -p .* codex/);
    assert.equal(existsSync(configPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("support diagnostics redact common secrets and absolute user paths", () => {
  // Assemble fixtures so repository scanners never mistake test data for a
  // committed credential, email, or real developer home path.
  const home = ["/Users", "alice"].join("/");
  const cwd = `${home}/secret-client`;
  const fakeEmail = ["alice", "example.com"].join("@");
  const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
  const report = {
    ready: false,
    blocked: [],
    configPath: `${home}/.bumper/config.json`,
    checks: [{
      id: "container",
      label: "Apple container",
      status: "blocked",
      detail: `Failure in ${cwd}: Bearer abc.def.ghi for ${fakeEmail} ${fakeToken}`,
      fix: [`open ${home}/private`],
    }],
  };
  const bundle = buildSupportBundle({
    bumperVersion: "0.6.0",
    platform: "darwin",
    osVersion: "26.4.1",
    arch: "arm64",
    nodeVersion: "22.11.0",
    doctor: report,
    redaction: { home, cwd, configPath: report.configPath },
    now: new Date("2026-08-04T00:00:00.000Z"),
  });
  const text = JSON.stringify(bundle);
  assert.doesNotMatch(text, /alice|secret-client|abc\.def\.ghi|example\.com|ghp_/i);
  assert.match(text, /<cwd>|<redacted>|<email-redacted>|<secret-redacted>/);
  assert.equal(bundle.privacy.includes("No credential values"), true);

  assert.equal(
    redactDiagnosticText("at /private/var/folders/aa/bb/T/probe and /tmp/key.txt"),
    "at <temporary-path> and <temporary-path>",
  );
});

test("support command emits parseable JSON even before first Project", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-support-fresh-"));
  try {
    const result = spawnSync(process.execPath, [CLI, "support"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        BUMPER_CONFIG: join(root, "missing.json"),
        BUMPER_STATE: join(root, "state.json"),
        BUMPER_NO_CONTAINER_AUTOSTART: "1",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.kind, "bumper-support-bundle");
    assert.equal(payload.project, null);
    assert.ok(Array.isArray(payload.readiness.checks));
    assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
