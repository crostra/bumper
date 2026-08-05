/**
 * Phase 4A Network — gated Apple container Off / Open proofs.
 *
 * Run with: BUMPER_VM_TESTS=1 npm test -- test/network-vm.test.mjs
 * Skips cleanly when container is unavailable or the gate env is unset.
 *
 * Phase 4B Selected services is NOT covered here — forced Bumper gateway +
 * direct-route closed is not available on Apple container yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { roomSpecForContext } from "../dist/room/spec.js";
import { AppleContainerBackend, buildRunArgs } from "../dist/room/apple-container.js";

const CONTAINER = "/usr/local/bin/container";
const GATE = process.env.BUMPER_VM_TESTS === "1";
const IMAGE = process.env.BUMPER_VM_IMAGE || "docker.io/library/alpine:3.20";

async function containerReady() {
  if (!GATE) return { ok: false, reason: "BUMPER_VM_TESTS!=1" };
  if (process.platform !== "darwin") return { ok: false, reason: "not darwin" };
  if (!existsSync(CONTAINER)) return { ok: false, reason: "container CLI missing" };
  const backend = new AppleContainerBackend();
  const check = await backend.check();
  if (!check.usable) return { ok: false, reason: check.detail };
  return { ok: true, backend };
}

function context(egress) {
  return {
    mode: "read-write",
    readPaths: [],
    writePaths: [],
    room: {
      enabled: true,
      image: IMAGE,
      egress,
      doors: [],
      workspaceShare: "whole",
      shareSubpaths: [],
      shareEntries: [],
    },
  };
}

test("unit: Off RoomSpec maps to --network none; Open does not", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-net-spec-"));
  try {
    const blocked = roomSpecForContext(context("blocked"), root);
    const open = roomSpecForContext(context("open"), root);
    assert.deepEqual(blocked.egress, { mode: "blocked" });
    assert.deepEqual(open.egress, { mode: "open" });
    const blockedArgs = buildRunArgs(blocked, ["/bin/true"]);
    const openArgs = buildRunArgs(open, ["/bin/true"]);
    assert.ok(blockedArgs.includes("--network") && blockedArgs.includes("none"));
    assert.equal(openArgs.indexOf("--network"), -1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VM: Off blocks direct Internet and DNS; loopback remains", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) {
    t.skip(`skipped: ${ready.reason}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "bumper-vm-net-off-"));
  try {
    const spec = roomSpecForContext(context("blocked"), root);
    const result = await ready.backend.run(spec, [
      "/bin/sh",
      "-c",
      [
        "set +e",
        "lo=$(cat /sys/class/net/lo/operstate 2>/dev/null || echo missing)",
        "echo LOOPBACK:$lo",
        "busybox wget -T 2 -q -O /dev/null http://1.1.1.1 2>/tmp/wget-ip.err",
        "echo WGET_IP_EC:$?",
        "busybox nslookup example.com 2>/tmp/dns.err >/tmp/dns.out",
        "echo DNS_EC:$?",
        "exit 0",
      ].join("; "),
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /LOOPBACK:(up|unknown)/);
    assert.match(result.stdout, /WGET_IP_EC:[1-9]/);
    assert.match(result.stdout, /DNS_EC:[1-9]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VM: Open allows unrestricted outbound (not a protected allowlist)", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) {
    t.skip(`skipped: ${ready.reason}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "bumper-vm-net-open-"));
  try {
    const spec = roomSpecForContext(context("open"), root);
    const result = await ready.backend.run(spec, [
      "/bin/sh",
      "-c",
      [
        "set +e",
        "if busybox nc -z -w 8 1.1.1.1 80 >/dev/null 2>&1; then",
        "  echo OPEN_OK:tcp",
        "elif busybox wget -T 8 -q -O /dev/null http://example.com >/dev/null 2>&1; then",
        "  echo OPEN_OK:http",
        "else",
        "  echo OPEN_FAIL",
        "fi",
        "exit 0",
      ].join("\n"),
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OPEN_OK:(tcp|http)/, `Open egress must reach the Internet: ${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
