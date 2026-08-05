/**
 * Phase 2 Folders — gated Apple container positive/negative proofs.
 *
 * Run with: BUMPER_VM_TESTS=1 npm test -- test/folders-vm.test.mjs
 * Skips cleanly when container is unavailable or the gate env is unset.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { roomSpecForContext } from "../dist/room/spec.js";
import { AppleContainerBackend } from "../dist/room/apple-container.js";
import { applyFolderDraft } from "../dist/folders.js";

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

function baseContext(overrides = {}) {
  return {
    mode: "read-write",
    readPaths: [],
    writePaths: [],
    room: {
      enabled: true,
      image: IMAGE,
      egress: "blocked",
      doors: [],
      workspaceShare: "whole",
      shareSubpaths: [],
      shareEntries: [],
      ...overrides.room,
    },
    ...overrides,
  };
}

test("VM: allowed read+write on whole RW workspace succeeds", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) {
    t.skip(`skipped: ${ready.reason}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "bumper-vm-rw-"));
  writeFileSync(join(root, "hello.txt"), "hello\n");
  try {
    const ctx = applyFolderDraft(baseContext(), {
      editor: "simple",
      workspaceAccess: "read-write",
      workspaceShare: "whole",
      entries: [],
      extraReadPaths: [],
      extraWritePaths: [],
    });
    const spec = roomSpecForContext(ctx, root);
    const result = await ready.backend.run(spec, [
      "/bin/sh",
      "-c",
      "test -f /workspace/hello.txt && echo ok-read > /workspace/write-proof.txt && cat /workspace/write-proof.txt",
    ]);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok-read/);
    assert.ok(existsSync(join(root, "write-proof.txt")), "host should see guest write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VM: read-only workspace allows read and rejects write", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) {
    t.skip(`skipped: ${ready.reason}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "bumper-vm-ro-"));
  writeFileSync(join(root, "hello.txt"), "hello\n");
  try {
    const ctx = applyFolderDraft(baseContext({ mode: "read-only" }), {
      editor: "simple",
      workspaceAccess: "read-only",
      workspaceShare: "whole",
      entries: [],
      extraReadPaths: [],
      extraWritePaths: [],
    });
    const spec = roomSpecForContext(ctx, root);
    const read = await ready.backend.run(spec, [
      "/bin/sh",
      "-c",
      "cat /workspace/hello.txt",
    ]);
    assert.equal(read.exitCode, 0, read.stderr || read.stdout);
    assert.match(read.stdout, /hello/);

    const write = await ready.backend.run(spec, [
      "/bin/sh",
      "-c",
      "echo should-fail > /workspace/blocked.txt",
    ]);
    assert.notEqual(write.exitCode, 0, "read-only write must fail");
    assert.ok(!existsSync(join(root, "blocked.txt")), "host must not gain a write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VM: unmounted outside / selected-absent path fails", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) {
    t.skip(`skipped: ${ready.reason}`);
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "bumper-vm-sel-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "secret"), { recursive: true });
  writeFileSync(join(root, "src", "ok.txt"), "visible\n");
  writeFileSync(join(root, "secret", "nope.txt"), "hidden\n");
  try {
    const ctx = applyFolderDraft(baseContext(), {
      editor: "advanced",
      workspaceAccess: "read-write",
      workspaceShare: "selected",
      entries: [{ path: "src", access: "read-write" }],
      extraReadPaths: [],
      extraWritePaths: [],
    });
    const spec = roomSpecForContext(ctx, root);
    const allowed = await ready.backend.run(spec, [
      "/bin/sh",
      "-c",
      "cat /workspace/src/ok.txt",
    ]);
    assert.equal(allowed.exitCode, 0, allowed.stderr || allowed.stdout);
    assert.match(allowed.stdout, /visible/);

    const missing = await ready.backend.run(spec, [
      "/bin/sh",
      "-c",
      "test ! -e /workspace/secret && test ! -e /workspace/secret/nope.txt",
    ]);
    assert.equal(missing.exitCode, 0, "unmounted secret path must be absent");

    const outside = await ready.backend.run(spec, [
      "/bin/sh",
      "-c",
      `test ! -e ${root}/secret/nope.txt`,
    ]);
    assert.equal(outside.exitCode, 0, "host absolute path must not be reachable in guest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
