// A hermetic fake MCP backend for tests: exposes a read tool, a write tool, and
// an "unknown verb" tool. The write/unknown tools record execution by writing a
// marker file, so a test can prove whether an enforced block actually held.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync } from "node:fs";

const MARKER = process.env.STUB_MARKER || "/tmp/bumper-stub-marker";

const server = new Server({ name: "stub", version: "0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "get_note", description: "read a note", inputSchema: { type: "object" },
      annotations: { readOnlyHint: true } },
    { name: "delete_note", description: "destructive", inputSchema: { type: "object" } },
    { name: "frobnicate", description: "unknown verb", inputSchema: { type: "object" } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (name === "get_note") {
    return { content: [{ type: "text", text: "note contents" }] };
  }
  // delete_note / frobnicate: record that we actually executed.
  writeFileSync(`${MARKER}.${name}`, "executed");
  return { content: [{ type: "text", text: `${name} executed` }] };
});

await server.connect(new StdioServerTransport());
