/**
 * W1-3: Project network as a shared operation.
 *
 * The value under test is not "the CLI can write a field" — it is that the CLI
 * and the GUI reach the same decision. `normalizeEgress` is what app.ts's
 * saveContext now uses, and `setProjectNetwork` is what `bumper network` calls,
 * so the rules below hold for both entry points.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  NETWORK_VERBS,
  listEgressTemplates,
  networkLabel,
  networkSentence,
  normalizeEgress,
  setProjectNetwork,
} from "../dist/operations/network.js";
import { isOperationError } from "../dist/operations/error.js";
import { applyCreatedProject } from "../dist/project.js";

const CLI = join(process.cwd(), "dist", "cli.js");

function configWith(workspace, name = "Demo") {
  const config = { contexts: {} };
  applyCreatedProject(config, { name, workspace });
  return config;
}

test("CLI verbs map onto the stored modes the GUI writes", () => {
  assert.equal(NETWORK_VERBS.off, "blocked");
  assert.equal(NETWORK_VERBS.allowed, "allowlist");
  assert.equal(NETWORK_VERBS.open, "open");
  // The labels are the GUI's words, so both surfaces say the same thing.
  assert.equal(networkLabel("blocked"), "Off");
  assert.equal(networkLabel("allowlist"), "Allowed only");
  assert.equal(networkLabel("open"), "Open");
  assert.equal(networkSentence("blocked"), "No internet");
});

test("normalizeEgress falls back to Off, never to Open", () => {
  // saveContext feeds this an untyped HTTP blob; an unrecognised mode must not
  // widen the boundary.
  assert.equal(normalizeEgress({}).egress, "blocked");
  assert.equal(normalizeEgress({ egress: "nonsense" }).egress, "blocked");
  assert.equal(normalizeEgress({ egress: null }).egress, "blocked");
  assert.equal(normalizeEgress({ egress: "open" }).egress, "open");
  assert.equal(normalizeEgress({ egress: "allowlist" }).egress, "allowlist");
  // Blank and duplicate entries are dropped on both paths.
  const cleaned = normalizeEgress({ egress: "allowlist", egressHosts: [" a.com ", "", "a.com"], egressTemplates: ["openai", "openai"] });
  assert.deepEqual(cleaned.egressHosts, ["a.com"]);
  assert.deepEqual(cleaned.egressTemplates, ["openai"]);
});

test("switching Off and back keeps the allowlist you built", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-net-"));
  try {
    const config = configWith(root);
    setProjectNetwork({ config, projectName: "Demo", mode: "allowlist", hosts: ["api.anthropic.com"] });
    const off = setProjectNetwork({ config, projectName: "Demo", mode: "blocked" });
    assert.equal(off.next.egress, "blocked");
    assert.deepEqual(off.next.egressHosts, ["api.anthropic.com"], "Off must not discard the list");
    const back = setProjectNetwork({ config, projectName: "Demo", mode: "allowlist", hosts: ["api.anthropic.com"] });
    assert.deepEqual(back.effectiveHosts, ["api.anthropic.com"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("templates expand to the hosts the proxy will actually allow", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-net-"));
  try {
    const config = configWith(root);
    const result = setProjectNetwork({
      config, projectName: "Demo", mode: "allowlist",
      templates: ["anthropic"], hosts: ["example.internal"],
    });
    assert.ok(result.effectiveHosts.includes("api.anthropic.com"));
    assert.ok(result.effectiveHosts.includes("example.internal"));
    assert.equal(result.appliesToNewSessions, true);
    assert.ok(listEgressTemplates().some((t) => t.id === "anthropic"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Allowed only with nothing allowed is refused, not silently total blocking", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-net-"));
  try {
    const config = configWith(root);
    assert.throws(
      () => setProjectNetwork({ config, projectName: "Demo", mode: "allowlist" }),
      (err) => {
        assert.ok(isOperationError(err));
        assert.equal(err.code, "invalid");
        assert.match(err.message, /would block everything without saying so/);
        assert.ok(err.fix.some((line) => line.includes("bumper network off")));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operations fail with a code the adapters can map", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-net-"));
  try {
    const config = configWith(root);
    assert.throws(
      () => setProjectNetwork({ config, projectName: "Nope", mode: "open" }),
      (err) => isOperationError(err) && err.code === "not-found",
    );
    assert.throws(
      () => setProjectNetwork({ config, projectName: "Demo", mode: "allowlist", templates: ["nope"] }),
      (err) => isOperationError(err) && err.code === "invalid",
    );
    assert.throws(
      () => setProjectNetwork({ config, projectName: "Demo", mode: "allowlist", hosts: ["https://a.com/x"] }),
      (err) => isOperationError(err) && err.code === "invalid" && /not a hostname/.test(err.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bumper network writes the Project a CLI-only user can actually narrow", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-net-cli-"));
  try {
    const workspace = join(root, "my-repo");
    mkdirSync(workspace);
    const configPath = join(root, "config.json");
    const env = { ...process.env, BUMPER_CONFIG: configPath, BUMPER_STATE: join(root, "state", "state.json") };

    const init = spawnSync(process.execPath, [CLI, "init"], { encoding: "utf8", env, cwd: workspace });
    assert.equal(init.status, 0, init.stderr);
    // init hands out Open so the first `bumper <cli>` can reach its own API.
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).contexts["my-repo"].room.egress, "open");

    const off = spawnSync(process.execPath, [CLI, "network", "off"], { encoding: "utf8", env, cwd: workspace });
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stdout, /Open → Off/);
    assert.match(off.stdout, /No internet/);
    assert.match(off.stdout, /Applies to new Sessions/);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).contexts["my-repo"].room.egress, "blocked");

    const allowed = spawnSync(
      process.execPath,
      [CLI, "network", "allowed", "--template", "anthropic", "example.internal"],
      { encoding: "utf8", env, cwd: workspace },
    );
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /api\.anthropic\.com/);
    assert.match(allowed.stdout, /example\.internal/);

    const show = spawnSync(process.execPath, [CLI, "network", "show"], { encoding: "utf8", env, cwd: workspace });
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /Network: Allowed only/);
    assert.match(show.stdout, /Available templates:/);

    // An empty allowlist is refused through the CLI too, with the next command.
    const empty = spawnSync(process.execPath, [CLI, "network", "allowed"], { encoding: "utf8", env, cwd: workspace });
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /block everything without saying so/);
    assert.match(empty.stderr, /Next:/);
    assert.match(empty.stderr, /bumper network off/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bumper network is in --help", () => {
  const help = spawnSync(process.execPath, [CLI, "help", "all"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /bumper network off\|allowed\|open/);
});
