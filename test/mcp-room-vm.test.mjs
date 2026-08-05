/**
 * Sandbox-side proof for the MCP Hub.
 *
 * The unit suite drives the bridge on the host. This one boots a real Apple
 * container Sandbox with **egress off**, runs the bridge from the mounted door with
 * the Sandbox's own node, and speaks real MCP to it — so the claim being checked is
 * the one that matters: a sealed room with no network still reaches Hub tools,
 * still cannot exceed the Project's mode, and never sees the credential.
 *
 * Run with: BUMPER_VM_TESTS=1 npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { AppleContainerBackend } from "../dist/room/apple-container.js";
import { RECOMMENDED_ROOM_IMAGE } from "../dist/room/setup.js";
import { loadConfig } from "../dist/config.js";
import { setMcpConnectionSecret } from "../dist/mcp-hub.js";
import { RoomMcpBroker, ROOM_MCP_MOUNT } from "../dist/room/mcp-broker.js";

const CONTAINER = "/usr/local/bin/container";
const GATE = process.env.BUMPER_VM_TESTS === "1";
const IMAGE = process.env.BUMPER_VM_IMAGE || RECOMMENDED_ROOM_IMAGE;
const SECRET = "VM_ROOM_MCP_SECRET_MUST_NOT_LEAK";
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function containerReady() {
  if (!GATE) return { ok: false, reason: "BUMPER_VM_TESTS!=1" };
  if (process.platform !== "darwin") return { ok: false, reason: "not darwin" };
  if (!existsSync(CONTAINER)) return { ok: false, reason: "container CLI missing" };
  const check = await new AppleContainerBackend().check();
  if (!check.usable) return { ok: false, reason: check.detail };
  return { ok: true };
}

/**
 * The in-room client. Written from the host onto the door, then run by the
 * Sandbox's node — the same way the bridge itself gets there.
 */
const PROBE = `
const { spawn } = require("node:child_process");
const p = spawn("node", ["${ROOM_MCP_MOUNT}/bumper-mcp-server.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
const out = {};
let buf = "";
const send = (m) => p.stdin.write(JSON.stringify(m) + "\\n");
p.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) { out.server = msg.result.serverInfo.name; send({ jsonrpc: "2.0", id: 2, method: "tools/list" }); }
    else if (msg.id === 2) { out.tools = msg.result.tools.map((t) => t.name); send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "stub__get_note", arguments: {} } }); }
    else if (msg.id === 3) { out.read = msg.result; send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "stub__delete_note", arguments: {} } }); }
    else if (msg.id === 4) { out.write = msg.result; console.log("BUMPER_PROBE " + JSON.stringify(out)); process.exit(0); }
  }
});
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } });
setTimeout(() => { console.log("BUMPER_PROBE " + JSON.stringify({ timeout: true })); process.exit(1); }, 40000);
`;

function writeFixture(root) {
  const workspace = join(root, "ws");
  mkdirSync(workspace, { recursive: true });
  const cfg = join(root, "bumper.config.json");
  const statePath = join(root, "state.json");
  writeFileSync(cfg, JSON.stringify({
    webPort: 0,
    defaultContext: "alpha",
    mcpIntegrations: {
      stub: {
        name: "Stub", command: "node", args: [join(repoRoot, "test", "stub-backend.mjs")],
        transport: "stdio",
        fields: [
          { key: "marker", label: "M", secret: false, envKey: "STUB_MARKER", required: true },
          { key: "token", label: "T", secret: true, envKey: "STUB_TOKEN", required: true },
        ],
      },
    },
    mcpConnections: {
      "client-a": { name: "A", integrationId: "stub", values: { marker: join(root, "marker") } },
    },
    contexts: {
      alpha: {
        workspace, mode: "read-only", backends: [], mcpBindings: { stub: "client-a" },
        room: { enabled: true, image: IMAGE, egress: "blocked" },
      },
    },
  }));
  writeFileSync(statePath, JSON.stringify({ activeContext: "alpha" }));
  process.env.BUMPER_CONFIG = cfg;
  process.env.BUMPER_STATE = statePath;
  setMcpConnectionSecret("client-a", "token", SECRET);
  return { markerBase: join(root, "marker") };
}

function runRoom(doorHostPath) {
  return new Promise((resolveRun) => {
    const args = [
      "run", "--rm", "--network", "none",
      "--mount", `type=bind,source=${doorHostPath},target=${ROOM_MCP_MOUNT}`,
      IMAGE, "/bin/sh", "-c",
      `node ${ROOM_MCP_MOUNT}/probe.cjs`,
    ];
    let stdout = "";
    const child = spawn(CONTAINER, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stdout += d; });
    child.on("exit", (code) => resolveRun({ code, stdout }));
  });
}

test("a sealed Sandbox with egress off still reaches Hub tools — and read-only holds inside it", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) return t.skip(`Sandbox MCP VM proof skipped: ${ready.reason}`);

  const root = mkdtempSync(join(tmpdir(), "bumper-vm-mcp-"));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  const { markerBase } = writeFixture(root);
  t.after(() => {
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  const { config } = loadConfig();
  const broker = new RoomMcpBroker(join(root, "door"), config, "alpha", { sessionId: "vm" });
  const { door } = broker.setup();
  writeFileSync(join(door.hostPath, "probe.cjs"), PROBE);
  await broker.start(60);
  t.after(() => broker.stop());

  const { stdout } = await runRoom(door.hostPath);
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("BUMPER_PROBE "));
  assert.ok(line, `probe produced no result:\n${stdout}`);
  const out = JSON.parse(line.slice("BUMPER_PROBE ".length));

  assert.equal(out.timeout, undefined, "the door answered before the probe timed out");
  assert.equal(out.server, "bumper");
  assert.deepEqual(out.tools, ["stub__get_note"], "only the allowed tool is visible in the Sandbox");
  assert.match(JSON.stringify(out.read), /note contents/, "the allowed tool really ran on the host");
  assert.equal(out.write.isError, true, "the blocked write was refused");
  assert.equal(
    existsSync(`${markerBase}.delete_note`),
    false,
    "the blocked write never reached the MCP server",
  );

  // The credential must not have crossed into the Sandbox in any form.
  assert.doesNotMatch(stdout, new RegExp(SECRET));
});
