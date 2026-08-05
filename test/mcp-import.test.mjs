import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseJsonc,
  parseMcpServersDocument,
  suggestConnectionName,
  integrationFingerprint,
  applyMcpServerImports,
  isProbablySecretEnvKey,
} from "../dist/mcp-import.js";

test("parseJsonc tolerates // comments and trailing commas", () => {
  const doc = parseJsonc(`{
    "mcpServers": {
      "demo": {
        "command": "npx",
        "args": ["@demo/mcp"],
        // comment
        "env": { "API_KEY": "secret", "BASE_URL": "https://a.example/" },
      },
    },
  }`);
  const servers = parseMcpServersDocument(doc);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].command, "npx");
  assert.equal(servers[0].secrets.api_key, "secret");
  assert.equal(servers[0].values.base_url, "https://a.example/");
});

test("secret key heuristic", () => {
  assert.equal(isProbablySecretEnvKey("API_KEY"), true);
  assert.equal(isProbablySecretEnvKey("REDASH_URL"), false);
});

test("connection names avoid bare (2)", () => {
  const taken = new Set(["redash"]);
  const n1 = suggestConnectionName("redash", "Cursor", { base_url: "https://a.example.com/x" }, taken);
  assert.equal(n1, "redash · Cursor");
  taken.add(n1);
  const n2 = suggestConnectionName("redash", "Cursor", { base_url: "https://b.example.com" }, taken);
  assert.match(n2, /redash · b\.example\.com|redash · /);
  assert.doesNotMatch(n2, /\(2\)/);
});

test("same command fingerprints as one Integration; two envs → two Connections", () => {
  const empty = { mcpIntegrations: {}, mcpConnections: {} };
  const servers = parseMcpServersDocument({
    mcpServers: {
      redash: {
        command: "uv",
        args: ["run", "redash"],
        env: { REDASH_URL: "https://a.example", REDASH_API_KEY: "key-a" },
      },
    },
  });
  const first = applyMcpServerImports(empty, servers, { sourceLabel: "Cursor", sourcePath: "/tmp/mcp.json" });
  assert.equal(Object.keys(first.config.mcpIntegrations).length, 1);
  assert.equal(Object.keys(first.config.mcpConnections).length, 1);
  assert.equal(first.secretsToWrite.length, 1);

  const serversB = parseMcpServersDocument({
    mcpServers: {
      redash: {
        command: "uv",
        args: ["run", "redash"],
        env: { REDASH_URL: "https://b.example", REDASH_API_KEY: "key-b" },
      },
    },
  });
  const second = applyMcpServerImports(first.config, serversB, { sourceLabel: "Cursor" });
  assert.equal(Object.keys(second.config.mcpIntegrations).length, 1, "same launch → one Integration");
  assert.equal(Object.keys(second.config.mcpConnections).length, 2, "different env → second Connection");
  const names = Object.values(second.config.mcpConnections).map((c) => c.name);
  assert.ok(names.every((n) => !/\(2\)/.test(n)));
  assert.equal(
    integrationFingerprint("uv", ["run", "redash"]),
    integrationFingerprint("uv", ["run", "redash"]),
  );
});

test("HTTP url servers are skipped", () => {
  const servers = parseMcpServersDocument({
    mcpServers: { remote: { url: "https://example.com/mcp" } },
  });
  assert.ok(servers[0].skipReason);
});
