// Hermetic end-to-end test of the enforcing proxy: point it at a stub backend,
// connect as an MCP client, and assert deny-by-default + write-blocking hold —
// including that a blocked write never actually executed.
//
// Entry point is `bumper mcp connect --project <id>`. The old `bumper serve` alias
// was deleted with the other pre-release legacy surfaces; the proxy itself is the
// live MCP Hub bridge.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repo = resolve(here, "..");
const stub = join(here, "stub-backend.mjs");

let dir, configPath, statePath, markerBase, client;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bumper-test-"));
  markerBase = join(dir, "marker");
  configPath = join(dir, "config.json");
  statePath = join(dir, "state.json");
  writeFileSync(configPath, JSON.stringify({
    defaultContext: "isolated",
    backends: {
      stub: { command: "node", args: [stub], env: { STUB_MARKER: markerBase } },
    },
    contexts: {
      isolated: { backends: ["stub"], mode: "read-only" },
    },
  }));

  client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: "node",
    args: [join(repo, "dist", "cli.js"), "mcp", "connect", "--project", "isolated"],
    env: { ...process.env, BUMPER_CONFIG: configPath, BUMPER_STATE: statePath },
  }));
});

after(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("only the read tool is exposed (deny-by-default)", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["stub__get_note"]);
});

test("the allowed read tool works", async () => {
  const res = await client.callTool({ name: "stub__get_note", arguments: {} });
  assert.notEqual(res.isError, true);
});

test("a blocked write tool returns an error AND does not execute", async () => {
  const res = await client.callTool({ name: "stub__delete_note", arguments: {} });
  assert.equal(res.isError, true);
  assert.equal(existsSync(`${markerBase}.delete_note`), false, "delete_note must not have executed");
});

test("an unknown-verb tool is blocked AND does not execute", async () => {
  const res = await client.callTool({ name: "stub__frobnicate", arguments: {} });
  assert.equal(res.isError, true);
  assert.equal(existsSync(`${markerBase}.frobnicate`), false, "frobnicate must not have executed");
});
