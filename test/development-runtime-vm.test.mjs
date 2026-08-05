import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDevelopmentSessionLease,
  heartbeatDevelopmentSessionLease,
  readDevelopmentSessionLease,
  removeDevelopmentSessionLease,
  updateDevelopmentSessionControl,
} from "../dist/development-session-lease.js";
import { PreviewBroker, withPreviewParts } from "../dist/preview-broker.js";
import { DockerBroker } from "../dist/docker-broker.js";
import { buildRunArgs } from "../dist/room/apple-container.js";

const exec = promisify(execFile);
const enabled = process.env.BUMPER_VM_TESTS === "1" && process.platform === "darwin";
const CONTAINER = "/usr/local/bin/container";

function waitFor(check, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out"));
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function fetchTextEventually(url, expected, timeoutMs = 30_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started <= timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const text = await response.text();
      if (text === expected) return text;
      last = new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(text)}.`);
    } catch (cause) {
      last = cause;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw last ?? new Error("Preview did not return the expected response.");
}

function runWrapper(file, requestDir, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd,
      env: { ...process.env, BUMPER_DOCKER_REQUESTS: requestDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("exit", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test("VM: Local Preview works with Network Off and revokes live", { skip: !enabled }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-preview-vm-"));
  const before = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  const id = "preview-vm-session-1234";
  const roomName = `bumper-preview-vm-${Date.now().toString(36)}`;
  createDevelopmentSessionLease({
    id,
    pid: process.pid,
    projectName: "VM Preview",
    agentId: "room-shell",
    agentName: "Sandbox shell",
    previewEnabled: true,
    dockerEnabled: false,
  });
  const heartbeat = setInterval(() => heartbeatDevelopmentSessionLease(id), 1_000);
  const broker = new PreviewBroker(join(root, "broker"), id);
  const command = [
    "node", "-e",
    "require('http').createServer((q,r)=>r.end('vm-preview-ok')).listen(3187,'127.0.0.1');setInterval(()=>{},1000)",
  ];
  const parts = broker.setup(command);
  const spec = withPreviewParts({
    image: "docker.io/library/node:22-bookworm-slim",
    doors: parts.doors,
    egress: { mode: "blocked" },
    name: roomName,
  }, { ...parts, doors: [] });
  const child = spawn(CONTAINER, buildRunArgs(spec, parts.command), { stdio: "ignore" });
  broker.start();
  t.after(async () => {
    clearInterval(heartbeat);
    try { await exec(CONTAINER, ["stop", roomName]); } catch {}
    child.kill();
    await broker.stop();
    removeDevelopmentSessionLease(id);
    if (before === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = before;
    rmSync(root, { recursive: true, force: true });
  });

  const mapping = await waitFor(() => readDevelopmentSessionLease(id)?.runtime.previewPorts
    .find((port) => port.roomPort === 3187));
  try {
    assert.equal(await fetchTextEventually(mapping.url, "vm-preview-ok"), "vm-preview-ok");
  } catch (cause) {
    const diagnostics = await exec(CONTAINER, ["exec", roomName, "/bin/sh", "-c",
      "cat /tmp/bumper-preview.log 2>&1; ls -l /tmp/bumper-preview.sock; cat /bumper-development-state/preview-ports.json"]);
    throw new Error(`Preview fetch failed: ${(cause).message}\n${diagnostics.stdout}\n${diagnostics.stderr}`);
  }
  const direct = await exec(CONTAINER, ["exec", roomName, "node", "-e",
    "fetch('https://example.com',{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(2),()=>process.exit(0))"]);
  assert.equal(direct.stderr, "");

  updateDevelopmentSessionControl(id, { previewEnabled: false });
  await broker.reconcile();
  await assert.rejects(() => fetch(mapping.url));
});

test("VM: Docker broker runs nested containers in a separate Project Engine Sandbox", { skip: !enabled }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-docker-vm-"));
  const workspace = join(root, "workspace");
  const before = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "project-only.txt"), "bounded-project\n");
  const id = "docker-vm-session-12345";
  createDevelopmentSessionLease({
    id,
    pid: process.pid,
    projectName: "VM Docker",
    agentId: "claude",
    agentName: "Claude",
    previewEnabled: true,
    dockerEnabled: true,
  });
  const dockerHeartbeat = setInterval(() => heartbeatDevelopmentSessionLease(id), 1_000);
  const dockerPreview = new PreviewBroker(join(root, "preview-broker"), id, () => {}, "docker");
  const dockerPreviewParts = dockerPreview.setup([]);
  const broker = new DockerBroker({
    dir: join(root, "broker"),
    sessionId: id,
    projectName: "VM Docker",
    workspaceDoors: [{ hostPath: workspace, roomPath: "/workspace", access: "read-write" }],
    egress: { mode: "open" },
    preview: dockerPreviewParts,
  });
  const dockerParts = broker.setup();
  dockerPreview.start();
  broker.start();
  t.after(async () => {
    clearInterval(dockerHeartbeat);
    await broker.stop();
    await dockerPreview.stop();
    removeDevelopmentSessionLease(id);
    if (before === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = before;
    rmSync(root, { recursive: true, force: true });
  });
  const wrapper = join(broker.helperDir, "docker-wrapper.mjs");

  const aiRoomDocker = await exec(CONTAINER, buildRunArgs({
    image: "docker.io/library/node:22-bookworm-slim",
    doors: [
      { hostPath: workspace, roomPath: "/workspace", access: "read-write" },
      ...dockerParts.doors,
    ],
    env: dockerParts.env,
    egress: { mode: "blocked" },
    workdir: "/workspace",
  }, ["/bin/sh", "-c", "docker version --format '{{.Server.Version}}'"]), {
    timeout: 60_000,
  });
  if (!/^27\.5\.1/m.test(aiRoomDocker.stdout)) {
    const files = readdirSync(broker.requestDir);
    const diagnostics = files.map((name) => {
      try { return `${name}: ${readFileSync(join(broker.requestDir, name), "utf8")}`; }
      catch { return `${name}: <binary>`; }
    }).join("\n");
    assert.fail(`Sandbox docker wrapper lost output\nstdout=${aiRoomDocker.stdout}\nstderr=${aiRoomDocker.stderr}\n${diagnostics}`);
  }

  const version = await runWrapper(wrapper, broker.requestDir, ["version", "--format", "{{.Server.Version}}"], workspace);
  assert.equal(
    version.exitCode,
    0,
    `${version.stderr}\n${readDevelopmentSessionLease(id)?.runtime.dockerError || ""}`,
  );
  assert.match(version.stdout, /^27\.5\.1/m);

  const nested = await runWrapper(wrapper, broker.requestDir, [
    "run", "--rm", "-v", "/workspace:/project:ro", "alpine:3.20",
    "cat", "/project/project-only.txt",
  ], workspace);
  assert.equal(nested.exitCode, 0, nested.stderr);
  assert.equal(nested.stdout.trim(), "bounded-project");

  const nestedNetwork = await runWrapper(wrapper, broker.requestDir, [
    "run", "--rm", "alpine:3.20", "wget", "-qO-", "http://example.com",
  ], workspace);
  assert.equal(nestedNetwork.exitCode, 0, nestedNetwork.stderr);
  assert.match(nestedNetwork.stdout, /Example Domain/);

  const service = await runWrapper(wrapper, broker.requestDir, [
    "run", "-d", "--name", "bumper-preview-proof", "-p", "4567:4567",
    "node:22-alpine", "node", "-e",
    "require('http').createServer((q,r)=>r.end('docker-preview-ok\\n')).listen(4567,'0.0.0.0')",
  ], workspace);
  assert.equal(service.exitCode, 0, service.stderr);
  const serviceState = await runWrapper(wrapper, broker.requestDir, [
    "ps", "--filter", "name=bumper-preview-proof", "--format", "{{.Names}} {{.Ports}}",
  ], workspace);
  assert.equal(serviceState.exitCode, 0, serviceState.stderr);
  if (!/bumper-preview-proof.*4567->4567/.test(serviceState.stdout)) {
    const stopped = await runWrapper(wrapper, broker.requestDir, [
      "ps", "-a", "--filter", "name=bumper-preview-proof", "--format", "{{.Names}} {{.Status}}",
    ], workspace);
    const logs = await runWrapper(wrapper, broker.requestDir, ["logs", "bumper-preview-proof"], workspace);
    assert.fail(`preview service did not stay live\n${stopped.stdout}\n${logs.stdout}\n${logs.stderr}`);
  }
  let previewMapping;
  try {
    previewMapping = await waitFor(() => readDevelopmentSessionLease(id)?.runtime.previewPorts
      .find((port) => port.source === "docker" && port.roomPort === 4567));
  } catch (cause) {
    const diagnostics = await exec(CONTAINER, ["exec", "bumper-docker-dockervmsession12345", "/bin/sh", "-c",
      "cat /bumper-development-state/preview-relay.log 2>&1; cat /bumper-development-state/preview-ports.json 2>&1; cat /proc/net/tcp; docker ps --format '{{.Names}} {{.Ports}}'"]);
    throw new Error(`${cause.message}\n${diagnostics.stdout}\n${diagnostics.stderr}`);
  }
  try {
    assert.equal(
      await fetchTextEventually(previewMapping.url, "docker-preview-ok\n"),
      "docker-preview-ok\n",
    );
  } catch (cause) {
    const diagnostics = await exec(CONTAINER, ["exec", "bumper-docker-dockervmsession12345", "/bin/sh", "-c",
      "node -e \"fetch('http://127.0.0.1:4567').then(r=>r.text()).then(console.log).catch(console.error)\"; cat /bumper-development-state/preview-connection.json 2>&1; cat /bumper-development-state/preview-relay.log 2>&1; docker logs bumper-preview-proof"]);
    throw new Error(`${cause.message}\n${diagnostics.stdout}\n${diagnostics.stderr}`);
  }

  const compose = await runWrapper(wrapper, broker.requestDir, ["compose", "version"], workspace);
  assert.equal(compose.exitCode, 0, compose.stderr);
  assert.match(compose.stdout, /Docker Compose version/);

  updateDevelopmentSessionControl(id, { dockerEnabled: false });
  await broker.reconcile();
  assert.equal(readDevelopmentSessionLease(id)?.runtime.dockerStatus, "idle");
  const denied = await runWrapper(wrapper, broker.requestDir, ["version"], workspace);
  assert.equal(denied.exitCode, 125);
  assert.match(denied.stderr, /Docker is Off/);
});
