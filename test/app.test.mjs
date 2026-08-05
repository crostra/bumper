import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";
import { effectiveContext } from "../dist/effective.js";
import { roomSpecForContext } from "../dist/room/spec.js";
import { aiProofProbes } from "../dist/room/aiproof.js";
import {
  createDevelopmentSessionLease,
  readDevelopmentSessionLease,
  removeDevelopmentSessionLease,
  updateDevelopmentSessionRuntime,
} from "../dist/development-session-lease.js";

test("local app API is GUI-complete and rejects untrusted mutations", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-app-test-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0, defaultContext: "Safe", backends: {},
    contexts: { Safe: { description: "test", mode: "read-write", backends: [], writePaths: [], readPaths: [], repos: [], allowedHosts: [] } },
  }));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = statePath;
  const { config } = loadConfig();
  const openedPreviewUrls = [];
  const handle = await startApp(config, () => loadConfig().config, join(process.cwd(), "dist", "cli.js"), {
    openExternal: (url) => openedPreviewUrls.push(url),
  });
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG; else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE; else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  const stateResponse = await fetch(`${handle.url}/api/state`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.active, "Safe");
  assert.equal(state.platform.telemetry, false);
  assert.ok(Array.isArray(state.sessions));
  assert.equal(state.globalPolicy.commands.gitRemoteWrite, "block");
  assert.equal(state.contexts.Safe.effectiveMode, "read-write");
  assert.equal(state.contexts.Safe.room.enabled, true);
  assert.equal(state.contexts.Safe.development.preview.enabled, true);
  assert.equal(state.contexts.Safe.development.docker.enabled, true);
  assert.ok(Array.isArray(state.developmentSessions));
  // Default Sandbox image is a plain base (alpine) — intentional empty safe Sandbox.
  assert.equal(state.contexts.Safe.imageSource?.kind, "base");
  assert.match(state.contexts.Safe.imageSource?.label || "", /no AI CLIs|base/i);
  // Enforcement-source assurance is compiled per project and documented by a legend.
  assert.ok(Array.isArray(state.contexts.Safe.assurance));
  assert.ok(state.contexts.Safe.assurance.some((item) => item.id === "sealed-room" && item.source === "vm"));
  assert.ok(state.contexts.Safe.assurance.some((item) => item.id === "git-credentials" && item.source === "vm"));
  assert.ok(state.assuranceLegend.vm && state.assuranceLegend.broker && state.assuranceLegend["not-enforced"]);

  const htmlResponse = await fetch(handle.url);
  assert.equal(htmlResponse.status, 200);
  const appHtml = await htmlResponse.text();
  assert.match(appHtml, /data-project-section="development"/);
  assert.match(appHtml, /project-section-development/);
  assert.match(appHtml, /data-route="projects"/);
  assert.match(appHtml, /data-route="events"/);
  assert.match(appHtml, /data-route="library"/);
  assert.match(appHtml, /data-route="settings"/);
  assert.match(appHtml, /id="route-project"/);
  assert.match(appHtml, /id="route-setup"/);
  assert.match(appHtml, /src="\/launch-gate\.js"/);
  assert.doesNotMatch(appHtml, /data-route="home"/);
  assert.doesNotMatch(appHtml, /id="launch-button"/);
  assert.doesNotMatch(appHtml, /id="route-home"/);

  // Live development controls are host-only, independently revocable, and may
  // open only a mapping currently asserted by the broker lease.
  const developmentSessionId = "development-test-session-1234";
  createDevelopmentSessionLease({
    id: developmentSessionId,
    pid: process.pid,
    projectName: "Safe",
    agentId: "claude",
    agentName: "Claude",
    previewEnabled: true,
    dockerEnabled: true,
  });
  updateDevelopmentSessionRuntime(developmentSessionId, {
    previewPorts: [{
      source: "room",
      roomPort: 3000,
      hostPort: 54321,
      url: "http://127.0.0.1:54321",
    }],
  });
  const previewOff = await fetch(`${handle.url}/api/development/session-control`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: developmentSessionId,
      capability: "preview",
      enabled: false,
    }),
  });
  assert.equal(previewOff.status, 200);
  assert.equal(readDevelopmentSessionLease(developmentSessionId)?.control.previewEnabled, false);
  const openWhileOff = await fetch(`${handle.url}/api/development/open-preview`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: developmentSessionId, hostPort: 54321 }),
  });
  assert.equal(openWhileOff.status, 409);
  const previewOn = await fetch(`${handle.url}/api/development/session-control`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: developmentSessionId,
      capability: "preview",
      enabled: true,
    }),
  });
  assert.equal(previewOn.status, 200);
  const openMapped = await fetch(`${handle.url}/api/development/open-preview`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: developmentSessionId, hostPort: 54321 }),
  });
  assert.equal(openMapped.status, 200);
  assert.deepEqual(openedPreviewUrls, ["http://127.0.0.1:54321"]);
  const openUnmapped = await fetch(`${handle.url}/api/development/open-preview`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: developmentSessionId, hostPort: 54322 }),
  });
  assert.equal(openUnmapped.status, 409);
  removeDevelopmentSessionLease(developmentSessionId);

  const gateResponse = await fetch(`${handle.url}/launch-gate.js`);
  assert.equal(gateResponse.status, 200);
  const gateJs = await gateResponse.text();
  assert.match(gateJs, /function computeLaunchGate\(/);
  assert.match(gateJs, /BumperLaunchGate/);
  assert.match(gateJs, /open-project-settings/);

  const jsResponse = await fetch(`${handle.url}/app.js`);
  assert.equal(jsResponse.status, 200);
  const appJs = await jsResponse.text();
  assert.match(appJs, /ensureRoomPreflightStatuses/);
  assert.match(appJs, /Missing in image/);
  assert.match(appJs, /Sandbox image setup/);
  assert.match(appJs, /isBaseRoomImage/);
  assert.match(appJs, /mode === "selected"|mode: "selected"/);
  assert.match(appJs, /mode === "all"|mode: "all"/);
  // Overview must not auto-preflight every agent on a base image (five redundant checks).
  assert.match(appJs, /if \(isBaseRoomImage\(projectName\)\) return;/);
  assert.match(appJs, /intentional unconfigured safe base/);
  assert.match(appJs, /does not download or build until you click/);
  assert.match(appJs, /buildRoomImage/);
  assert.match(appJs, /renderProjectOverview/);
  assert.match(appJs, /BumperLaunchGate/);
  assert.match(appJs, /class="command-chip"/);
  assert.match(appJs, /open-project-settings/);
  assert.doesNotMatch(appJs, /agents\.length \? Promise\.resolve\(agents\)/);
  assert.match(appHtml, /Set up Bumper|data-i18n="setup\.title"/i);
  assert.match(appJs, /Checked on this Mac|Controlled per Session/);
  assert.match(appJs, /allowApplicability/);
  // Run path is the terminal command, and no GUI launch CTA exists.
  assert.match(appJs, /function aiLaunchCommand\(/);
  assert.doesNotMatch(appJs, /Launch protected/i);

  // Plan endpoint is pure: same probe ids as aiProofProbes, no backend, no 500 on bad context.
  const planRes = await fetch(`${handle.url}/api/room/ai-proof/plan?context=Safe`);
  assert.equal(planRes.status, 200);
  const plan = await planRes.json();
  assert.ok(Array.isArray(plan.probes));
  const liveConfig = loadConfig().config;
  const liveContext = effectiveContext(liveConfig, "Safe");
  const liveSpec = roomSpecForContext(liveContext, workspace);
  const expectedPlan = aiProofProbes(liveContext, liveSpec.doors);
  assert.deepEqual(
    plan.probes.map((p) => p.id),
    expectedPlan.map((p) => p.id),
    "GET /api/room/ai-proof/plan must match aiProofProbes for the same context",
  );
  assert.deepEqual(
    plan.probes.map((p) => ({ id: p.id, expect: p.expect, target: p.attempt?.target, enforcer: p.attempt?.enforcer })),
    expectedPlan.map((p) => ({ id: p.id, expect: p.expect, target: p.attempt?.target, enforcer: p.attempt?.enforcer })),
  );
  const missingPlan = await fetch(`${handle.url}/api/room/ai-proof/plan?context=NoSuchProject`);
  assert.equal(missingPlan.status, 200);
  assert.deepEqual((await missingPlan.json()).probes, []);

  // Without a usable room there is no evidence, so the proof must report none
  // rather than scoring a host-side stand-in as if it were a boundary check.
  const aiProof = await fetch(`${handle.url}/api/room/ai-proof`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: "Safe", workspace }),
  });
  assert.equal(aiProof.status, 200);
  const proof = await aiProof.json();
  assert.ok(Array.isArray(proof.results));
  if (!proof.available) {
    assert.equal(proof.results.length, 0, "no room means no checks — never a substitute pass");
  }
  assert.ok(!proof.results.some((r) => String(r.id).startsWith("git-")), "git is no longer a boundary check");

  const setupPlan = await fetch(`${handle.url}/api/room/setup`);
  assert.equal(setupPlan.status, 200);
  const setup = await setupPlan.json();
  assert.equal(setup.image, "bumper/ai-room:latest");
  assert.deepEqual(setup.installs, ["claude", "codex", "cursor-agent", "agy", "grok"]);
  assert.equal(setup.autoBuild, false);
  assert.equal(setup.autoDownload, false);
  assert.match(setup.baseImageNote || "", /intentionally include no AI CLIs/i);

  // launch-gate.js exposes safe-base helpers used by Home cards / checklist.
  assert.match(gateJs, /baseImageSetupReadiness/);
  assert.match(gateJs, /shouldAutoPreflightOnHome/);
  assert.match(gateJs, /imageStatus === "setup"/);

  const agentResponse = await fetch(`${handle.url}/api/agents`);
  assert.equal(agentResponse.status, 200);
  const agents = await agentResponse.json();
  assert.equal(agents.length, 5);
  assert.ok(agents.every((agent) => Array.isArray(agent.roomCommand) && agent.roomCommand.length > 0));
  assert.ok(agents.every((agent) => typeof agent.signedIn === "boolean" && Array.isArray(agent.roomAuthPaths)));

  const unknownPreflight = await fetch(`${handle.url}/api/room/preflight`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: "Safe", workspace, agentId: "missing-agent" }),
  });
  assert.equal(unknownPreflight.status, 500);
  assert.match((await unknownPreflight.json()).error, /Unknown AI tool/);

  const rejected = await fetch(`${handle.url}/api/contexts`, {
    method: "POST", headers: { "content-type": "application/json", "origin": "https://example.com" },
    body: JSON.stringify({ name: "Untrusted" }),
  });
  assert.equal(rejected.status, 403);

  const protection = await fetch(`${handle.url}/api/protection-test`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: "Safe", workspace }),
  });
  assert.equal(protection.status, 200);
  assert.equal((await protection.json()).passed, true);

  const savedGlobal = await fetch(`${handle.url}/api/global-policy`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...state.globalPolicy, mode: "read-only" }),
  });
  assert.equal(savedGlobal.status, 200);
  assert.equal(loadConfig().config.globalPolicy.mode, "read-only");

  const pathTest = await fetch(`${handle.url}/api/path-test`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: "Safe", workspace, path: workspace }),
  });
  assert.equal(pathTest.status, 200);
  const pathBody = await pathTest.json();
  assert.equal(pathBody.writeAllowed, true);
  // Explicit legacy identifier — never Sandbox-like "macOS enforced".
  assert.equal(pathBody.assurance, "legacy-seatbelt");

  const savedRoom = await fetch(`${handle.url}/api/contexts`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      previous: "Safe", name: "Safe", description: "test", workspace, mode: "read-write",
      inheritMode: false, backends: [], native: { allow: [], deny: [] }, commands: {},
      writePaths: [], readPaths: [], denyReadPaths: [], denyWritePaths: [],
      gitIgnored: "visible", repos: [], allowedHosts: [],
      room: {
        enabled: true,
        image: "docker.io/library/alpine:3.20",
        egress: "blocked",
        doors: [{ hostPath: workspace, roomPath: "/workspace-copy", access: "read-only" }],
      },
    }),
  });
  assert.equal(savedRoom.status, 200);
  const updated = loadConfig().config.contexts.Safe;
  assert.equal(updated.room.enabled, true);
  assert.equal(updated.room.egress, "blocked");
  assert.equal(updated.room.doors[0].roomPath, "/workspace-copy");
});
