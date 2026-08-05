import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "bumper-auth-"));
  process.env.BUMPER_STATE = join(dir, "state.json");
});
after(() => { delete process.env.BUMPER_STATE; rmSync(dir, { recursive: true, force: true }); });

test("room auth doors mount each CLI's config dir read-write and persist under state", async () => {
  const { roomAuthDoors, roomAuthPaths } = await import("../dist/room/auth.js");
  const doors = roomAuthDoors("claude");
  assert.ok(doors.length >= 1);
  assert.ok(doors.every((d) => d.access === "read-write"));
  assert.ok(doors.some((d) => d.roomPath === "/root/.claude"));
  assert.ok(doors.every((d) => d.hostPath.includes("room-auth")));
  assert.deepEqual(roomAuthPaths("claude"), ["/root/.claude"]);
});

test("credential presence needs a credential file, not just bytes in the tree", async () => {
  const { roomAuthDoors, roomAuthCredentialPresent } = await import("../dist/room/auth.js");
  assert.equal(roomAuthCredentialPresent("codex"), false);
  const [door] = roomAuthDoors("codex"); // creates the host dir
  // Bumper's own mkdir must not read as a login.
  assert.equal(roomAuthCredentialPresent("codex"), false);
  writeFileSync(join(door.hostPath, "some-cache.json"), "{}");
  assert.equal(roomAuthCredentialPresent("codex"), false, "unrelated files are not a login");
  writeFileSync(join(door.hostPath, "auth.json"), "{}");
  assert.equal(roomAuthCredentialPresent("codex"), true);
});

test("cursor persists multiple candidate config locations", async () => {
  const { roomAuthPaths, roomAuthEnv } = await import("../dist/room/auth.js");
  const paths = roomAuthPaths("cursor");
  assert.ok(paths.length >= 2);
  assert.ok(paths.includes("/root/.cursor"), "darwin-path settings dir");
  // Linux login is $XDG_CONFIG_HOME/cursor/auth.json (decompile of getAuthFilePath).
  // The door is the XDG *root*, not that dir: cursor-agent chmods its own config
  // dir, and a bind-mount root cannot be chmodded (virtiofs EPERM) — mounting
  // /root/.config/cursor made real login fail with
  // "Failed to store authentication tokens: EPERM ... chmod".
  const xdg = roomAuthEnv("cursor").XDG_CONFIG_HOME;
  assert.ok(xdg, "cursor needs XDG_CONFIG_HOME");
  assert.ok(paths.includes(xdg), "the XDG root must be the mounted door");
  assert.ok(!paths.includes(`${xdg}/cursor`), "never mount the dir cursor chmods");
  assert.ok(!paths.includes("/root/.config/cursor"), "regression: login cannot use this");
  assert.ok(!paths.includes("/root/.config/cursor-agent"), "older wrong name");
});

test("cursor p9verify synthetic auth.json mounts and is credential-present", async () => {
  const {
    roomAuthPaths,
    roomAuthDoors,
    hostAuthDir,
    roomAuthCredentialPresent,
  } = await import("../dist/room/auth.js");
  const { readFileSync, mkdirSync, writeFileSync: write, existsSync, unlinkSync } = await import("node:fs");

  const { roomAuthEnv } = await import("../dist/room/auth.js");
  const paths = roomAuthPaths("cursor");
  const xdg = roomAuthEnv("cursor").XDG_CONFIG_HOME;
  assert.ok(paths.includes(xdg));
  assert.ok(paths.includes("/root/.cursor"));
  assert.ok(!paths.includes("/root/.config/cursor-agent"));

  // Positive control: synthetic credential on named profile only (never default).
  const profile = "p9verify";
  const roomPath = xdg;
  assert.equal(roomAuthCredentialPresent("cursor", profile), false);

  const host = hostAuthDir("cursor", roomPath, profile);
  // Real landing spot: cursor writes $XDG_CONFIG_HOME/cursor/auth.json, i.e. one
  // level inside the door — writing at the door root would not match the marker.
  mkdirSync(join(host, "cursor"), { recursive: true });
  const marker = join(host, "cursor", "auth.json");
  write(marker, JSON.stringify({ synthetic: true }));

  const doors = roomAuthDoors("cursor", profile);
  const door = doors.find((d) => d.roomPath === roomPath);
  assert.ok(door, `door must target the XDG root ${roomPath}`);
  assert.equal(door.access, "read-write");
  assert.match(door.hostPath, /profiles[/\\]p9verify/);
  assert.equal(door.hostPath, host);

  // Positive control: written content is readable from the door host path.
  assert.equal(existsSync(join(door.hostPath, "cursor", "auth.json")), true);
  assert.match(readFileSync(join(door.hostPath, "cursor", "auth.json"), "utf8"), /"synthetic"\s*:\s*true/);

  assert.equal(roomAuthCredentialPresent("cursor", profile), true);
  assert.equal(roomAuthCredentialPresent("cursor", "empty-p9"), false);

  unlinkSync(marker);
  assert.equal(roomAuthCredentialPresent("cursor", profile), false);
});

test("antigravity door is ~/.gemini (measured), not antigravity path guesses", async () => {
  const { roomAuthPaths, roomAuthDoors } = await import("../dist/room/auth.js");
  const paths = roomAuthPaths("antigravity");
  assert.ok(paths.includes("/root/.gemini"));
  assert.ok(!paths.includes("/root/.antigravity"));
  assert.ok(!paths.includes("/root/.config/antigravity"));
  const doors = roomAuthDoors("antigravity", "p9verify");
  assert.ok(doors.some((d) => d.roomPath === "/root/.gemini" && d.hostPath.includes("p9verify")));
});

test("credential markers cover measured auth filenames", async () => {
  const {
    roomAuthDoors, roomAuthCredentialPresent, hostAuthDir,
  } = await import("../dist/room/auth.js");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const profile = "p9markers";

  // grok auth.json
  const grokHost = hostAuthDir("grok", "/root/.grok", profile);
  mkdirSync(grokHost, { recursive: true });
  assert.equal(roomAuthCredentialPresent("grok", profile), false);
  writeFileSync(join(grokHost, "auth.json"), JSON.stringify({ synthetic: true }));
  assert.equal(roomAuthCredentialPresent("grok", profile), true);

  // cursor auth.json lands one level under the XDG door: $XDG/cursor/auth.json
  const { roomAuthEnv: envFor } = await import("../dist/room/auth.js");
  const cursorHost = hostAuthDir("cursor", envFor("cursor").XDG_CONFIG_HOME, profile);
  mkdirSync(join(cursorHost, "cursor"), { recursive: true });
  writeFileSync(join(cursorHost, "cursor", "auth.json"), JSON.stringify({ synthetic: true }));
  assert.equal(roomAuthCredentialPresent("cursor", profile), true);

  // settings-only under .cursor is not a login
  const cursorDarwin = hostAuthDir("cursor", "/root/.cursor", profile);
  mkdirSync(cursorDarwin, { recursive: true });
  writeFileSync(join(cursorDarwin, "cli-config.json"), "{}");
  // still true because the XDG door holds cursor/auth.json
  assert.equal(roomAuthCredentialPresent("cursor", profile), true);

  void roomAuthDoors;
});

test("roomHistoryDoors isolate project history under project-agent-state", async () => {
  const { roomHistoryDoors, roomHistoryPaths } = await import("../dist/room/auth.js");
  const { roomSpecForAgentLaunch } = await import("../dist/room/launch.js");
  assert.ok(roomHistoryPaths("claude").includes("/root/.claude/projects"));
  const a = roomHistoryDoors("claude", "proj-a");
  const b = roomHistoryDoors("claude", "proj-b");
  assert.ok(a.some((d) => d.roomPath === "/root/.claude/projects"));
  assert.ok(a[0].hostPath.includes("project-agent-state"));
  assert.ok(a[0].hostPath.includes("proj-a") || a[0].hostPath.includes("proj_a"));
  assert.notEqual(a[0].hostPath, b[0].hostPath);

  const context = {
    mode: "read-write", readPaths: [], writePaths: [], loginProfiles: {},
    room: { enabled: true, image: "bumper/ai-room:latest", egress: "open", doors: [] },
  };
  const spec = roomSpecForAgentLaunch(context, "/tmp/ws", "claude", {
    mountAuth: true,
    projectName: "iso-a",
  });
  const authIdx = spec.doors.findIndex((d) => d.roomPath === "/root/.claude");
  const histIdx = spec.doors.findIndex((d) => d.roomPath === "/root/.claude/projects");
  assert.ok(authIdx >= 0 && histIdx > authIdx, "history overlay must follow account auth door");
});

test("roomAuthEnv relocates vendor config into the auth door", async () => {
  const { roomAuthEnv, roomAuthPaths } = await import("../dist/room/auth.js");
  assert.deepEqual(roomAuthEnv("claude"), { CLAUDE_CONFIG_DIR: "/root/.claude" });
  // cursor: XDG root must be a door so the dir it chmods sits *inside* a mount.
  assert.deepEqual(roomAuthEnv("cursor"), { XDG_CONFIG_HOME: "/root/.cursor-xdg" });
  assert.ok(roomAuthPaths("cursor").includes(roomAuthEnv("cursor").XDG_CONFIG_HOME));
  assert.deepEqual(roomAuthEnv("codex"), {});
  assert.deepEqual(roomAuthEnv("grok"), {});
});

test("roomSpecForAgentLaunch injects CLAUDE_CONFIG_DIR for claude only", async () => {
  const { roomSpecForAgentLaunch } = await import("../dist/room/launch.js");
  const context = {
    mode: "read-write",
    readPaths: [],
    writePaths: [],
    loginProfiles: {},
    room: { enabled: true, image: "bumper/ai-room:latest", egress: "open", doors: [] },
  };
  const claude = roomSpecForAgentLaunch(context, "/tmp/ws", "claude", { mountAuth: true });
  assert.equal(claude.env?.CLAUDE_CONFIG_DIR, "/root/.claude");
  assert.ok(claude.doors.some((d) => d.roomPath === "/root/.claude"));

  const grok = roomSpecForAgentLaunch(context, "/tmp/ws", "grok", { mountAuth: true });
  assert.equal(grok.env?.CLAUDE_CONFIG_DIR, undefined);
});

test("auth doors never overlay image PATH binary dirs (especially grok)", async () => {
  const {
    roomAuthDoors, roomAuthPaths, authDoorOverlapsBinaryInstall, ROOM_IMAGE_BIN_DIRS,
  } = await import("../dist/room/auth.js");

  assert.equal(authDoorOverlapsBinaryInstall("/root/.local/bin"), true);
  assert.equal(authDoorOverlapsBinaryInstall("/root/.local"), true); // parent of bin
  assert.equal(authDoorOverlapsBinaryInstall("/root/.local/bin/grok"), true);
  assert.equal(authDoorOverlapsBinaryInstall("/root/.grok"), false);
  assert.equal(authDoorOverlapsBinaryInstall("/root/.claude"), false);

  for (const agentId of ["claude", "codex", "cursor", "antigravity", "grok"]) {
    const paths = roomAuthPaths(agentId);
    assert.ok(paths.length >= 1, `${agentId} should declare auth paths`);
    for (const roomPath of paths) {
      assert.equal(
        authDoorOverlapsBinaryInstall(roomPath),
        false,
        `${agentId} auth path ${roomPath} must not hide PATH binaries`,
      );
      for (const bin of ROOM_IMAGE_BIN_DIRS) {
        assert.notEqual(roomPath, bin);
        assert.ok(!bin.startsWith(`${roomPath}/`) || roomPath === "/", `auth ${roomPath} must not parent ${bin}`);
      }
    }
    const doors = roomAuthDoors(agentId);
    assert.ok(doors.every((d) => d.hostPath.includes("room-auth")));
    assert.ok(doors.every((d) => !ROOM_IMAGE_BIN_DIRS.includes(d.roomPath)));
  }

  assert.deepEqual(roomAuthPaths("grok"), ["/root/.grok"]);
  assert.ok(!roomAuthPaths("grok").includes("/root/.local/bin"));
});

test("auth door host roots stay under room-auth, separate from image binary layout", async () => {
  const { roomAuthDoors } = await import("../dist/room/auth.js");
  const [door] = roomAuthDoors("grok");
  assert.match(door.hostPath, /room-auth[/\\]grok/);
  assert.equal(door.roomPath, "/root/.grok");
  assert.equal(door.access, "read-write");
  // Host persistence is Bumper state, not a bind of the image bin tree.
  assert.ok(!door.hostPath.includes(".local/bin"));
});

test("describeFolderDoors reports the folders actually mounted, not a fixed /workspace", async () => {
  const { describeFolderDoors } = await import("../dist/room/launch.js");
  // whole-workspace share
  assert.match(
    describeFolderDoors({ doors: [{ roomPath: "/workspace", access: "read-write" }] }),
    /\/workspace \(read \+ write\)/,
  );
  // read-only extra folder only — this is the config that used to be described as
  // "Workspace door: /workspace" while no /workspace mount existed at all.
  assert.match(
    describeFolderDoors({ doors: [{ roomPath: "/shared/docs", access: "read-only" }] }),
    /\/shared\/docs \(read only\)/,
  );
  // auth / history plumbing under /root is not a folder the user chose
  const withAuth = describeFolderDoors({
    doors: [
      { roomPath: "/workspace", access: "read-write" },
      { roomPath: "/root/.claude", access: "read-write" },
      { roomPath: "/root/.claude/projects", access: "read-write" },
    ],
  });
  assert.match(withAuth, /^\/workspace \(read \+ write\)$/);
  // nothing shared must say so rather than implying a workspace
  assert.match(describeFolderDoors({ doors: [] }), /No folder shared/);
});

test("no signin session kind remains (GUI sign-in withdrawn)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/sessions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /isSignin/, "dead signin branch must be gone");
  assert.doesNotMatch(src, /signinSpec/, "signin spec option must be gone");
  assert.doesNotMatch(src, /Workspace door: \/workspace/, "banner must not hardcode /workspace");
});
