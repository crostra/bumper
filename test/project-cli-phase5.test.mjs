/**
 * Phase 5: CLI-only journey entry points.
 *   W1-0  bumper init writes a Sandbox Project (legacy host example behind --legacy)
 *   W1-4  bumper doctor diagnoses container / Node / image / Access in one screen
 *
 * The rule under test throughout: doctor never reports a check it could not run
 * as passing. Skipped is unknown, not green.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  MINIMUM_NODE_MAJOR,
  buildDoctorReport,
  doctorProject,
  formatDoctorReport,
  hostArch,
} from "../dist/doctor.js";
import { applyCreatedProject } from "../dist/project.js";
import { RECOMMENDED_ROOM_IMAGE, SAFE_BASE_ROOM_IMAGE } from "../dist/room/setup.js";

const CLI = join(process.cwd(), "dist", "cli.js");

function healthyFacts(overrides = {}) {
  return {
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "22.11.0",
    cwd: "/tmp/does-not-matter",
    configPath: "/tmp/config.json",
    container: { usable: true, detail: "container CLI version 1.1.0" },
    recipe: { present: true, stale: false, detail: `${RECOMMENDED_ROOM_IMAGE} recipe ok` },
    overlay: { ok: true, detail: "PATH CLIs survive empty auth overlays." },
    ...overrides,
  };
}

function configWith(workspace, image = RECOMMENDED_ROOM_IMAGE, name = "Demo") {
  const config = { contexts: {}, defaultContext: undefined };
  applyCreatedProject(config, { name, workspace });
  config.contexts[name].room.image = image;
  return config;
}

function byId(report, id) {
  const check = report.checks.find((c) => c.id === id);
  assert.ok(check, `expected a "${id}" check`);
  return check;
}

test("doctor is ready only when every check ran and passed", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-doctor-"));
  try {
    const config = configWith(root);
    const report = buildDoctorReport(healthyFacts({ config, cwd: root }));
    assert.equal(report.ready, true);
    assert.equal(report.blocked.length, 0);
    assert.equal(report.projectName, "Demo");
    for (const check of report.checks) {
      assert.equal(check.status, "ok", `${check.id} should be ok: ${check.detail}`);
    }
    assert.match(formatDoctorReport(report), /Ready\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a check that could not run is skipped, never ok (no false green)", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-doctor-"));
  try {
    const config = configWith(root);
    const report = buildDoctorReport(healthyFacts({
      config,
      cwd: root,
      container: { usable: false, detail: "`container` CLI not found — install Apple container 1.1.0+." },
      recipe: undefined,
      overlay: undefined,
      imageProbeSkipReason: "Apple container is not available on this Mac.",
    }));

    assert.equal(report.ready, false);
    assert.equal(byId(report, "container").status, "blocked");
    // The image is unknown here, and must not be claimed as present.
    assert.equal(byId(report, "image").status, "skipped");
    assert.equal(byId(report, "image-overlay").status, "skipped");
    assert.match(byId(report, "image").detail, /not checked/i);

    const text = formatDoctorReport(report);
    assert.match(text, /Blocked:/);
    assert.match(text, /Install Apple container 1\.1\.0\+/);
    assert.match(text, /never as passing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each blocked check names the next command to type", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-doctor-"));
  try {
    // No config at all — the very first thing a fresh `npm i -g` user hits.
    const noConfig = buildDoctorReport(healthyFacts({
      config: undefined,
      configError: "No config found at /tmp/config.json.",
    }));
    assert.equal(noConfig.ready, false);
    assert.match(byId(noConfig, "config").fix.join("\n"), /bumper init/);
    assert.equal(byId(noConfig, "project").status, "skipped");
    assert.equal(byId(noConfig, "access").status, "skipped");

    // Base image — refuses honestly instead of claiming a CLI is there.
    const baseImage = buildDoctorReport(healthyFacts({
      config: configWith(root, SAFE_BASE_ROOM_IMAGE),
      cwd: root,
      recipe: undefined,
      overlay: undefined,
    }));
    assert.equal(byId(baseImage, "image").status, "blocked");
    assert.match(byId(baseImage, "image").fix.join("\n"), /bumper room-image build/);

    // Stale recommended image — the known materialize_path_bin trap.
    const stale = buildDoctorReport(healthyFacts({
      config: configWith(root),
      cwd: root,
      recipe: { present: true, stale: true, detail: "predates materialize_path_bin" },
      overlay: undefined,
    }));
    assert.equal(byId(stale, "image").status, "blocked");
    assert.match(byId(stale, "image").fix.join("\n"), /--force/);

    // Empty Access — cwd resolve can never match this Project.
    const emptyAccess = configWith(root);
    emptyAccess.contexts.Demo.workspace = undefined;
    const noAccess = buildDoctorReport(healthyFacts({ config: emptyAccess, cwd: root }));
    assert.equal(byId(noAccess, "access").status, "blocked");
    assert.match(byId(noAccess, "access").fix.join("\n"), /bumper access set -p "Demo"/);
    assert.match(byId(noAccess, "access").detail, /does not invent a home-wide door/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host and Node floors are stated, not assumed", () => {
  const linux = buildDoctorReport(healthyFacts({ platform: "linux" }));
  assert.equal(byId(linux, "platform").status, "blocked");
  assert.match(byId(linux, "platform").detail, /macOS only/);

  const intel = buildDoctorReport(healthyFacts({ arch: "x64" }));
  assert.equal(byId(intel, "platform").status, "blocked");
  assert.match(byId(intel, "platform").detail, /Apple Silicon/);

  const oldNode = buildDoctorReport(healthyFacts({ nodeVersion: "18.20.4" }));
  assert.equal(byId(oldNode, "node").status, "blocked");
  assert.match(byId(oldNode, "node").detail, new RegExp(`Node ${MINIMUM_NODE_MAJOR}\\+`));

  const oldContainer = buildDoctorReport(healthyFacts({
    container: { usable: true, detail: "container CLI version 1.0.3" },
  }));
  assert.equal(byId(oldContainer, "container").status, "blocked");
  assert.match(byId(oldContainer, "container").detail, /below the supported floor 1\.1\.0/);
});

test("a stopped container service is not reported as a missing image", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-doctor-"));
  try {
    // `container --version` succeeds while the background service is down.
    // Sending this user to a 10-minute image rebuild would waste their time
    // on a build that cannot succeed.
    const report = buildDoctorReport(healthyFacts({
      config: configWith(root),
      cwd: root,
      containerSystemDetail: 'XPC connection error: Connection invalid',
      imageProbeSkipReason: "the Apple container system service is not running.",
      recipe: undefined,
      overlay: undefined,
    }));

    const container = byId(report, "container");
    assert.equal(container.status, "blocked");
    assert.match(container.detail, /system service is not running/);
    assert.deepEqual(container.fix, ["container system start"]);

    assert.equal(byId(report, "image").status, "skipped");
    assert.match(byId(report, "image").detail, /system service is not running/);
    assert.equal(report.blocked.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardware arch is measured, not read off the Node build (Rosetta)", () => {
  // An x64 Node under Rosetta on an M-series Mac reports process.arch === "x64".
  // Blocking that user on "get an Apple Silicon Mac" is wrong and unfixable.
  const measured = hostArch();
  if (process.platform === "darwin") {
    assert.equal(measured.arch, "arm64", "these tests are supported on Apple Silicon");
    assert.equal(measured.nodeTranslated, process.arch !== "arm64");
  }

  const rosetta = buildDoctorReport(healthyFacts({ arch: "arm64", nodeTranslated: true }));
  const platform = byId(rosetta, "platform");
  assert.equal(platform.status, "warn", "Rosetta is a note, not a blocker");
  assert.match(platform.detail, /Rosetta/);
  assert.match(platform.detail, /Sandbox is unaffected/);
});

test("a custom Sandbox image is a warning, not a claim Bumper cannot make", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-doctor-"));
  try {
    const report = buildDoctorReport(healthyFacts({
      config: configWith(root, "ghcr.io/acme/agents:2026-08"),
      cwd: root,
      recipe: undefined,
      overlay: undefined,
    }));
    const image = byId(report, "image");
    assert.equal(image.status, "warn");
    assert.match(image.detail, /does not verify custom images/);
    // A warning does not block, but it is surfaced in the summary.
    assert.equal(report.ready, true);
    assert.match(formatDoctorReport(report), /Worth a look: Sandbox image/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("doctorProject resolves flag → cwd → default and never invents one", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-doctor-"));
  try {
    const config = configWith(root);
    assert.deepEqual(doctorProject(config, root, "Demo"), { name: "Demo", source: "flag" });
    assert.deepEqual(doctorProject(config, root), { name: "Demo", source: "cwd" });
    assert.deepEqual(doctorProject(config, tmpdir()), { name: "Demo", source: "default" });
    assert.match(doctorProject(config, root, "Nope").error, /Unknown project "Nope"/);
    assert.equal(doctorProject(undefined, root), undefined);
    assert.equal(doctorProject({ contexts: {} }, root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bumper init writes a Sandbox Project, not a legacy host config", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-init-"));
  try {
    const workspace = join(root, "my-repo");
    mkdirSync(workspace);
    const configPath = join(root, "config.json");
    const env = {
      ...process.env,
      BUMPER_CONFIG: configPath,
      BUMPER_STATE: join(root, "state", "state.json"),
    };

    const init = spawnSync(process.execPath, [CLI, "init"], {
      encoding: "utf8",
      env,
      cwd: workspace,
    });
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /Project "my-repo"/);
    assert.match(init.stdout, /bumper doctor/);
    assert.match(init.stdout, /never invents a home-wide door/);

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    const project = written.contexts["my-repo"];
    assert.ok(project, "init must create a Project keyed by the folder name");
    assert.equal(project.room.enabled, true);
    assert.ok(project.workspace.endsWith("my-repo"));
    // The legacy host-proxy shape must not come back through init.
    assert.deepEqual(written.backends, {});
    assert.deepEqual(project.backends, []);
    assert.deepEqual(project.repos, []);
    assert.deepEqual(project.writePaths, []);

    // Second run refuses rather than clobbering, and says what to run instead.
    const again = spawnSync(process.execPath, [CLI, "init"], { encoding: "utf8", env, cwd: workspace });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /Refusing to overwrite/);
    assert.match(again.stderr, /bumper doctor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bumper init --legacy keeps the old MCP-proxy example and labels its limit", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-init-legacy-"));
  try {
    const env = {
      ...process.env,
      BUMPER_CONFIG: join(root, "config.json"),
      BUMPER_STATE: join(root, "state", "state.json"),
    };
    const legacy = spawnSync(process.execPath, [CLI, "init", "--legacy"], {
      encoding: "utf8",
      env,
      cwd: root,
    });
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.match(legacy.stdout, /legacy host MCP-proxy example/);
    assert.match(legacy.stdout, /NOT Bumper-protected/);

    const written = JSON.parse(readFileSync(join(root, "bumper.config.json"), "utf8"));
    assert.ok(written.backends.filesystem, "legacy example still carries the demo backend");
    // It must not have touched the real user config path.
    assert.equal(existsSync(join(root, "config.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI module graph never loads node-pty (npm i -g needs no native build)", () => {
  // node-pty is the only native module Bumper depends on, and only the GUI's
  // attached-terminal path uses it. While it was imported at module scope,
  // `bumper doctor` — which never opens a pty — failed outright without it,
  // putting a native build in front of the entire `npm i -g` journey.
  //
  // Probe: node-pty is now pulled in through createRequire, so a load shows up
  // in the CJS require.cache. Import what cli.ts imports and assert it is absent.
  const probe = [
    'import { createRequire } from "node:module";',
    `const ROOT = ${JSON.stringify(process.cwd())};`,
    'const require = createRequire(ROOT + "/package.json");',
    'await import(ROOT + "/dist/cli-room.js");',
    'await import(ROOT + "/dist/app.js");',
    'const resolved = require.resolve("node-pty");',
    'console.log(Object.keys(require.cache).includes(resolved) ? "LOADED" : "NOT_LOADED");',
  ].join("\n");

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    "NOT_LOADED",
    "cli-room.js / app.js must not pull node-pty into the module graph",
  );
});

test("node-pty still loads when a pty is actually spawned", () => {
  // The deferral must not have quietly broken the GUI terminal path.
  const probe = [
    'import { createRequire } from "node:module";',
    `const ROOT = ${JSON.stringify(process.cwd())};`,
    'const require = createRequire(ROOT + "/package.json");',
    'const m = await import(ROOT + "/dist/room/apple-container.js");',
    'try {',
    '  new m.AppleContainerBackend().spawn(',
    '    { image: "x", doors: [], egress: { mode: "blocked" }, env: {} },',
    '    ["/bin/true"], { cols: 80, rows: 24 });',
    '} catch { /* the container binary may be absent; the require already ran */ }',
    'console.log(Object.keys(require.cache).includes(require.resolve("node-pty")) ? "LOADED" : "NOT_LOADED");',
  ].join("\n");

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "LOADED", "spawn() must still reach node-pty");
});

test("bumper doctor is in --help and exits non-zero while something blocks", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-doctor-cli-"));
  try {
    const env = {
      ...process.env,
      BUMPER_CONFIG: join(root, "config.json"),
      BUMPER_STATE: join(root, "state", "state.json"),
    };

    const help = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8", env });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /bumper doctor/);
    assert.match(help.stdout, /bumper init \[--legacy\]/);

    // --no-start because a test run must not start the developer's container
    // services as a side effect of asserting on output.
    const doctor = spawnSync(process.execPath, [CLI, "doctor", "--quick", "--no-start"], {
      encoding: "utf8",
      env,
      cwd: root,
    });
    assert.equal(doctor.status, 1);
    assert.match(doctor.stdout, /bumper doctor — can this Mac run a protected Sandbox\?/);
    assert.match(doctor.stdout, /Config:/);
    assert.match(doctor.stdout, /bumper init/);
    assert.match(doctor.stdout, /A Sandbox was not started/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
