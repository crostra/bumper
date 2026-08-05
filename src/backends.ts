import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Backend } from "./types.js";

export interface BackendTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  readOnlyHint?: boolean;
}

/** A live connection to one backend MCP server. */
export class BackendConnection {
  readonly name: string;
  private readonly backend: Backend;
  private client?: Client;

  constructor(name: string, backend: Backend) {
    this.name = name;
    this.backend = backend;
  }

  async connect(): Promise<void> {
    const client = new Client(
      { name: "bumper", version: "0.1.0" },
      { capabilities: {} },
    );
    const transport = new StdioClientTransport({
      command: this.backend.command,
      args: this.backend.args,
      // Merge a safe default env (PATH, etc.) with the backend's secrets.
      env: { ...getDefaultEnvironment(), ...this.backend.env },
    });
    await client.connect(transport);
    this.client = client;
  }

  async listTools(): Promise<BackendTool[]> {
    if (!this.client) throw new Error(`backend "${this.name}" not connected`);
    const res = await this.client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      readOnlyHint: t.annotations?.readOnlyHint,
    }));
  }

  async callTool(name: string, args: Record<string, unknown> | undefined) {
    if (!this.client) throw new Error(`backend "${this.name}" not connected`);
    return this.client.callTool({ name, arguments: args ?? {} });
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }
}

/** Connects the backends that the active context needs, and nothing else. */
export class BackendManager {
  private connections = new Map<string, BackendConnection>();

  constructor(private readonly backends: Record<string, Backend>) {}

  async connectMany(names: string[]): Promise<{ connected: string[]; failed: Record<string, string> }> {
    const connected: string[] = [];
    const failed: Record<string, string> = {};
    for (const name of names) {
      const def = this.backends[name];
      if (!def) {
        failed[name] = "not defined in config";
        continue;
      }
      const conn = new BackendConnection(name, def);
      try {
        await conn.connect();
        this.connections.set(name, conn);
        connected.push(name);
      } catch (err) {
        failed[name] = (err as Error).message;
      }
    }
    return { connected, failed };
  }

  get(name: string): BackendConnection | undefined {
    return this.connections.get(name);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => c.close()));
    this.connections.clear();
  }
}
