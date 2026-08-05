/**
 * Phase 9 — synthetic auth-door proofs on Apple container.
 *
 * Run with: BUMPER_VM_TESTS=1 npm test -- test/phase9-auth-vm.test.mjs
 * Never touches default profile credentials (R1): only profiles/p9verify.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppleContainerBackend } from "../dist/room/apple-container.js";
import { hostAuthDir, roomAuthEnv } from "../dist/room/auth.js";
import { RECOMMENDED_ROOM_IMAGE } from "../dist/room/setup.js";

const CONTAINER = "/usr/local/bin/container";
const GATE = process.env.BUMPER_VM_TESTS === "1";
const IMAGE = process.env.BUMPER_VM_IMAGE || RECOMMENDED_ROOM_IMAGE;
const PROFILE = "p9verify";

async function containerReady() {
  if (!GATE) return { ok: false, reason: "BUMPER_VM_TESTS!=1" };
  if (process.platform !== "darwin") return { ok: false, reason: "not darwin" };
  if (!existsSync(CONTAINER)) return { ok: false, reason: "container CLI missing" };
  const backend = new AppleContainerBackend();
  const check = await backend.check();
  if (!check.usable) return { ok: false, reason: check.detail };
  return { ok: true, backend };
}

test("VM 9-1a: cursor login door mounts synthetic auth and persists writes", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) {
    t.skip(`skipped: ${ready.reason}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "bumper-p9-cursor-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  try {
    // Take the path from the implementation — a hand-written literal drifts silently
    // (this test used to pin /root/.config/cursor, which login cannot actually use).
    const { roomAuthPaths, roomAuthEnv } = await import("../dist/room/auth.js");
    const roomPath = roomAuthEnv("cursor").XDG_CONFIG_HOME;
    assert.ok(roomPath && roomAuthPaths("cursor").includes(roomPath));
    const host = hostAuthDir("cursor", roomPath, PROFILE);
    mkdirSync(host, { recursive: true });
    // Positive control: synthetic credential present before launch.
    writeFileSync(join(host, "auth.json"), JSON.stringify({ synthetic: true, tool: "cursor" }));

    const spec = {
      image: IMAGE,
      doors: [{ hostPath: host, roomPath, access: "read-write" }],
      egress: { mode: "blocked" },
      workdir: "/root",
      dropCapabilities: true,
    };

    // R2 (2): room sees the synthetic file at the expected path.
    const see = await ready.backend.run(spec, [
      "/bin/sh", "-c",
      `test -f ${roomPath}/auth.json && cat ${roomPath}/auth.json && echo CURSOR_DOOR_OK`,
    ]);
    assert.equal(see.exitCode, 0, see.stderr || see.stdout);
    assert.match(see.stdout, /"synthetic"\s*:\s*true/);
    assert.match(see.stdout, /CURSOR_DOOR_OK/);

    // R2 (3): guest write persists on host and survives a second run.
    const write = await ready.backend.run(spec, [
      "/bin/sh", "-c",
      `echo persist-cursor > ${roomPath}/p9-persist.txt`,
    ]);
    assert.equal(write.exitCode, 0, write.stderr || write.stdout);
    assert.equal(readFileSync(join(host, "p9-persist.txt"), "utf8").trim(), "persist-cursor");

    const again = await ready.backend.run(spec, [
      "/bin/sh", "-c",
      `test -f ${roomPath}/p9-persist.txt && cat ${roomPath}/p9-persist.txt`,
    ]);
    assert.equal(again.exitCode, 0, again.stderr || again.stdout);
    assert.match(again.stdout, /persist-cursor/);
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("VM 9-4: history overlay isolates projects while credential stays on account door", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) {
    t.skip(`skipped: ${ready.reason}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "bumper-p9-iso-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  try {
    const { roomAuthDoors, roomHistoryDoors } = await import("../dist/room/auth.js");
    const accountDoors = roomAuthDoors("claude", PROFILE);
    const histA = roomHistoryDoors("claude", "project-a");
    const histB = roomHistoryDoors("claude", "project-b");
    const account = accountDoors.find((d) => d.roomPath === "/root/.claude");
    assert.ok(account);
    writeFileSync(join(account.hostPath, ".credentials.json"), JSON.stringify({ synthetic: true }));
    const histDoorA = histA.find((d) => d.roomPath === "/root/.claude/projects");
    const histDoorB = histB.find((d) => d.roomPath === "/root/.claude/projects");
    assert.ok(histDoorA && histDoorB);
    writeFileSync(join(histDoorA.hostPath, "from-a.txt"), "secret-a\n");

    const specA = {
      image: IMAGE,
      doors: [account, histDoorA],
      egress: { mode: "blocked" },
      workdir: "/root",
      dropCapabilities: true,
    };
    const seeA = await ready.backend.run(specA, [
      "/bin/sh", "-c",
      "test -f /root/.claude/.credentials.json && cat /root/.claude/projects/from-a.txt && echo ISO_A_OK",
    ]);
    assert.equal(seeA.exitCode, 0, seeA.stderr || seeA.stdout);
    assert.match(seeA.stdout, /secret-a/);
    assert.match(seeA.stdout, /ISO_A_OK/);

    // Project B must not see Project A history; credential still present.
    const specB = {
      image: IMAGE,
      doors: [account, histDoorB],
      egress: { mode: "blocked" },
      workdir: "/root",
      dropCapabilities: true,
    };
    const seeB = await ready.backend.run(specB, [
      "/bin/sh", "-c",
      "test -f /root/.claude/.credentials.json && test ! -f /root/.claude/projects/from-a.txt && echo ISO_B_OK",
    ]);
    assert.equal(seeB.exitCode, 0, seeB.stderr || seeB.stdout);
    assert.match(seeB.stdout, /ISO_B_OK/);
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("VM 9-1b: CLAUDE_CONFIG_DIR puts .claude.json inside auth door and persists", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) {
    t.skip(`skipped: ${ready.reason}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "bumper-p9-claude-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  try {
    const roomPath = "/root/.claude";
    const host = hostAuthDir("claude", roomPath, PROFILE);
    mkdirSync(host, { recursive: true });
    // Positive control: synthetic credential under the door.
    writeFileSync(join(host, ".credentials.json"), JSON.stringify({ synthetic: true, tool: "claude" }));

    const env = roomAuthEnv("claude");
    assert.equal(env.CLAUDE_CONFIG_DIR, "/root/.claude");

    const spec = {
      image: IMAGE,
      doors: [{ hostPath: host, roomPath, access: "read-write" }],
      egress: { mode: "open" }, // doctor may touch network; image has claude
      workdir: "/root",
      dropCapabilities: true,
      env,
    };

    // R2 (2): synthetic credential visible; CLAUDE_CONFIG_DIR active.
    const see = await ready.backend.run(spec, [
      "/bin/sh", "-c",
      [
        "test -f /root/.claude/.credentials.json",
        "grep -q synthetic /root/.claude/.credentials.json",
        "test \"$CLAUDE_CONFIG_DIR\" = /root/.claude",
        "echo CLAUDE_DOOR_OK",
      ].join(" && "),
    ]);
    assert.equal(see.exitCode, 0, see.stderr || see.stdout);
    assert.match(see.stdout, /CLAUDE_DOOR_OK/);

    // Let claude write config under CLAUDE_CONFIG_DIR (no OAuth).
    const doctor = await ready.backend.run(spec, [
      "/bin/sh", "-c",
      "claude doctor >/tmp/doctor.out 2>&1 || true; " +
        "test -f /root/.claude/.claude.json && " +
        "test ! -e /root/.claude.json && " +
        "echo CLAUDE_JSON_IN_DOOR",
    ]);
    assert.equal(doctor.exitCode, 0, doctor.stderr || doctor.stdout);
    assert.match(doctor.stdout, /CLAUDE_JSON_IN_DOOR/);
    assert.ok(existsSync(join(host, ".claude.json")), "host must see .claude.json under door");
    assert.match(readFileSync(join(host, ".claude.json"), "utf8"), /./);

    // R2 (3): second boot still has .claude.json (persistence).
    const again = await ready.backend.run(spec, [
      "/bin/sh", "-c",
      "test -f /root/.claude/.claude.json && echo CLAUDE_PERSIST_OK",
    ]);
    assert.equal(again.exitCode, 0, again.stderr || again.stdout);
    assert.match(again.stdout, /CLAUDE_PERSIST_OK/);
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * VM 9-1a regression (2026-07-25): a bind-mount ROOT cannot be chmodded.
 *
 * cursor-agent chmods its own config dir before writing auth.json, so mounting
 * that exact dir made real login fail:
 *   ✗ Login failed
 *   Failed to store authentication tokens: EPERM ... chmod '/root/.config/cursor'
 *
 * The door therefore has to be one level up, with XDG_CONFIG_HOME pointing at it,
 * so cursor creates (and can chmod) the dir itself. This test pins both halves:
 * the platform constraint AND that our door/env pair satisfies it.
 */
test("VM 9-1a: cursor can chmod its own config dir under the auth door", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) {
    t.skip(`skipped: ${ready.reason}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "bumper-p9-chmod-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  try {
    const { roomAuthPaths, roomAuthEnv } = await import("../dist/room/auth.js");
    const env = roomAuthEnv("cursor");
    const xdg = env.XDG_CONFIG_HOME;
    assert.ok(xdg, "cursor needs XDG_CONFIG_HOME so its config dir is not a mount root");
    assert.ok(
      roomAuthPaths("cursor").includes(xdg),
      `XDG_CONFIG_HOME (${xdg}) must itself be a mounted auth door`,
    );
    assert.ok(
      !roomAuthPaths("cursor").includes(`${xdg}/cursor`),
      "the dir cursor chmods must NOT be the mount root",
    );

    const host = hostAuthDir("cursor", xdg, PROFILE);
    mkdirSync(host, { recursive: true });
    const spec = {
      image: IMAGE,
      doors: [{ hostPath: host, roomPath: xdg, access: "read-write" }],
      egress: { mode: "blocked" },
      workdir: "/root",
      dropCapabilities: true,
      env,
    };

    // NEGATIVE CONTROL — the platform really does refuse chmod on a mount root,
    // so the assertion below is not vacuous.
    const onRoot = await ready.backend.run(spec, [
      "/bin/sh", "-c", `chmod 700 ${xdg} 2>&1; echo "exit=$?"`,
    ]);
    assert.match(onRoot.stdout, /exit=1|not permitted/i, "chmod on a mount root must fail");

    // POSITIVE — exactly what cursor-agent does before storing tokens.
    const asCursor = await ready.backend.run(spec, [
      "/bin/sh", "-c",
      `mkdir -p "$XDG_CONFIG_HOME/cursor" && chmod 700 "$XDG_CONFIG_HOME/cursor" ` +
        `&& printf '{}' > "$XDG_CONFIG_HOME/cursor/auth.json" && echo CURSOR_STORE_OK`,
    ]);
    assert.equal(asCursor.exitCode, 0, asCursor.stderr || asCursor.stdout);
    assert.match(asCursor.stdout, /CURSOR_STORE_OK/);
    assert.ok(existsSync(join(host, "cursor", "auth.json")), "auth.json must persist on the host");
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});
