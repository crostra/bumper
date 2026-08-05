import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { roomSpecForContext } from "../dist/room/spec.js";
import { buildRunArgs } from "../dist/room/apple-container.js";
import { roomExecutablePreflight, roomPreflightFailureDetail, roomPreflightSuccessDetail } from "../dist/room/preflight.js";
import { roomLaunchAuthDoors, roomSpecForAgentLaunch } from "../dist/room/launch.js";
import {
  recommendedRoomDockerfile,
  RECOMMENDED_ROOM_IMAGE,
  RECOMMENDED_ROOM_RECIPE,
  RECOMMENDED_ROOM_RECIPE_LABEL,
  classifyBuildFailure,
  describeImageSource,
  recipeFromImageInspect,
  authOverlayProbeScript,
} from "../dist/room/setup.js";

test("roomSpecForContext turns project policy into explicit doors and egress", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-room-spec-"));
  const workspace = join(root, "workspace");
  const docs = join(root, "docs");
  const out = join(root, "out");
  mkdirSync(workspace);
  mkdirSync(docs);
  mkdirSync(out);
  try {
    const spec = roomSpecForContext({
      mode: "read-only",
      readPaths: [docs],
      writePaths: [out],
      room: {
        enabled: true,
        image: "docker.io/library/alpine:3.20",
        egress: "blocked",
        doors: [{ hostPath: docs, roomPath: "/manuals", access: "read-only" }],
      },
    }, workspace);
    assert.equal(spec.image, "docker.io/library/alpine:3.20");
    assert.deepEqual(spec.egress, { mode: "blocked" });
    assert.ok(spec.doors.some((door) => door.hostPath === workspace && door.roomPath === "/workspace" && door.access === "read-only"));
    assert.ok(spec.doors.some((door) => door.hostPath === out && door.access === "read-write"));
    assert.ok(spec.doors.some((door) => door.hostPath === docs && door.roomPath === "/manuals"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selected workspace sharing mounts only listed sub-folders, not the whole workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-room-selected-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, "docs", "public"), { recursive: true });
  try {
    const spec = roomSpecForContext({
      mode: "read-write",
      readPaths: [], writePaths: [],
      room: {
        enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked",
        workspaceShare: "selected", shareSubpaths: ["src", "docs/public", "../escape", ""], doors: [],
      },
    }, workspace);
    // The whole-workspace door must be ABSENT.
    assert.ok(!spec.doors.some((door) => door.roomPath === "/workspace"));
    // Only the two valid sub-folders are mounted, at nested room paths.
    assert.ok(spec.doors.some((door) => door.roomPath === "/workspace/src" && door.hostPath === join(workspace, "src")));
    assert.ok(spec.doors.some((door) => door.roomPath === "/workspace/docs/public"));
    // The "../escape" traversal attempt is dropped.
    assert.ok(!spec.doors.some((door) => door.roomPath.includes("escape")));
    assert.equal(spec.doors.filter((d) => d.roomPath.startsWith("/workspace")).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("allowlist egress resolves templates and custom hosts into the room spec", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-room-egress-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const spec = roomSpecForContext({
      mode: "read-write", readPaths: [], writePaths: [],
      room: {
        enabled: true, image: "docker.io/library/alpine:3.20", egress: "allowlist",
        egressTemplates: ["anthropic"], egressHosts: ["api.internal.example"], doors: [],
      },
    }, workspace);
    assert.equal(spec.egress.mode, "allowlist");
    assert.ok(spec.egress.hosts.includes("api.anthropic.com"));
    assert.ok(spec.egress.hosts.includes("api.internal.example"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Apple container run args fail closed for blocked egress and support TTY", () => {
  const args = buildRunArgs({
    image: "docker.io/library/alpine:3.20",
    doors: [{ hostPath: "/tmp", roomPath: "/workspace", access: "read-only" }],
    egress: { mode: "blocked" },
    workdir: "/workspace",
    dropCapabilities: true,
  }, ["/bin/sh"], true);
  assert.deepEqual(args.slice(0, 4), ["run", "--rm", "--interactive", "--tty"]);
  assert.ok(args.includes("--cap-drop"));
  assert.ok(args.includes("--network"));
  assert.ok(args.includes("none"));
  assert.ok(args.some((arg) => arg.includes("type=bind,source=/tmp,target=/workspace,readonly")));
});

test("Apple container open egress omits --network none (unrestricted)", () => {
  const args = buildRunArgs({
    image: "docker.io/library/alpine:3.20",
    doors: [{ hostPath: "/tmp", roomPath: "/workspace", access: "read-write" }],
    egress: { mode: "open" },
    workdir: "/workspace",
  }, ["/bin/true"]);
  const networkIdx = args.indexOf("--network");
  assert.equal(networkIdx, -1, "open egress must not pass --network none");
  assert.ok(!args.includes("none"));
});

test("Sandbox executable preflight checks the target CLI before launch", () => {
  const preflight = roomExecutablePreflight(["cursor-agent"]);
  assert.equal(preflight.executable, "cursor-agent");
  assert.equal(preflight.command[0], "/bin/sh");
  assert.equal(preflight.command[1], "-c");
  assert.match(preflight.command[2], /command -v/);
  assert.match(preflight.command[2], /readlink/); // broken symlink after auth overlay
  assert.deepEqual(preflight.command.slice(3), ["bumper-preflight", "cursor-agent"]);

  const failure = roomPreflightFailureDetail("Cursor Agent", ["cursor-agent"], "docker.io/library/alpine:3.20", {
    exitCode: 127, stdout: "", stderr: "",
  });
  assert.match(failure, /Cursor Agent/);
  assert.match(failure, /cursor-agent/);
  assert.match(failure, /Sandbox image/);

  const success = roomPreflightSuccessDetail("Cursor Agent", "cursor-agent", "company/room-cursor:latest");
  assert.match(success, /ready/);
  assert.match(success, /company\/room-cursor:latest/);
});

test("agent launch spec includes auth doors so preflight cannot skip them", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-room-launch-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  try {
    const context = {
      mode: "read-write",
      readPaths: [],
      writePaths: [],
      room: {
        enabled: true,
        image: "bumper/ai-room:latest",
        egress: "blocked",
        doors: [],
      },
    };
    const withoutAuth = roomSpecForContext(context, workspace);
    const withAuth = roomSpecForAgentLaunch(context, workspace, "grok", { mountAuth: true });
    assert.ok(withAuth.doors.length > withoutAuth.doors.length, "auth doors must be added for agent launch");
    assert.ok(withAuth.doors.some((d) => d.roomPath === "/root/.grok"), "grok auth door required on launch/preflight path");
    assert.ok(withAuth.doors.every((d) => d.roomPath !== "/root/.local/bin"), "must not mount over PATH bin dir");
    assert.ok(withAuth.doors.some((d) => d.roomPath === "/workspace"));

    const shellSpec = roomSpecForAgentLaunch(context, workspace, "room-shell", { mountAuth: true });
    assert.ok(!shellSpec.doors.some((d) => d.roomPath === "/root/.grok"), "room-shell has no vendor auth door");

    const noAuth = roomSpecForAgentLaunch(context, workspace, "grok", { mountAuth: false });
    assert.ok(!noAuth.doors.some((d) => d.roomPath === "/root/.grok"));

    const authOnly = roomLaunchAuthDoors("grok", { mountAuth: true });
    assert.ok(authOnly.some((d) => d.roomPath === "/root/.grok" && d.hostPath.includes("room-auth")));
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("preflight and launch share the same auth mount roomPaths for every agent", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-room-preflight-mount-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  try {
    const context = {
      mode: "read-write", readPaths: [], writePaths: [],
      room: { enabled: true, image: "bumper/ai-room:latest", egress: "open", doors: [] },
    };
    for (const agentId of ["claude", "codex", "cursor", "antigravity", "grok"]) {
      const preflightSpec = roomSpecForAgentLaunch(context, workspace, agentId, { mountAuth: true });
      const launchAuth = roomLaunchAuthDoors(agentId, { mountAuth: true });
      for (const door of launchAuth) {
        assert.ok(
          preflightSpec.doors.some((d) => d.roomPath === door.roomPath && d.hostPath === door.hostPath),
          `${agentId}: preflight spec missing auth door ${door.roomPath}`,
        );
      }
    }
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("recommended Sandbox image recipe installs every supported AI CLI", () => {
  const dockerfile = recommendedRoomDockerfile();
  assert.equal(RECOMMENDED_ROOM_IMAGE, "bumper/ai-room:latest");
  for (const expected of ["@anthropic-ai/claude-code", "@openai/codex", "cursor.com/install", "antigravity.google/cli/install.sh", "x.ai/cli/install.sh"]) {
    assert.match(dockerfile, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const executable of ["claude", "codex", "cursor-agent", "agy", "grok"]) {
    assert.match(dockerfile, new RegExp(`command -v ${executable}|test -x .*${executable}`));
  }
  // Auth/binary separation: materialize real PATH bins so /root/.grok overlay cannot hide grok.
  assert.match(dockerfile, /materialize_path_bin/);
  assert.match(dockerfile, /refusing PATH symlink into auth overlay tree/);
  assert.match(dockerfile, /grok must not remain a symlink into \/root\/\.grok/);
  assert.match(dockerfile, /PATH="\/root\/\.local\/bin/);
  assert.match(dockerfile, new RegExp(`${RECOMMENDED_ROOM_RECIPE_LABEL}="${RECOMMENDED_ROOM_RECIPE}"`));
});

test("recipeFromImageInspect reads Bumper recipe label from inspect JSON", () => {
  const withLabel = JSON.stringify([{
    config: { config: { Labels: { [RECOMMENDED_ROOM_RECIPE_LABEL]: RECOMMENDED_ROOM_RECIPE } } },
  }]);
  assert.equal(recipeFromImageInspect(withLabel), RECOMMENDED_ROOM_RECIPE);

  const fromHistory = JSON.stringify([{
    variants: [{ config: { history: [{ created_by: "RUN materialize_path_bin grok" }] } }],
  }]);
  assert.equal(recipeFromImageInspect(fromHistory), RECOMMENDED_ROOM_RECIPE);

  assert.equal(recipeFromImageInspect("[]"), undefined);
  assert.equal(recipeFromImageInspect("not-json"), undefined);
});

test("auth overlay probe script rejects PATH symlinks into auth trees", () => {
  const script = authOverlayProbeScript();
  assert.match(script, /STALE_SYMLINK/);
  assert.match(script, /\/root\/\.grok\/\*/);
  assert.match(script, /AUTH_OVERLAY_OK/);
  assert.match(script, /cursor-agent/);
  assert.match(script, /\bagy\b/);
  assert.match(script, /\bgrok\b/);
});

test("build failure classification names the tool whose install died", () => {
  const cursorLog = [
    "#5 RUN npm install -g @anthropic-ai/claude-code @openai/codex",
    "#5 DONE",
    "#6 RUN curl https://cursor.com/install -fsS | bash",
    "#6 ERROR: process did not complete successfully: exit code 1",
  ].join("\n");
  assert.equal(classifyBuildFailure(cursorLog).failedTool, "Cursor Agent");

  const npmLog = [
    "#4 RUN apt-get update && apt-get install -y bash",
    "#4 DONE",
    "#5 RUN npm install -g @anthropic-ai/claude-code @openai/codex",
    "#5 ERROR: npm ERR! network",
  ].join("\n");
  assert.equal(classifyBuildFailure(npmLog).failedTool, "Claude Code & Codex (npm)");

  assert.equal(classifyBuildFailure("nothing recognizable here"), undefined);
});

test("image source description distinguishes recommended, base, and custom images", () => {
  assert.equal(describeImageSource(RECOMMENDED_ROOM_IMAGE).kind, "recommended");
  assert.equal(describeImageSource("docker.io/library/alpine:3.20").kind, "base");
  assert.match(describeImageSource("docker.io/library/alpine:3.20").label, /no AI CLIs/i);
  assert.equal(describeImageSource("alpine:3.20").kind, "base");
  assert.equal(describeImageSource("ubuntu:24.04").kind, "base");
  assert.equal(describeImageSource("registry.company.com/team/room:1.2").kind, "custom");
});
