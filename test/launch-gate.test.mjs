import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { ELECTRON_NAV, RENDERER_ROUTES } from "../dist/electron-nav.js";

/**
 * Load the exact classic script the renderer serves as /launch-gate.js.
 * (package.json is "type":"module", so createRequire cannot consume the CJS export.)
 */
function loadRendererLaunchGate() {
  const code = readFileSync(join(process.cwd(), "assets", "launch-gate.js"), "utf8");
  const sandbox = { module: { exports: {} }, exports: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  const api = sandbox.BumperLaunchGate || sandbox.module.exports;
  assert.equal(typeof api.computeLaunchGate, "function", "renderer launch-gate must export computeLaunchGate");
  return api;
}

const {
  computeLaunchGate,
  baseImageSetupReadiness,
  shouldAutoPreflightOnHome,
  SAFE_BASE_IMAGE_DETAIL,
  SAFE_BASE_LAUNCH_REASON,
} = loadRendererLaunchGate();

const base = {
  macOS: true,
  roomAvailable: true,
  projectName: "Safe",
  workspace: "/tmp/ws",
  roomEnabled: true,
  agentId: "claude",
  agentMapped: true,
  imageStatus: "ready",
  imageDetail: "Ready in image",
  authRelevant: true,
  authPersisted: false,
};

test("computeLaunchGate is ready only when hard prerequisites pass", () => {
  const gate = computeLaunchGate(base);
  assert.equal(gate.canLaunch, true);
  assert.equal(gate.reason, "");
  assert.equal(gate.nextAction, "launch");
  assert.equal(gate.protectionState, "ready");
  assert.ok(gate.checklist.some((item) => item.id === "auth" && item.status === "optional"));
  assert.ok(gate.checklist.some((item) => item.id === "launch" && item.status === "ready"));
  assert.ok(gate.checklist.some((item) => item.id === "room" && item.status === "ready"));
});

test("computeLaunchGate blocks launch without Apple container and stays fail-visible", () => {
  const gate = computeLaunchGate({ ...base, roomAvailable: false });
  assert.equal(gate.canLaunch, false);
  assert.match(gate.reason, /Apple container is not installed/);
  assert.equal(gate.nextAction, "install-container");
  assert.equal(gate.protectionState, "unavailable");
  assert.equal(gate.checklist.find((item) => item.id === "container")?.status, "blocked");
  assert.ok(!/protected launch ready/i.test(gate.reason));
});

test("computeLaunchGate blocks launch without workspace and points to choose-workspace", () => {
  const gate = computeLaunchGate({ ...base, workspace: "" });
  assert.equal(gate.canLaunch, false);
  assert.match(gate.reason, /workspace/i);
  assert.equal(gate.nextAction, "choose-workspace");
  assert.equal(gate.nextActionLabel, "Choose workspace folder");
});

test("computeLaunchGate blocks when Sandbox image is missing with build action", () => {
  const gate = computeLaunchGate({
    ...base,
    imageStatus: "missing",
    imageDetail: "CLI missing in alpine image",
  });
  assert.equal(gate.canLaunch, false);
  assert.match(gate.reason, /CLI missing|Sandbox image/i);
  assert.equal(gate.nextAction, "build-image");
  assert.equal(gate.checklist.find((item) => item.id === "image")?.status, "blocked");
});

test("computeLaunchGate treats intentional safe-base setup as blocked with build action (not broken-tool copy)", () => {
  const gate = computeLaunchGate({
    ...base,
    imageStatus: "setup",
    // No preflight detail yet — defaults must not look like a ready CLI or five failures.
    imageDetail: "",
  });
  assert.equal(gate.canLaunch, false);
  assert.equal(gate.nextAction, "build-image");
  assert.equal(gate.nextActionLabel, "Build AI Sandbox image");
  assert.equal(gate.protectionState, "setup");
  assert.match(gate.reason, /Safe base image/i);
  assert.equal(gate.reason, SAFE_BASE_LAUNCH_REASON);
  const image = gate.checklist.find((item) => item.id === "image");
  assert.equal(image?.status, "blocked");
  assert.equal(image?.action, "build-image");
  assert.equal(image?.detail, SAFE_BASE_IMAGE_DETAIL);
  assert.match(image?.detail || "", /intentionally has no AI CLIs/i);
  assert.match(image?.detail || "", /claude.*codex.*cursor-agent.*agy.*grok/i);
  assert.doesNotMatch(image?.detail || "", /Missing in image|five broken/i);
  // Auth stays hidden until image is ready.
  assert.ok(!gate.checklist.some((item) => item.id === "auth"));

  // Explicit detail from the renderer (baseImageSetupReadiness) is preserved.
  const withDetail = computeLaunchGate({
    ...base,
    imageStatus: "setup",
    imageDetail: SAFE_BASE_IMAGE_DETAIL,
  });
  assert.equal(withDetail.reason, SAFE_BASE_IMAGE_DETAIL);
  assert.equal(withDetail.nextAction, "build-image");
});

test("baseImageSetupReadiness is neutral setup language, not a per-tool failure", () => {
  const readiness = baseImageSetupReadiness();
  assert.equal(readiness.status, "setup");
  assert.match(readiness.label, /Sandbox image setup/i);
  assert.equal(readiness.detail, SAFE_BASE_IMAGE_DETAIL);
  assert.doesNotMatch(readiness.label, /Missing|broken|failed/i);
  assert.doesNotMatch(readiness.detail, /Missing in image/i);
});

test("shouldAutoPreflightOnHome skips base images and allows non-base", () => {
  assert.equal(shouldAutoPreflightOnHome("base"), false);
  assert.equal(shouldAutoPreflightOnHome("recommended"), true);
  assert.equal(shouldAutoPreflightOnHome("custom"), true);
});

test("computeLaunchGate treats image check as non-ready without claiming protection", () => {
  const gate = computeLaunchGate({ ...base, imageStatus: "checking" });
  assert.equal(gate.canLaunch, false);
  assert.match(gate.reason, /Waiting for Sandbox image check/);
  assert.equal(gate.nextAction, "wait-image");
  assert.equal(gate.protectionState, "setup");
});

test("auth is optional and does not block launch when image-ready", () => {
  const unsigned = computeLaunchGate({ ...base, authPersisted: false });
  assert.equal(unsigned.canLaunch, true);
  const authOptional = unsigned.checklist.find((item) => item.id === "auth");
  assert.equal(authOptional?.status, "optional");
  assert.equal(authOptional?.action, "sign-in");
  assert.equal(authOptional?.actionLabel, "Sign in to tool");
  const signed = computeLaunchGate({ ...base, authPersisted: true });
  assert.equal(signed.canLaunch, true);
  assert.equal(signed.checklist.find((item) => item.id === "auth")?.status, "ready");
  assert.equal(signed.checklist.find((item) => item.id === "auth")?.action, undefined);
});

test("auth checklist is hidden until image is ready (sign-in not yet executable)", () => {
  const missingImage = computeLaunchGate({
    ...base,
    imageStatus: "missing",
    imageDetail: "CLI missing in alpine image",
  });
  assert.equal(missingImage.canLaunch, false);
  assert.ok(!missingImage.checklist.some((item) => item.id === "auth"));

  const checking = computeLaunchGate({ ...base, imageStatus: "checking" });
  assert.equal(checking.canLaunch, false);
  assert.ok(!checking.checklist.some((item) => item.id === "auth"));

  const noWorkspace = computeLaunchGate({ ...base, workspace: "" });
  assert.equal(noWorkspace.canLaunch, false);
  assert.ok(!noWorkspace.checklist.some((item) => item.id === "auth"));

  const noTool = computeLaunchGate({ ...base, agentId: null, agentMapped: false });
  assert.equal(noTool.canLaunch, false);
  assert.ok(!noTool.checklist.some((item) => item.id === "auth"));
});

test("image prerequisite detail is precise when only workspace or only tool is missing", () => {
  const workspaceOnly = computeLaunchGate({
    ...base,
    workspace: "",
    // tool still selected and mapped
  });
  const imageWs = workspaceOnly.checklist.find((item) => item.id === "image");
  assert.equal(imageWs?.status, "blocked");
  assert.match(imageWs?.detail || "", /Choose a workspace before checking the image/);
  assert.doesNotMatch(imageWs?.detail || "", /and tool/i);

  const toolOnly = computeLaunchGate({
    ...base,
    agentId: null,
    agentMapped: false,
  });
  const imageTool = toolOnly.checklist.find((item) => item.id === "image");
  assert.equal(imageTool?.status, "blocked");
  assert.match(imageTool?.detail || "", /Choose a tool before checking the image/);
  assert.doesNotMatch(imageTool?.detail || "", /workspace/i);

  const both = computeLaunchGate({
    ...base,
    workspace: "",
    agentId: null,
    agentMapped: false,
  });
  const imageBoth = both.checklist.find((item) => item.id === "image");
  assert.equal(imageBoth?.status, "blocked");
  assert.match(imageBoth?.detail || "", /Choose workspace and tool before checking the image/);
});

test("blocked Launch checklist row explains reason without duplicating the action button", () => {
  const gate = computeLaunchGate({ ...base, workspace: "" });
  assert.equal(gate.canLaunch, false);
  assert.equal(gate.nextAction, "choose-workspace");
  assert.equal(gate.nextActionLabel, "Choose workspace folder");
  assert.equal(gate.reason, "Choose a workspace folder before launching.");

  const workspaceItem = gate.checklist.find((item) => item.id === "workspace");
  assert.equal(workspaceItem?.action, "choose-workspace");
  assert.equal(workspaceItem?.actionLabel, "Choose workspace folder");

  const launchItem = gate.checklist.find((item) => item.id === "launch");
  assert.equal(launchItem?.status, "blocked");
  assert.equal(launchItem?.detail, gate.reason);
  assert.equal(launchItem?.action, undefined);
  assert.equal(launchItem?.actionLabel, undefined);
});

test("roomEnabled=false blocks launch and offers open-project-settings action", () => {
  const gate = computeLaunchGate({ ...base, roomEnabled: false });
  assert.equal(gate.canLaunch, false);
  assert.match(gate.reason, /Sandbox is disabled/i);
  assert.equal(gate.nextAction, "open-project-settings");
  assert.equal(gate.nextActionLabel, "Open project settings");
  const roomItem = gate.checklist.find((item) => item.id === "room");
  assert.equal(roomItem?.status, "blocked");
  assert.equal(roomItem?.action, "open-project-settings");
  const launchItem = gate.checklist.find((item) => item.id === "launch");
  // Final Launch row keeps the exact disabled reason but no duplicate action button.
  assert.equal(launchItem?.detail, gate.reason);
  assert.equal(launchItem?.action, undefined);
  assert.equal(launchItem?.actionLabel, undefined);
  // Auth is not shown while Sandbox is off / sign-in is not executable.
  assert.ok(!gate.checklist.some((item) => item.id === "auth"));
});

test("ELECTRON_NAV targets only real renderer routes", () => {
  const allowed = new Set(RENDERER_ROUTES);
  for (const [key, route] of Object.entries(ELECTRON_NAV)) {
    assert.ok(allowed.has(route), `${key} → ${route} must be a renderer route`);
  }
  assert.equal(ELECTRON_NAV.openBumper, "projects");
  assert.equal(ELECTRON_NAV.activate, "projects");
  assert.equal(ELECTRON_NAV.launchProtected, undefined);
});

test("electron source uses ELECTRON_NAV and never invents launch routes", () => {
  const source = readFileSync(join(process.cwd(), "src", "electron.ts"), "utf8");
  assert.match(source, /ELECTRON_NAV\.openBumper/);
  assert.match(source, /from "\.\/electron-nav\.js"/);
  assert.doesNotMatch(source, /show\(["']launch["']\)/);
  assert.doesNotMatch(source, /show\(["']home["']\)/);
  assert.doesNotMatch(source, /Launch [Pp]rotected/);
  assert.match(source, /tray\.setToolTip\("Bumper"\)/);
});

test("app.html loads shared launch-gate and exposes control-plane routes", () => {
  const html = readFileSync(join(process.cwd(), "assets", "app.html"), "utf8");
  assert.match(html, /src="\/launch-gate\.js"/);
  for (const route of RENDERER_ROUTES) {
    assert.match(html, new RegExp(`data-route="${route}"`));
  }
  assert.doesNotMatch(html, /data-route="(home|launch)"/);
  assert.doesNotMatch(html, /id="launch-button"/);
});

test("app.js uses BumperLaunchGate helpers without Home Launch primary path", () => {
  const js = readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
  assert.match(js, /BumperLaunchGate/);
  assert.match(js, /baseImageSetupReadiness|shouldAutoPreflightOnHome/);
  assert.doesNotMatch(js, /function currentLaunchGate\(/);
  assert.doesNotMatch(js, /function renderReadinessChecklist\(/);
  assert.doesNotMatch(js, /function renderHome\(/);
  assert.doesNotMatch(js, /Apple container is not installed\. Protected launch cannot start\./);
  assert.doesNotMatch(js, /agents\.length \? Promise\.resolve\(agents\)/);
  assert.match(js, /api\("\/api\/agents"/);
  assert.doesNotMatch(js, /no other setup is needed/i);
  assert.match(js, /workspace/);
  assert.match(js, /Sandbox image/);
});

test("shared launch-gate module is the only computeLaunchGate implementation body", () => {
  const gateSrc = readFileSync(join(process.cwd(), "assets", "launch-gate.js"), "utf8");
  const appSrc = readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
  assert.match(gateSrc, /function computeLaunchGate\(/);
  assert.match(gateSrc, /open-project-settings/);
  // app.js may call through, but must not redefine the reason tree strings from the pure module.
  const reasonHits = (appSrc.match(/Sandbox is disabled for this project/g) || []).length;
  assert.equal(reasonHits, 0, "room-disabled reason must live only in launch-gate.js");
});
