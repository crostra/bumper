/**
 * MCP Hub — the Library model: Integrations, Connections, and their secrets.
 *
 * Integration = how to launch an MCP server (command/args/transport + field schema).
 * Connection = named field values; secret fields live in a host-side handle store
 * (mode 0600 under ~/.bumper) and never appear in /api/state, renderer, or Events.
 *
 * Project binds at most one Connection per Integration (`mcpBindings`).
 *
 * This module resolves *what* a Project may reach. It never decides a call and
 * never talks to a Room: policy lives in src/mcp-gateway.ts, and the Room path
 * lives in src/room/mcp-broker.ts. Keeping the three apart is what stops the
 * Room path from quietly growing its own, weaker, copy of the rules.
 *
 * External mode (`bumper mcp connect` / client config helpers) is MCP-only:
 * files / shell / network are not Bumper-protected on that path.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Backend, Config, Context, McpConnection, McpField, McpIntegration } from "./types.js";
import { stateFilePath } from "./paths.js";

const CONNECTION_SECRET_PREFIX = "mcp:";

export type McpTransport = McpIntegration["transport"];

export interface McpIntegrationPublic {
  id: string;
  name: string;
  command: string;
  args: string[];
  transport: McpTransport;
  fields: McpField[];
  connectionCount: number;
}

export interface McpConnectionPublic {
  id: string;
  name: string;
  integrationId: string;
  values: Record<string, string>;
  /** Human memo (import source, etc.). Never a secret. */
  description: string;
  /** Per secret field key → whether a host handle exists. Never the secret itself. */
  secretFlags: Record<string, boolean>;
  hasAllRequiredSecrets: boolean;
}

export interface ProjectMcpBindingPublic {
  integrationId: string;
  integrationName: string;
  connectionId: string;
  connectionName: string;
  ready: boolean;
}

function secretsPath(): string {
  return join(dirname(stateFilePath()), "mcp-connection-secrets.json");
}

type SecretStore = Record<string, string>;

function readSecrets(): SecretStore {
  const p = secretsPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as SecretStore;
  } catch {
    return {};
  }
}

function writeSecrets(store: SecretStore): void {
  const p = secretsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function normalizeMcpId(raw: string, label = "id"): string {
  const id = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!id) throw new Error(`MCP ${label} is required.`);
  return id;
}

export function secretHandleForMcpField(connectionId: string, fieldKey: string): string {
  return `${CONNECTION_SECRET_PREFIX}${normalizeMcpId(connectionId)}:${normalizeMcpId(fieldKey, "field")}`;
}

export function hasMcpConnectionSecret(connectionId: string, fieldKey: string): boolean {
  const store = readSecrets();
  return Boolean(store[secretHandleForMcpField(connectionId, fieldKey)]);
}

/** Host-only: never call from renderer/API response builders that stringify state. */
export function readMcpConnectionSecret(connectionId: string, fieldKey: string): string | undefined {
  const store = readSecrets();
  const value = store[secretHandleForMcpField(connectionId, fieldKey)];
  return value || undefined;
}

export function setMcpConnectionSecret(connectionId: string, fieldKey: string, value: string): void {
  const id = normalizeMcpId(connectionId);
  const key = normalizeMcpId(fieldKey, "field");
  const secret = String(value ?? "").trim();
  if (!secret) throw new Error("Secret value is required.");
  const store = readSecrets();
  store[secretHandleForMcpField(id, key)] = secret;
  writeSecrets(store);
}

export function deleteMcpConnectionSecret(connectionId: string, fieldKey: string): boolean {
  const store = readSecrets();
  const handle = secretHandleForMcpField(connectionId, fieldKey);
  if (!(handle in store)) return false;
  delete store[handle];
  writeSecrets(store);
  return true;
}

export function deleteAllMcpConnectionSecrets(connectionId: string): void {
  const prefix = `${CONNECTION_SECRET_PREFIX}${normalizeMcpId(connectionId)}:`;
  const store = readSecrets();
  let changed = false;
  for (const key of Object.keys(store)) {
    if (key.startsWith(prefix)) {
      delete store[key];
      changed = true;
    }
  }
  if (changed) writeSecrets(store);
}

function envKeyForField(field: McpField): string {
  return (field.envKey || field.key).trim() || field.key;
}

export function upsertMcpIntegration(
  config: Config,
  input: {
    id?: string;
    name?: string;
    command?: string;
    args?: string[];
    transport?: string;
    fields?: McpField[];
  },
): { id: string; integration: McpIntegration } {
  const id = normalizeMcpId(input.id || input.name || "", "integration id");
  const name = String(input.name ?? id).trim() || id;
  const command = String(input.command ?? "").trim();
  if (!command) throw new Error("Integration command is required.");
  const args = Array.isArray(input.args) ? input.args.map((a) => String(a)) : [];
  const transport = input.transport === "stdio" || !input.transport ? "stdio" : (() => {
    throw new Error(`Unsupported MCP transport "${input.transport}". Initial Hub supports stdio only.`);
  })();
  const fields = normalizeFields(input.fields);
  return { id, integration: { name, command, args, transport, fields } };
}

function normalizeFields(raw: McpField[] | undefined): McpField[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const fields: McpField[] = [];
  for (const item of raw) {
    const key = normalizeMcpId(String(item?.key ?? ""), "field");
    if (seen.has(key)) continue;
    seen.add(key);
    fields.push({
      key,
      label: String(item.label ?? key).trim() || key,
      secret: Boolean(item.secret),
      required: item.required !== false,
      envKey: String(item.envKey ?? key).trim() || key,
    });
  }
  return fields;
}

export function upsertMcpConnection(
  config: Config,
  input: {
    id?: string;
    name?: string;
    integrationId?: string;
    values?: Record<string, string>;
    description?: string;
  },
): { id: string; connection: McpConnection } {
  const integrationId = normalizeMcpId(input.integrationId || "", "integration id");
  if (!config.mcpIntegrations?.[integrationId]) {
    throw new Error(`Unknown MCP Integration "${integrationId}".`);
  }
  const id = normalizeMcpId(input.id || input.name || "", "connection id");
  const name = String(input.name ?? id).trim() || id;
  const description = String(input.description ?? "").trim();
  const integration = config.mcpIntegrations[integrationId];
  const values: Record<string, string> = {};
  const incoming = input.values && typeof input.values === "object" ? input.values : {};
  for (const field of integration.fields) {
    if (field.secret) continue;
    const v = incoming[field.key];
    if (v != null && String(v).trim()) values[field.key] = String(v).trim();
  }
  return { id, connection: { name, integrationId, values, description } };
}

export function listMcpIntegrations(config: Config): McpIntegrationPublic[] {
  const connections = config.mcpConnections ?? {};
  return Object.entries(config.mcpIntegrations ?? {})
    .map(([id, integ]) => ({
      id,
      name: integ.name || id,
      command: integ.command,
      args: integ.args ?? [],
      transport: integ.transport,
      fields: integ.fields ?? [],
      connectionCount: Object.values(connections).filter((c) => c.integrationId === id).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getMcpIntegration(
  config: Config,
  id: string | undefined,
): (McpIntegration & { id: string }) | undefined {
  if (!id) return undefined;
  try {
    const normalized = normalizeMcpId(id);
    const integ = config.mcpIntegrations?.[normalized];
    if (!integ) return undefined;
    return { id: normalized, ...integ };
  } catch {
    return undefined;
  }
}

export function listMcpConnections(config: Config, integrationId?: string): McpConnectionPublic[] {
  const filter = integrationId ? normalizeMcpId(integrationId) : undefined;
  return Object.entries(config.mcpConnections ?? {})
    .filter(([, conn]) => !filter || conn.integrationId === filter)
    .map(([id, conn]) => publicConnection(config, id, conn))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getMcpConnection(
  config: Config,
  id: string | undefined,
): (McpConnection & { id: string }) | undefined {
  if (!id) return undefined;
  try {
    const normalized = normalizeMcpId(id);
    const conn = config.mcpConnections?.[normalized];
    if (!conn) return undefined;
    return { id: normalized, ...conn };
  } catch {
    return undefined;
  }
}

function publicConnection(config: Config, id: string, conn: McpConnection): McpConnectionPublic {
  const integ = config.mcpIntegrations?.[conn.integrationId];
  const fields = integ?.fields ?? [];
  const secretFlags: Record<string, boolean> = {};
  let hasAllRequiredSecrets = true;
  for (const field of fields) {
    if (!field.secret) continue;
    const present = hasMcpConnectionSecret(id, field.key);
    secretFlags[field.key] = present;
    if (field.required !== false && !present) hasAllRequiredSecrets = false;
  }
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.secret) continue;
    if (conn.values?.[field.key] != null) values[field.key] = String(conn.values[field.key]);
  }
  return {
    id,
    name: conn.name || id,
    integrationId: conn.integrationId,
    values,
    description: conn.description ?? "",
    secretFlags,
    hasAllRequiredSecrets,
  };
}

export function projectsUsingMcpConnection(config: Config, connectionId: string): string[] {
  const normalized = normalizeMcpId(connectionId);
  return Object.entries(config.contexts)
    .filter(([, ctx]) => Object.values(ctx.mcpBindings ?? {}).includes(normalized))
    .map(([name]) => name);
}

export function projectsUsingMcpIntegration(config: Config, integrationId: string): string[] {
  const normalized = normalizeMcpId(integrationId);
  return Object.entries(config.contexts)
    .filter(([, ctx]) => Boolean(ctx.mcpBindings?.[normalized]))
    .map(([name]) => name);
}

export function listProjectMcpBindings(config: Config, context: Context): ProjectMcpBindingPublic[] {
  const bindings = context.mcpBindings ?? {};
  const out: ProjectMcpBindingPublic[] = [];
  for (const [integrationId, connectionId] of Object.entries(bindings)) {
    const integ = getMcpIntegration(config, integrationId);
    const conn = getMcpConnection(config, connectionId);
    if (!integ || !conn || conn.integrationId !== integ.id) continue;
    const pub = publicConnection(config, conn.id, conn);
    out.push({
      integrationId: integ.id,
      integrationName: integ.name,
      connectionId: conn.id,
      connectionName: conn.name,
      ready: pub.hasAllRequiredSecrets,
    });
  }
  return out.sort((a, b) => a.integrationName.localeCompare(b.integrationName));
}

/**
 * Host-only: build Backend spawn specs for a Project's Hub bindings.
 * Secrets are injected into the Backend env here and must never leave this process
 * via API/state/export.
 */
export function resolveProjectMcpBackends(
  config: Config,
  projectName: string,
): { backends: Record<string, Backend>; backendNames: string[] } {
  const context = config.contexts[projectName];
  if (!context) throw new Error(`Unknown project "${projectName}".`);
  const backends: Record<string, Backend> = {};
  const backendNames: string[] = [];
  for (const [integrationId, connectionId] of Object.entries(context.mcpBindings ?? {})) {
    const integ = getMcpIntegration(config, integrationId);
    const conn = getMcpConnection(config, connectionId);
    if (!integ || !conn) continue;
    if (conn.integrationId !== integ.id) continue;
    if (integ.transport !== "stdio") continue;
    const missing = integ.fields.some(
      (f) => f.secret && f.required !== false && !readMcpConnectionSecret(conn.id, f.key),
    );
    if (missing) continue;
    const env: Record<string, string> = {};
    for (const field of integ.fields) {
      const ek = envKeyForField(field);
      if (field.secret) {
        const secret = readMcpConnectionSecret(conn.id, field.key);
        if (secret) env[ek] = secret;
      } else if (conn.values?.[field.key] != null) {
        env[ek] = String(conn.values[field.key]);
      }
    }
    const name = integ.id;
    backends[name] = {
      command: integ.command,
      args: integ.args ?? [],
      env,
      description: integ.name,
    };
    backendNames.push(name);
  }
  return { backends, backendNames };
}

/** Merge Hub backends + legacy config.backends for proxy inspect/serve. */
export function mergeProjectBackends(
  config: Config,
  projectName: string,
  context: Context,
): { config: Config; context: Context; hubNames: string[] } {
  const { backends: hubBackends, backendNames: hubNames } = resolveProjectMcpBackends(config, projectName);
  const backends = { ...config.backends, ...hubBackends };
  const names = [...new Set([...(context.backends ?? []), ...hubNames])];
  return {
    config: { ...config, backends },
    context: { ...context, backends: names },
    hubNames,
  };
}

/** True when Connection A is not bound to Project B (isolation helper). */
export function projectMayUseConnection(
  config: Config,
  projectName: string,
  connectionId: string,
): boolean {
  const context = config.contexts[projectName];
  if (!context) return false;
  const normalized = normalizeMcpId(connectionId);
  return Object.values(context.mcpBindings ?? {}).includes(normalized);
}

// ── External client config (MCP-only) ──────────────────────────────────────

export const EXTERNAL_MCP_MODE_LABEL =
  "MCP-only — Bumper does not protect files, shell, or network for this external client path.";

export function buildExternalMcpSnippet(opts: {
  binPath: string;
  configPath: string;
  projectId: string;
}): {
  mode: "MCP-only";
  warning: string;
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
} {
  const projectId = normalizeMcpId(opts.projectId, "project");
  return {
    mode: "MCP-only",
    warning: EXTERNAL_MCP_MODE_LABEL,
    mcpServers: {
      bumper: {
        command: "node",
        args: [opts.binPath, "mcp", "connect", "--project", projectId],
        env: { BUMPER_CONFIG: opts.configPath },
      },
    },
  };
}

export interface ExternalMcpDiff {
  mode: "MCP-only";
  warning: string;
  path: string;
  before: string;
  after: string;
  changed: boolean;
}

export function previewExternalMcpConfig(
  configPath: string,
  snippet: ReturnType<typeof buildExternalMcpSnippet>,
): ExternalMcpDiff {
  const before = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  let existing: Record<string, unknown> = {};
  if (before.trim()) {
    try {
      existing = JSON.parse(before) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  const mcpServers = {
    ...((existing.mcpServers as Record<string, unknown>) || {}),
    ...snippet.mcpServers,
  };
  const next = { ...existing, mcpServers };
  const after = `${JSON.stringify(next, null, 2)}\n`;
  return {
    mode: "MCP-only",
    warning: EXTERNAL_MCP_MODE_LABEL,
    path: configPath,
    before,
    after,
    changed: before !== after,
  };
}

export function applyExternalMcpConfig(
  configPath: string,
  snippet: ReturnType<typeof buildExternalMcpSnippet>,
): { backupPath: string; diff: ExternalMcpDiff } {
  const diff = previewExternalMcpConfig(configPath, snippet);
  mkdirSync(dirname(configPath), { recursive: true });
  const backupPath = `${configPath}.bumper-backup-${Date.now()}`;
  if (existsSync(configPath)) copyFileSync(configPath, backupPath);
  else writeFileSync(backupPath, "", { mode: 0o600 });
  writeFileSync(configPath, diff.after, { mode: 0o600 });
  return { backupPath, diff };
}

export function rollbackExternalMcpConfig(configPath: string, backupPath: string): void {
  if (!existsSync(backupPath)) throw new Error(`Backup not found: ${backupPath}`);
  const text = readFileSync(backupPath, "utf8");
  if (!text) {
    if (existsSync(configPath)) rmSync(configPath);
    return;
  }
  writeFileSync(configPath, text, { mode: 0o600 });
}
