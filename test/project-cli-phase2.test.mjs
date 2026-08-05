/**
 * Phase 2: bumper <cli> readiness refuse + status cage summary.
 * Does not require a long interactive TUI or live container session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  CLI_AGENT_ALIASES,
  assessCliRoomReadiness,
  buildProjectStatusSnapshot,
  executablePreflightSpec,
  formatProjectStatus,
  formatProjectStatusSummary,
  formatReadinessRefuse,
  isCliAgentCommand,
  listCliAgentAliases,
  parseProjectFlag,
  parseRoomAgentInvocation,
  projectStatusIssues,
  resolveCliAgentId,
  resolveLaunchWorkspace,
  runCliRoomAgent,
} from "../dist/cli-room.js";
import { loadLaunchGate } from "../dist/launch-gate-node.js";

function blankContext(overrides = {}) {
  return {
    description: "",
    backends: [],
    mode: "read-write",
    inheritMode: true,
    policies: {},
    native: { allow: [], deny: [] },
    commands: {},
    writePaths: [],
    readPaths: [],
    denyReadPaths: [],
    denyWritePaths: [],
    gitIgnored: "visible",
    repos: [],
    allowedHosts: [],
    room: {
      enabled: true,
      image: "docker.io/library/alpine:3.20",
      egress: "blocked",
      egressTemplates: [],
      egressHosts: [],
      doors: [],
      workspaceShare: "whole",
      shareSubpaths: [],
    },
    ...overrides,
  };
}

function makeConfig(contexts) {
  return {
    webPort: 0,
    backends: {},
    globalPolicy: {
      mode: "read-write",
      native: { allow: [], deny: [] },
      commands: {
        gitRead: "allow", gitLocalWrite: "allow", gitRemoteRead: "allow",
        gitRemoteWrite: "block", shellRead: "allow", shellWrite: "allow", unknown: "block",
      },
      readPaths: [], writePaths: [], denyReadPaths: [], denyWritePaths: [],
    },
    contexts,
    defaultContext: Object.keys(contexts)[0],
  };
}

test("CLI agent aliases map to AgentId (host CLI not required)", () => {
  assert.equal(resolveCliAgentId("grok"), "grok");
  assert.equal(resolveCliAgentId("claude"), "claude");
  assert.equal(resolveCliAgentId("codex"), "codex");
  assert.equal(resolveCliAgentId("cursor"), "cursor");
  assert.equal(resolveCliAgentId("cursor-agent"), "cursor");
  assert.equal(resolveCliAgentId("agy"), "antigravity");
  assert.equal(resolveCliAgentId("antigravity"), "antigravity");
  assert.equal(resolveCliAgentId("Grok"), "grok");
  assert.equal(isCliAgentCommand("grok"), true);
  assert.equal(isCliAgentCommand("status"), false);
  assert.ok(listCliAgentAliases().includes("agy"));
  assert.ok(Object.keys(CLI_AGENT_ALIASES).length >= 5);
});

test("executable preflight seals allowlist egress until launch prepares its network", () => {
  const spec = {
    image: "custom/agent:latest",
    doors: [{ hostPath: "/tmp/work", roomPath: "/workspace", access: "read-write" }],
    egress: { mode: "allowlist", hosts: ["api.example.test"] },
    dropCapabilities: true,
  };
  const probe = executablePreflightSpec(spec);
  assert.deepEqual(probe.egress, { mode: "blocked" });
  assert.equal(probe.image, spec.image);
  assert.deepEqual(probe.doors, spec.doors);
  assert.equal(spec.egress.mode, "allowlist", "the real launch boundary must remain unchanged");
});

test("parseProjectFlag supports -p, --project, --account, and -p=", () => {
  assert.deepEqual(parseProjectFlag(["-p", "Demo", "grok"]), {
    projectFlag: "Demo",
    accountFlag: undefined,
    rest: ["grok"],
  });
  assert.deepEqual(parseProjectFlag(["--project", "X", "claude", "--help"]), {
    projectFlag: "X",
    accountFlag: undefined,
    rest: ["claude", "--help"],
  });
  assert.deepEqual(parseProjectFlag(["-p=Acme", "agy"]), {
    projectFlag: "Acme",
    accountFlag: undefined,
    rest: ["agy"],
  });
  assert.deepEqual(parseProjectFlag(["grok", "-p", "Y"]), {
    projectFlag: "Y",
    accountFlag: undefined,
    rest: ["grok"],
  });
  assert.deepEqual(parseProjectFlag(["claude", "--account", "work"]), {
    projectFlag: undefined,
    accountFlag: "work",
    rest: ["claude"],
  });
  assert.throws(() => parseProjectFlag(["-p"]), /Missing value/);
});

test("room-agent parsing keeps --account while preserving vendor args", () => {
  assert.deepEqual(
    parseRoomAgentInvocation(["--account", "work", "exec", "hello", "-p", "Demo"]),
    {
      projectFlag: "Demo",
      accountFlag: "work",
      agentArgs: ["exec", "hello"],
    },
  );
});

test("resolve+readiness refuse: base image does not start Sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-p2-base-"));
  try {
    const ws = join(root, "ws");
    mkdirSync(ws);
    const config = makeConfig({
      Demo: blankContext({
        workspace: ws,
        room: {
          ...blankContext().room,
          image: "docker.io/library/alpine:3.20",
        },
      }),
    });

    const assessment = await assessCliRoomReadiness({
      config,
      projectName: "Demo",
      agentId: "grok",
      cwd: ws,
      macOS: true,
      roomAvailable: true,
      roomAvailableDetail: "container 1.1.0 (test)",
      // Base image should short-circuit without needing real preflight
    });

    assert.equal(assessment.canLaunch, false);
    assert.equal(assessment.image.status, "setup");
    assert.match(assessment.image.detail, /Safe base image|no AI CLIs/i);
    assert.ok(assessment.image.skippedPreflight);

    const message = formatReadinessRefuse(assessment);
    assert.match(message, /cannot start grok/i);
    assert.match(message, /Sandbox was not started/);
    assert.match(message, /Host vendor CLI is not required/);
    assert.match(message, /Checklist:/);
    assert.match(message, /Sandbox image|AI Sandbox image|Safe base/i);

    const result = await runCliRoomAgent({
      config,
      projectName: "Demo",
      agentId: "grok",
      cwd: ws,
      assessment,
      dryRun: true,
      requireTty: false,
    });
    assert.equal(result.started, false);
    assert.equal(result.refused, true);
    assert.equal(result.exitCode, 1);
    assert.match(result.message, /Sandbox was not started/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolve+readiness refuse: missing container does not start Sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-p2-nocont-"));
  try {
    const ws = join(root, "ws");
    mkdirSync(ws);
    const config = makeConfig({
      Demo: blankContext({
        workspace: ws,
        room: {
          ...blankContext().room,
          image: "bumper/ai-room:latest",
        },
      }),
    });

    const assessment = await assessCliRoomReadiness({
      config,
      projectName: "Demo",
      agentId: "claude",
      cwd: ws,
      macOS: true,
      roomAvailable: false,
      roomAvailableDetail: "`container` CLI not found — install Apple container 1.1.0+.",
      imageProbe: {
        status: "unavailable",
        detail: "`container` CLI not found — install Apple container 1.1.0+.",
        skippedPreflight: true,
      },
    });

    assert.equal(assessment.canLaunch, false);
    assert.match(assessment.gate.reason, /Apple container|not installed/i);
    const message = formatReadinessRefuse(assessment);
    assert.match(message, /cannot start claude/i);
    assert.match(message, /Sandbox was not started/);
    assert.match(message, /install|container/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolve+readiness refuse: missing workspace", async () => {
  const config = makeConfig({
    Demo: blankContext({
      workspace: "",
      room: {
        ...blankContext().room,
        image: "bumper/ai-room:latest",
      },
    }),
  });

  const assessment = await assessCliRoomReadiness({
    config,
    projectName: "Demo",
    agentId: "codex",
    cwd: join(tmpdir(), "bumper-no-such-workspace-xyz"),
    macOS: true,
    roomAvailable: true,
    roomAvailableDetail: "ok",
    imageProbe: {
      status: "pending",
      detail: "Choose a workspace before checking the image.",
      skippedPreflight: true,
    },
  });

  assert.equal(assessment.canLaunch, false);
  assert.match(assessment.gate.reason, /workspace/i);
});

test("resolve+readiness refuse: room disabled", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-p2-noroom-"));
  try {
    const ws = join(root, "ws");
    mkdirSync(ws);
    const config = makeConfig({
      Demo: blankContext({
        workspace: ws,
        room: {
          ...blankContext().room,
          enabled: false,
          image: "bumper/ai-room:latest",
        },
      }),
    });

    const assessment = await assessCliRoomReadiness({
      config,
      projectName: "Demo",
      agentId: "cursor",
      cwd: ws,
      macOS: true,
      roomAvailable: true,
      roomAvailableDetail: "ok",
      imageProbe: {
        status: "ready",
        detail: "would be ready",
        skippedPreflight: true,
      },
    });

    assert.equal(assessment.canLaunch, false);
    assert.match(assessment.gate.reason, /Sandbox is disabled|Enable Sandbox/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readiness canLaunch when hard prerequisites met (dry-run does not start Sandbox)", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-p2-ready-"));
  try {
    const ws = join(root, "ws");
    mkdirSync(ws);
    const config = makeConfig({
      Demo: blankContext({
        workspace: ws,
        room: {
          ...blankContext().room,
          image: "bumper/ai-room:latest",
        },
      }),
    });

    assert.equal(resolveCliAgentId("agy"), "antigravity");
    const assessment = await assessCliRoomReadiness({
      config,
      projectName: "Demo",
      agentId: "antigravity",
      cwd: ws,
      macOS: true,
      roomAvailable: true,
      roomAvailableDetail: "container ok",
      imageProbe: {
        status: "ready",
        detail: "agy ready in image",
        skippedPreflight: true,
      },
    });

    assert.equal(assessment.canLaunch, true);
    assert.equal(assessment.agentId, "antigravity");
    assert.deepEqual(assessment.roomCommand, ["agy"]);

    const result = await runCliRoomAgent({
      config,
      projectName: "Demo",
      agentId: "antigravity",
      cwd: ws,
      assessment,
      dryRun: true,
      requireTty: false,
    });
    assert.equal(result.started, false);
    assert.equal(result.dryRunReady, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.message, /dry-run|Sandbox not started/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("status snapshot includes Access, image, egress, tools without session", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-p2-status-"));
  try {
    const ws = join(root, "ws");
    const extra = join(root, "extra");
    mkdirSync(ws);
    mkdirSync(extra);
    const config = makeConfig({
      Cage: blankContext({
        workspace: ws,
        readPaths: [extra],
        room: {
          ...blankContext().room,
          image: "docker.io/library/alpine:3.20",
          egress: "allowlist",
          egressHosts: ["api.example.com"],
        },
      }),
    });

    const snapshot = await buildProjectStatusSnapshot({
      config,
      projectName: "Cage",
      source: "flag",
      cwd: ws,
      roomAvailable: false,
      roomAvailableDetail: "not installed (test)",
    });

    assert.equal(snapshot.projectName, "Cage");
    assert.equal(snapshot.egress, "allowlist");
    assert.equal(snapshot.imageKind, "base");
    assert.ok(snapshot.accessRoots.some((r) => r.role === "workspace"));
    assert.ok(snapshot.accessRoots.some((r) => r.role === "read"));
    assert.ok(snapshot.tools.some((t) => t.id === "grok" && t.mapped));
    assert.match(snapshot.note || "", /recommended image|Safe base/i);

    const text = formatProjectStatus(snapshot);
    assert.match(text, /Project: Cage/);
    assert.match(text, /Network: Allowed only — Allowed sites only/);
    assert.match(text, /Access roots:/);
    assert.match(text, /Tool readiness/);
    assert.match(text, /Host install not required|not required/i);
    assert.match(text, /No session started/);
    assert.match(text, /bumper \[-p project\] <cli>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scan-first status separates an installed CLI from stopped services and names the fix", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-p2-status-summary-"));
  try {
    const config = makeConfig({
      Demo: blankContext({
        workspace: root,
        room: {
          ...blankContext().room,
          image: "bumper/ai-room:latest",
          egress: "open",
        },
      }),
    });
    const snapshot = await buildProjectStatusSnapshot({
      config,
      projectName: "Demo",
      source: "cwd",
      cwd: root,
      roomAvailable: true,
      roomAvailableDetail: "container CLI version 1.1.0",
      containerSystemState: "stopped",
      containerSystemDetail: "apiserver is not running",
    });

    assert.equal(snapshot.container.usable, true);
    assert.equal(snapshot.container.systemState, "stopped");
    assert.match(snapshot.note, /not checked.*services are stopped/i);
    assert.ok(projectStatusIssues(snapshot).some((issue) => issue.command === "container system start"));

    const text = formatProjectStatusSummary(
      snapshot,
      [{ id: "12345678-session", agentName: "Codex" }],
      { blocked: 2, allowed: 4 },
    );
    assert.match(text, /^Bumper status — needs attention/m);
    assert.match(text, /Sessions: 1 running — Codex \(12345678\)/);
    assert.match(text, /Network: Open — Full internet \(unrestricted\)/);
    assert.match(text, /Container CLI: installed/);
    assert.match(text, /Container service: stopped/);
    assert.match(text, /Sandbox image: Bumper recommended AI Sandbox image · not-checked/);
    assert.match(text, /Today: 2 blocked · 4 allowed/);
    assert.match(text, /Next\n  container system start/);
    assert.match(text, /Review \(Network is unrestricted\)/);
    assert.match(text, /bumper network off -p "Demo"/);
    assert.match(text, /bumper status --verbose/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI process: status refuse path for unknown -p; help lists Sandbox entry", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-p2-cli-"));
  try {
    const ws = join(root, "ws");
    mkdirSync(ws);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(makeConfig({
      Demo: blankContext({ workspace: ws }),
    }), null, 2));

    const env = {
      ...process.env,
      BUMPER_CONFIG: configPath,
      BUMPER_STATE: join(root, "state.json"),
    };
    const cli = join(process.cwd(), "dist", "cli.js");

    const bad = spawnSync(process.execPath, [cli, "status", "-p", "Missing"], {
      encoding: "utf8",
      env,
    });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr + bad.stdout, /Unknown project "Missing"/);

    const help = spawnSync(process.execPath, [cli, "help"], {
      encoding: "utf8",
      env,
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /bumper \[-p project\] <cli>/);
    assert.match(help.stdout, /Sandbox image is canonical|Sandbox image CLI is canonical/i);

    const status = spawnSync(process.execPath, [cli, "status", "-p", "Demo"], {
      encoding: "utf8",
      env,
    });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Project: Demo/);
    assert.match(status.stdout, /Boundary/);
    assert.match(status.stdout, /Folders: 1 shared/);
    assert.match(status.stdout, /Sessions: none running/);

    // Readiness refuse without interactive TUI / long container session
    const refuse = spawnSync(process.execPath, [cli, "-p", "Demo", "grok"], {
      encoding: "utf8",
      env,
      // no TTY — still must refuse before attach when base image
    });
    assert.notEqual(refuse.status, 0);
    const out = refuse.stderr + refuse.stdout;
    assert.match(out, /cannot start grok|Sandbox is not ready|Sandbox was not started|Safe base|not ready/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launch-gate-node loads the same computeLaunchGate as renderer asset", () => {
  const api = loadLaunchGate();
  assert.equal(typeof api.computeLaunchGate, "function");
  const gate = api.computeLaunchGate({
    macOS: true,
    roomAvailable: true,
    projectName: "P",
    workspace: "/tmp/ws",
    roomEnabled: true,
    agentId: "grok",
    agentMapped: true,
    imageStatus: "setup",
    imageDetail: api.SAFE_BASE_IMAGE_DETAIL,
  });
  assert.equal(gate.canLaunch, false);
  assert.equal(gate.nextAction, "build-image");
});

test("resolveLaunchWorkspace prefers project workspace", () => {
  const ctx = blankContext({ workspace: "/tmp/project-ws" });
  assert.ok(resolveLaunchWorkspace(ctx, "/other").includes("project-ws") || resolveLaunchWorkspace(ctx, "/other").endsWith("project-ws"));
});
