/*
 * MCP inside the Sandbox.
 *
 * The regression this suite exists for: the Sandbox Connector used to bypass the
 * policy engine (it split the exposed name and called the backend directly), and
 * it was only wired into SessionManager — which has no entry point — so
 * `bumper <cli>`, the path users actually run, had no MCP at all. Both failures
 * passed every unit test at the time.
 *
 * So: behaviour end-to-end through the *real* bridge script and the *real* door
 * queue, a proof that a blocked write never executed, then a convergence check
 * that both launch paths compose through the one function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { setMcpConnectionSecret } from "../dist/mcp-hub.js";
import { loadConfig } from "../dist/config.js";
import {
  describeRoomMcp,
  prepareRoomMcp,
  roomMcpClientConfig,
  roomMcpDeliveryReport,
  roomMcpRegistration,
  RoomMcpBroker,
  ROOM_MCP_MOUNT,
  ROOM_MCP_SERVER,
  withMcpBroker,
} from "../dist/room/mcp-broker.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const stub = join(repoRoot, "test", "stub-backend.mjs");
const SECRET = "ROOM_MCP_SECRET_MUST_NOT_LEAK";

/** A Project bound to the stub Connection, plus a second Project bound to nothing. */
function writeFixture(root, { mode = "read-only" } = {}) {
  const workspace = join(root, "ws");
  mkdirSync(workspace, { recursive: true });
  const cfg = join(root, "bumper.config.json");
  const statePath = join(root, "state.json");
  writeFileSync(cfg, JSON.stringify({
    webPort: 0,
    defaultContext: "alpha",
    mcpIntegrations: {
      stub: {
        name: "Stub",
        command: "node",
        args: [stub],
        transport: "stdio",
        fields: [
          { key: "marker", label: "Marker", secret: false, envKey: "STUB_MARKER", required: true },
          { key: "token", label: "Token", secret: true, envKey: "STUB_TOKEN", required: true },
        ],
      },
    },
    mcpConnections: {
      "client-a": { name: "Client A", integrationId: "stub", values: { marker: join(root, "marker") } },
    },
    contexts: {
      alpha: {
        workspace,
        mode,
        backends: [],
        mcpBindings: { stub: "client-a" },
        room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked" },
      },
      beta: {
        workspace,
        mode,
        backends: [],
        mcpBindings: {},
        room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked" },
      },
    },
  }));
  writeFileSync(statePath, JSON.stringify({ activeContext: "alpha" }));
  process.env.BUMPER_CONFIG = cfg;
  process.env.BUMPER_STATE = statePath;
  setMcpConnectionSecret("client-a", "token", SECRET);
  return { workspace, markerBase: join(root, "marker") };
}

function restoreEnv(t, previousConfig, previousState, root) {
  t.after(() => {
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });
}

/**
 * Connect to the bridge exactly as an in-room AI CLI would: run the copy the
 * broker wrote onto the door, over stdio, speaking real MCP.
 */
async function connectThroughDoor(t, doorPath) {
  const client = new Client({ name: "room-cli", version: "0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: "node",
    args: [join(doorPath, "bumper-mcp-server.mjs")],
    // A real room has none of the host's environment. Prove the bridge needs none.
    env: { PATH: process.env.PATH },
  }));
  t.after(async () => { try { await client.close(); } catch { /* already gone */ } });
  return client;
}

test("the room reaches Hub tools through the bridge, and read-only holds", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-room-mcp-"));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  const { markerBase } = writeFixture(root, { mode: "read-only" });
  restoreEnv(t, previousConfig, previousState, root);

  const { config } = loadConfig();
  const broker = new RoomMcpBroker(join(root, "door"), config, "alpha", { sessionId: "s1" });
  const { door } = broker.setup();
  await broker.start(40);
  t.after(() => broker.stop());

  const client = await connectThroughDoor(t, door.hostPath);

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["stub__get_note"], "only the read tool is offered to the room");
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(SECRET));

  const ok = await client.callTool({ name: "stub__get_note", arguments: {} });
  assert.notEqual(ok.isError, true);
  assert.match(JSON.stringify(ok), /note contents/);
  assert.doesNotMatch(JSON.stringify(ok), new RegExp(SECRET));

  // Deny-by-default: naming a blocked tool correctly must not run it.
  const blocked = await client.callTool({ name: "stub__delete_note", arguments: {} });
  assert.equal(blocked.isError, true);
  assert.match(JSON.stringify(blocked), /blocked/i);
  assert.equal(
    existsSync(`${markerBase}.delete_note`),
    false,
    "a blocked write must never reach the backend",
  );

  // An unrecognized verb is treated as a write, not quietly allowed.
  const unknown = await client.callTool({ name: "stub__frobnicate", arguments: {} });
  assert.equal(unknown.isError, true);
  assert.equal(existsSync(`${markerBase}.frobnicate`), false);
});

test("read-write mode reaches the same write tool (the block was policy, not plumbing)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-room-mcp-rw-"));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  const { markerBase } = writeFixture(root, { mode: "read-write" });
  restoreEnv(t, previousConfig, previousState, root);

  const { config } = loadConfig();
  const broker = new RoomMcpBroker(join(root, "door"), config, "alpha");
  const { door } = broker.setup();
  await broker.start(40);
  t.after(() => broker.stop());

  const client = await connectThroughDoor(t, door.hostPath);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["stub__delete_note", "stub__frobnicate", "stub__get_note"]);

  const call = await client.callTool({ name: "stub__delete_note", arguments: {} });
  assert.notEqual(call.isError, true);
  assert.equal(existsSync(`${markerBase}.delete_note`), true);
});

test("a Project with no bound Connection gets no door, no flags, no tools", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-room-mcp-none-"));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  writeFixture(root);
  restoreEnv(t, previousConfig, previousState, root);

  const { config } = loadConfig();
  const prepared = prepareRoomMcp({
    dir: join(root, "door-beta"),
    config,
    projectName: "beta",
    context: config.contexts.beta,
    agentId: "claude",
  });
  assert.equal(prepared.door, undefined);
  assert.equal(prepared.broker, undefined);
  assert.deepEqual(prepared.args, []);
  assert.match(prepared.banner, /no Connections bound/);
  assert.equal(existsSync(join(root, "door-beta")), false, "no door is created");
});

test("the door carries the bridge and no credential material", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-room-mcp-door-"));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  writeFixture(root);
  restoreEnv(t, previousConfig, previousState, root);

  const { config } = loadConfig();
  const prepared = prepareRoomMcp({
    dir: join(root, "door"),
    config,
    projectName: "alpha",
    context: config.contexts.alpha,
    agentId: "claude",
    runtimeAvailable: true,
  });
  t.after(() => prepared.broker?.stop());
  assert.ok(prepared.door, "a bound Project gets a door");
  assert.equal(prepared.door.roomPath, ROOM_MCP_MOUNT);

  const hostPath = prepared.door.hostPath;
  assert.ok(existsSync(join(hostPath, "bumper-mcp-server.mjs")));
  const clientConfig = JSON.parse(readFileSync(join(hostPath, "clients", "mcp.json"), "utf8"));
  assert.deepEqual(clientConfig, roomMcpClientConfig());
  assert.equal(clientConfig.mcpServers.bumper.args[0], ROOM_MCP_SERVER);

  // Every file on the door, including the bridge itself, must be secret-free.
  for (const file of ["bumper-mcp-server.mjs", "README.txt", join("clients", "mcp.json")]) {
    assert.doesNotMatch(readFileSync(join(hostPath, file), "utf8"), new RegExp(SECRET));
  }
});

test("withMcpBroker attaches the door without disturbing the rest of the spec", () => {
  const base = {
    image: "img",
    doors: [{ hostPath: "/h/ws", roomPath: "/workspace", access: "read-write" }],
    egress: { mode: "blocked" },
    env: { EXISTING: "1" },
  };
  const door = { hostPath: "/h/mcp", roomPath: ROOM_MCP_MOUNT, access: "read-write" };
  const out = withMcpBroker(base, door);

  assert.ok(out.doors.some((d) => d.roomPath === ROOM_MCP_MOUNT));
  assert.ok(out.doors.some((d) => d.roomPath === "/workspace"), "existing doors are kept");
  assert.equal(out.env.EXISTING, "1", "existing env is kept");
  assert.equal(out.env.BUMPER_MCP_DOOR, ROOM_MCP_MOUNT);
  assert.equal(base.doors.length, 1, "input spec is not mutated");
  // Egress is irrelevant to this channel — that is the point of using a door.
  assert.equal(out.egress.mode, "blocked");
});

test("per-CLI registration is verified, and honest where it is absent", () => {
  const claude = roomMcpRegistration("claude");
  assert.equal(claude.supported, true);
  assert.deepEqual(claude.args, ["--mcp-config=/bumper-mcp/clients/mcp.json"]);
  // Separate tokens would swallow the user's own args: --mcp-config is variadic.
  assert.equal(claude.args.length, 1);

  const codex = roomMcpRegistration("codex");
  assert.equal(codex.supported, true);
  assert.ok(codex.args.includes("mcp_servers.bumper.command=node"));
  assert.ok(codex.args.some((arg) => arg.includes(ROOM_MCP_SERVER)));

  for (const id of ["cursor", "grok", "antigravity", "room-shell"]) {
    const other = roomMcpRegistration(id);
    assert.equal(other.supported, false, `${id} has no verified per-session MCP flag`);
    assert.deepEqual(other.args, []);
    assert.match(other.detail, /vendor home|no per-session MCP flag/i);
  }

  // The UI must be able to say this per tool, not just in aggregate.
  const report = roomMcpDeliveryReport([
    { id: "claude", name: "Claude Code" },
    { id: "grok", name: "Grok Build" },
  ]);
  assert.equal(report.find((row) => row.agentId === "claude").supported, true);
  assert.equal(report.find((row) => row.agentId === "grok").supported, false);
});

test("a bound Connection on a CLI that cannot receive it says so, and attaches nothing", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-room-mcp-cursor-"));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  writeFixture(root);
  restoreEnv(t, previousConfig, previousState, root);

  const { config } = loadConfig();
  const prepared = prepareRoomMcp({
    dir: join(root, "door"),
    config,
    projectName: "alpha",
    context: config.contexts.alpha,
    agentId: "cursor",
  });
  assert.equal(prepared.door, undefined, "no door when the CLI cannot use it");
  assert.deepEqual(prepared.args, []);
  assert.match(prepared.banner, /Connection\(s\) bound, but/);

  // Same for an image with no node: reported, not silently broken.
  const noNode = describeRoomMcp({
    connections: 1,
    registration: roomMcpRegistration("claude"),
    runtimeMissing: true,
  });
  assert.match(noNode, /no node/);
});

test("both launch paths compose MCP through prepareRoomMcp", () => {
  for (const file of ["src/cli-room.ts", "src/sessions.ts"]) {
    const src = readFileSync(join(repoRoot, file), "utf8");
    assert.match(src, /prepareRoomMcp\(/, `${file} must compose MCP through the shared function`);
    assert.match(src, /withMcpBroker\(/, `${file} must attach the door through the shared composer`);
    // The door must never be hand-assembled next to the composer.
    assert.doesNotMatch(src, /roomPath:\s*["']\/bumper-mcp/, `${file} must not build the door itself`);
    assert.doesNotMatch(src, /new RoomMcpBroker\(/, `${file} must not construct the broker directly`);
  }
});

test("the room-side bridge is decision-free: rewriting it cannot widen access", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-room-mcp-tamper-"));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  const { markerBase } = writeFixture(root, { mode: "read-only" });
  restoreEnv(t, previousConfig, previousState, root);

  const { config } = loadConfig();
  const broker = new RoomMcpBroker(join(root, "door"), config, "alpha");
  const { door } = broker.setup();
  await broker.start(40);
  t.after(() => broker.stop());

  // Skip the bridge entirely and write straight onto the door, which is exactly
  // what an agent with a shell in the room can do.
  const queue = join(door.hostPath, "queue");
  const reqPath = join(queue, "tamper.req");
  const resPath = join(queue, "tamper.res");
  writeFileSync(reqPath, JSON.stringify({ op: "call_tool", name: "stub__delete_note", arguments: {} }));
  for (let i = 0; i < 60 && !existsSync(resPath); i++) {
    await broker.drain();
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(existsSync(resPath), "the host must answer even a hand-written request");
  const body = JSON.parse(readFileSync(resPath, "utf8"));
  assert.equal(body.ok, false);
  assert.equal(existsSync(`${markerBase}.delete_note`), false, "policy held on the raw channel");
});
