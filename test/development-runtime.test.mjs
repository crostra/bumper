import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import {
  createDevelopmentSessionLease,
  listDevelopmentSessionLeases,
  readDevelopmentSessionLease,
  removeDevelopmentSessionLease,
  updateDevelopmentSessionControl,
} from "../dist/development-session-lease.js";
import { PreviewBroker } from "../dist/preview-broker.js";
import {
  buildDockerEngineRunArgs,
  dockerWrapperSource,
  DOCKER_ENGINE_IMAGE,
} from "../dist/docker-broker.js";
import { buildRunArgs } from "../dist/room/apple-container.js";

function waitFor(check, timeoutMs = 4_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(poll, 30);
    };
    poll();
  });
}

test("development lease is host-controlled, live, and independently toggles Preview/Docker", () => {
  const dir = mkdtempSync(join(tmpdir(), "bumper-dev-lease-"));
  const before = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(dir, "state.json");
  const id = "dev-session-12345678";
  try {
    createDevelopmentSessionLease({
      id,
      pid: process.pid,
      projectName: "Demo",
      agentId: "claude",
      agentName: "Claude",
      previewEnabled: true,
      dockerEnabled: true,
    });
    const initial = readDevelopmentSessionLease(id);
    assert.equal(initial?.live, true);
    assert.equal(initial?.control.previewEnabled, true);
    assert.equal(initial?.control.dockerEnabled, true);
    updateDevelopmentSessionControl(id, { previewEnabled: false });
    const changed = readDevelopmentSessionLease(id);
    assert.equal(changed?.control.previewEnabled, false);
    assert.equal(changed?.control.dockerEnabled, true);
    assert.equal(listDevelopmentSessionLeases().length, 1);
    removeDevelopmentSessionLease(id);
    assert.equal(readDevelopmentSessionLease(id), undefined);
  } finally {
    if (before === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RoomSpec publishes a private Unix socket without weakening Network Off", () => {
  const args = buildRunArgs({
    image: "node:22",
    doors: [],
    egress: { mode: "blocked" },
    publishSockets: [{ hostPath: "/tmp/host-preview.sock", roomPath: "/tmp/room-preview.sock" }],
  }, ["true"]);
  assert.deepEqual(args.slice(args.indexOf("--publish-socket"), args.indexOf("--publish-socket") + 2), [
    "--publish-socket", "/tmp/host-preview.sock:/tmp/room-preview.sock",
  ]);
  assert.deepEqual(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2), ["--network", "none"]);
  assert.equal(args.includes("--publish"), false);
});

test("Preview broker maps only reported Sandbox ports and closes them immediately when toggled Off", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-preview-unit-"));
  const before = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  const id = "preview-session-123456";
  createDevelopmentSessionLease({
    id,
    pid: process.pid,
    projectName: "Demo",
    agentId: "claude",
    agentName: "Claude",
    previewEnabled: true,
    dockerEnabled: false,
  });
  const broker = new PreviewBroker(join(root, "broker"), id);
  broker.setup(["sh"]);
  mkdirSync(broker.roomDir, { recursive: true });
  writeFileSync(join(broker.roomDir, "preview-ports.json"), JSON.stringify({
    ports: [3000, 80, 3000, 70000],
    at: new Date().toISOString(),
  }));
  const roomRelay = createServer((socket) => {
    let header = "";
    socket.on("data", (chunk) => {
      header += chunk.toString();
      if (!header.includes("\n")) return;
      assert.match(header, /^PORT 3000\n/);
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\npreview-ok");
    });
  });
  await new Promise((resolve, reject) => {
    roomRelay.once("error", reject);
    roomRelay.listen(broker.hostSocketPath, resolve);
  });
  t.after(async () => {
    await broker.stop();
    await new Promise((resolve) => roomRelay.close(resolve));
    removeDevelopmentSessionLease(id);
    if (before === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = before;
    rmSync(root, { recursive: true, force: true });
  });

  broker.start();
  const mapping = await waitFor(() => readDevelopmentSessionLease(id)?.runtime.previewPorts[0]);
  assert.equal(mapping.roomPort, 3000);
  assert.match(mapping.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await (await fetch(mapping.url)).text(), "preview-ok");

  updateDevelopmentSessionControl(id, { previewEnabled: false });
  await broker.reconcile();
  assert.deepEqual(readDevelopmentSessionLease(id)?.runtime.previewPorts, []);
  await assert.rejects(() => fetch(mapping.url));
});

test("Docker Engine Sandbox argv preserves exact Project Doors and never mounts a host Docker socket", () => {
  const args = buildDockerEngineRunArgs({
    engineName: "bumper-docker-test",
    workspaceDoors: [
      { hostPath: "/Users/me/project/src", roomPath: "/workspace/src", access: "read-write" },
      { hostPath: "/Users/me/project/vendor", roomPath: "/workspace/vendor", access: "read-only" },
    ],
    egress: { mode: "blocked" },
  });
  const joined = args.join(" ");
  assert.match(joined, /source=\/Users\/me\/project\/src,target=\/workspace\/src(?!,readonly)/);
  assert.match(joined, /source=\/Users\/me\/project\/vendor,target=\/workspace\/vendor,readonly/);
  assert.match(joined, /--network none/);
  assert.match(joined, /--cap-add ALL/);
  assert.match(joined, new RegExp(DOCKER_ENGINE_IMAGE.replaceAll(".", "\\.")));
  assert.doesNotMatch(joined, /docker\\.sock.*source=|source=.*docker\\.sock|\/var\/run\/docker\\.sock:/);
  assert.match(dockerWrapperSource(), /BUMPER_DOCKER_REQUESTS/);
  assert.doesNotMatch(dockerWrapperSource(), /DOCKER_HOST|docker\\.sock/);
});

test("Docker allowlist fails closed without the prepared host-only network", () => {
  assert.throws(() => buildDockerEngineRunArgs({
    engineName: "bumper-docker-test",
    workspaceDoors: [],
    egress: { mode: "allowlist", hosts: ["example.com"] },
  }), /host-only network/);
});
