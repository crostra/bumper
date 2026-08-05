#!/usr/bin/env node
/*
 * Bumper Room MCP bridge — runs *inside* the Room.
 *
 * It is a real MCP stdio server, so the AI CLI in the room discovers Hub tools
 * the ordinary way (`--mcp-config`, `-c mcp_servers…`) instead of being told to
 * shell out to a helper script it has no reason to find. Every request is
 * relayed to the host Connector over the broker door's file queue: the door is
 * the only channel, and it works with the Room's network fully off.
 *
 * This file is untrusted from the host's point of view. It sits on a read-write
 * door, so the agent can edit it — and gains nothing by doing so, because the
 * host re-decides every request against Project policy (src/mcp-gateway.ts).
 * Nothing secret is ever placed here.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const MOUNT = dirname(fileURLToPath(import.meta.url));
const QUEUE = join(MOUNT, "queue");
const SERVER_INFO = { name: "bumper", version: "1.0.0" };
const FALLBACK_PROTOCOL = "2025-06-18";
/* The host Connector polls the queue every ~120 ms; a tool call may legitimately
 * take a while, so this is a liveness bound, not a latency target. */
const CALL_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 30_000;
const POLL_MS = 40;

let counter = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask the host Connector. Returns the parsed response or throws a plain Error. */
async function ask(request, timeoutMs) {
  mkdirSync(QUEUE, { recursive: true });
  const stem = join(QUEUE, `mcp.${process.pid}.${Date.now().toString(36)}.${counter++}`);
  const reqPath = `${stem}.req`;
  const resPath = `${stem}.res`;
  writeFileSync(`${reqPath}.tmp`, `${JSON.stringify(request)}\n`);
  renameSync(`${reqPath}.tmp`, reqPath);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (existsSync(resPath)) {
        const raw = readFileSync(resPath, "utf8");
        try {
          return JSON.parse(raw);
        } catch {
          throw new Error("host Connector returned a malformed response");
        }
      }
      await sleep(POLL_MS);
    }
    throw new Error("host Connector did not answer — is the Bumper session still running?");
  } finally {
    rmSync(reqPath, { force: true });
    rmSync(resPath, { force: true });
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Tool failures are results, not transport errors: the model must read why. */
function toolError(text) {
  return { content: [{ type: "text", text: `bumper: ${text}` }], isError: true };
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  if (method === "initialize") {
    const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
    reply(id, {
      protocolVersion: asked || FALLBACK_PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (!isRequest) return; // notifications (initialized, cancelled, …)
  if (method === "ping") return reply(id, {});

  if (method === "tools/list") {
    try {
      const res = await ask({ op: "list_tools" }, LIST_TIMEOUT_MS);
      if (!res?.ok) return reply(id, { tools: [] });
      const tools = (res.tools || []).map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        inputSchema: tool.inputSchema && typeof tool.inputSchema === "object"
          ? tool.inputSchema
          : { type: "object" },
      }));
      return reply(id, { tools });
    } catch (err) {
      // An empty list is honest here: nothing is reachable right now.
      return reply(id, { tools: [] });
    }
  }

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    try {
      const res = await ask(
        { op: "call_tool", name, arguments: params?.arguments ?? {} },
        CALL_TIMEOUT_MS,
      );
      if (!res?.ok) return reply(id, toolError(res?.error || "the call was refused"));
      return reply(id, res.result ?? { content: [] });
    } catch (err) {
      return reply(id, toolError(err.message));
    }
  }

  replyError(id, -32601, `bumper: method "${method}" is not supported`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  void handle(message).catch((err) => {
    if (message?.id !== undefined && message?.id !== null) {
      replyError(message.id, -32603, `bumper: ${err.message}`);
    }
  });
});
rl.on("close", () => process.exit(0));
