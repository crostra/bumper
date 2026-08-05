/**
 * Phase 5 Slice B — MCP Hub: Integration/Connection models, secret non-exposure,
 * project isolation, stdio bridge smoke, Sandbox Connector door without host secrets.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";
import {
  applyExternalMcpConfig,
  buildExternalMcpSnippet,
  EXTERNAL_MCP_MODE_LABEL,
  listMcpConnections,
  listMcpIntegrations,
  previewExternalMcpConfig,
  projectMayUseConnection,
  resolveProjectMcpBackends,
  rollbackExternalMcpConfig,
  secretHandleForMcpField,
  setMcpConnectionSecret,
} from "../dist/mcp-hub.js";
import { mcpBrokerDoorLooksClean, RoomMcpBroker } from "../dist/room/mcp-broker.js";
import { roomSpecForContext } from "../dist/room/spec.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const stub = join(repoRoot, "test", "stub-backend.mjs");
const appJs = () => readFileSync(join(repoRoot, "assets", "app.js"), "utf8");
const appHtml = () => readFileSync(join(repoRoot, "assets", "app.html"), "utf8");
const cli = join(repoRoot, "dist", "cli.js");

function writeHubFixture(root, { secret = "MCP_HUB_SECRET_VALUE_XYZ" } = {}) {
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  mkdirSync(workspaceA);
  mkdirSync(workspaceB);
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
          { key: "marker", label: "Marker path", secret: false, envKey: "STUB_MARKER", required: true },
          { key: "token", label: "Token", secret: true, envKey: "STUB_TOKEN", required: true },
        ],
      },
    },
    mcpConnections: {
      "client-a": {
        name: "Client A",
        integrationId: "stub",
        values: { marker: join(root, "marker-a") },
      },
      "client-b": {
        name: "Client B",
        integrationId: "stub",
        values: { marker: join(root, "marker-b") },
      },
    },
    contexts: {
      alpha: {
        workspace: workspaceA,
        mode: "read-only",
        backends: [],
        mcpBindings: { stub: "client-a" },
        room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked" },
      },
      beta: {
        workspace: workspaceB,
        mode: "read-only",
        backends: [],
        mcpBindings: {},
        room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked" },
      },
    },
  }));
  writeFileSync(statePath, JSON.stringify({ activeContext: "alpha" }));
  process.env.BUMPER_CONFIG = cfg;
  process.env.BUMPER_STATE = statePath;
  setMcpConnectionSecret("client-a", "token", secret);
  setMcpConnectionSecret("client-b", "token", "OTHER_SECRET_SHOULD_NOT_LEAK");
  return { cfg, statePath, secret, workspaceA };
}

test("Phase 5B UI: Library MCP + Project Connections revealed", () => {
  const js = appJs();
  assert.match(js, /function renderLibraryMcpIntegrations/);
  assert.match(js, /function renderLibraryMcpConnectionEdit/);
  assert.match(js, /function renderProjectConnections/);
  assert.match(js, /#\/library\/mcp/);
  assert.match(js, /mcpBindings/);
  assert.match(js, /MCP-only/);
  assert.match(js, /bumper mcp connect/);
  assert.match(appHtml(), /data-project-section="connections"/);
  assert.doesNotMatch(js, /Hidden until end-to-end Hub proof/);
  assert.doesNotMatch(js, /Coming soon/i);
});

test("Phase 5B: secret non-exposure + project isolation in /api/state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase5b-state-"));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  const { secret } = writeHubFixture(root);
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, cli);
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  const state = await fetch(`${handle.url}/api/state`).then((r) => r.json());
  const blob = JSON.stringify(state);
  assert.doesNotMatch(blob, new RegExp(secret));
  assert.doesNotMatch(blob, /OTHER_SECRET_SHOULD_NOT_LEAK/);
  assert.doesNotMatch(blob, /mcp:client-a:token/);
  assert.equal(state.mcpIntegrations[0].id, "stub");
  assert.equal(state.mcpConnections.find((c) => c.id === "client-a").secretFlags.token, true);
  assert.equal(state.mcpConnections.find((c) => c.id === "client-a").values.token, undefined);
  assert.equal(state.contexts.alpha.mcpBindings[0].connectionId, "client-a");
  assert.equal(state.contexts.beta.mcpBindings.length, 0);

  const exportBody = await fetch(`${handle.url}/api/events/export`).then((r) => r.text());
  assert.doesNotMatch(exportBody, new RegExp(secret));

  assert.equal(projectMayUseConnection(config, "alpha", "client-a"), true);
  assert.equal(projectMayUseConnection(config, "beta", "client-a"), false);

  const alpha = resolveProjectMcpBackends(config, "alpha");
  assert.ok(alpha.backends.stub);
  assert.equal(alpha.backends.stub.env.STUB_TOKEN, secret);
  const beta = resolveProjectMcpBackends(config, "beta");
  assert.deepEqual(beta.backendNames, []);
  assert.equal(beta.backends.stub, undefined);
});

test("Phase 5B: bumper mcp connect bridge smoke + isolation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase5b-bridge-"));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  const { secret } = writeHubFixture(root);
  t.after(() => {
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  const env = { ...process.env, BUMPER_CONFIG: process.env.BUMPER_CONFIG, BUMPER_STATE: process.env.BUMPER_STATE };
  const clientA = new Client({ name: "test-a", version: "0" }, { capabilities: {} });
  await clientA.connect(new StdioClientTransport({
    command: "node",
    args: [cli, "mcp", "connect", "--project", "alpha"],
    env,
  }));
  t.after(async () => { try { await clientA.close(); } catch { /* */ } });

  const listed = await clientA.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["stub__get_note"]);
  const listedBlob = JSON.stringify(listed);
  assert.doesNotMatch(listedBlob, new RegExp(secret));

  const call = await clientA.callTool({ name: "stub__get_note", arguments: {} });
  assert.notEqual(call.isError, true);
  assert.doesNotMatch(JSON.stringify(call), new RegExp(secret));

  const clientB = new Client({ name: "test-b", version: "0" }, { capabilities: {} });
  await clientB.connect(new StdioClientTransport({
    command: "node",
    args: [cli, "mcp", "connect", "--project", "beta"],
    env,
  }));
  t.after(async () => { try { await clientB.close(); } catch { /* */ } });
  const listedB = await clientB.listTools();
  assert.deepEqual(listedB.tools.map((tool) => tool.name), []);
});

test("Phase 5B: Sandbox Connector door has no host credentials + queue smoke", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase5b-room-"));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  const { secret, workspaceA } = writeHubFixture(root);
  t.after(() => {
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  const { config } = loadConfig();
  const broker = new RoomMcpBroker(join(root, "mcp-door"), config, "alpha");
  const { door } = broker.setup();
  assert.equal(door.roomPath, "/bumper-mcp");
  assert.ok(existsSync(join(door.hostPath, "bumper-mcp-server.mjs")));
  const clean = mcpBrokerDoorLooksClean(door.hostPath);
  assert.equal(clean.ok, true, clean.detail);

  const context = config.contexts.alpha;
  const spec = roomSpecForContext(context, workspaceA);
  for (const d of spec.doors || []) {
    assert.doesNotMatch(d.hostPath, /mcp-connection-secrets/);
    assert.doesNotMatch(d.hostPath, /\.ssh/);
  }

  await broker.start();
  t.after(() => broker.stop());

  const reqPath = join(door.hostPath, "queue", "probe.req");
  const resPath = join(door.hostPath, "queue", "probe.res");
  writeFileSync(reqPath, JSON.stringify({ op: "list_tools" }));
  for (let i = 0; i < 50 && !existsSync(resPath); i++) {
    await broker.drain();
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(existsSync(resPath), "broker should answer list_tools");
  const body = JSON.parse(readFileSync(resPath, "utf8"));
  assert.equal(body.ok, true);
  assert.ok(body.tools.some((tool) => tool.name === "stub__get_note"));
  assert.doesNotMatch(JSON.stringify(body), new RegExp(secret));
  assert.doesNotMatch(readFileSync(join(door.hostPath, "README.txt"), "utf8"), new RegExp(secret));
});

test("Phase 5B: external MCP client config diff / backup / rollback (MCP-only)", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase5b-ext-"));
  try {
    const target = join(root, "mcp.json");
    writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: "echo" } } }, null, 2));
    const snippet = buildExternalMcpSnippet({
      binPath: "/tmp/bumper-cli.js",
      configPath: "/tmp/bumper.config.json",
      projectId: "alpha",
    });
    assert.equal(snippet.mode, "MCP-only");
    assert.match(snippet.warning, /MCP-only/);
    assert.match(EXTERNAL_MCP_MODE_LABEL, /files,\s*shell,\s*or\s*network/i);
    assert.deepEqual(snippet.mcpServers.bumper.args.slice(1, 4), ["mcp", "connect", "--project"]);

    const preview = previewExternalMcpConfig(target, snippet);
    assert.equal(preview.changed, true);
    assert.match(preview.after, /MCP-only|bumper/);
    assert.match(preview.after, /"other"/);

    const { backupPath } = applyExternalMcpConfig(target, snippet);
    assert.ok(existsSync(backupPath));
    const applied = JSON.parse(readFileSync(target, "utf8"));
    assert.ok(applied.mcpServers.bumper);
    assert.ok(applied.mcpServers.other);

    rollbackExternalMcpConfig(target, backupPath);
    const rolled = JSON.parse(readFileSync(target, "utf8"));
    assert.equal(rolled.mcpServers.bumper, undefined);
    assert.ok(rolled.mcpServers.other);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 5B: public list never exposes secret handle values", () => {
  assert.equal(secretHandleForMcpField("Client A", "API Key"), "mcp:client-a:api-key");
  const root = mkdtempSync(join(tmpdir(), "bumper-phase5b-list-"));
  try {
    writeHubFixture(root);
    const { config } = loadConfig();
    const listed = listMcpConnections(config);
    const a = listed.find((c) => c.id === "client-a");
    assert.equal(a.secretFlags.token, true);
    assert.equal("token" in a.values, false);
    assert.ok(listMcpIntegrations(config).some((i) => i.id === "stub"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
