/**
 * Import MCP servers from Cursor / Claude style mcpServers JSON into
 * Library Integration + Connection (multi-credential safe).
 *
 * - Integration identity = fingerprint(command + args)
 * - Connection = named credential set; never overwrite a different env as (2)
 * - Naming prefers source label / URL host / date over dumb "(2)"
 * - description is a free memo for humans (and Project lists)
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, McpConnection, McpField, McpIntegration } from "./types.js";
import {
  normalizeMcpId,
  setMcpConnectionSecret,
  upsertMcpConnection,
  upsertMcpIntegration,
} from "./mcp-hub.js";

export type McpImportSourceId = "cursor" | "claude-desktop" | "claude-code" | "paste";

export interface McpImportSourceProbe {
  id: McpImportSourceId;
  label: string;
  paths: string[];
  foundPath: string | null;
  serverCount: number;
  error?: string;
}

export interface ParsedMcpServer {
  /** Key from mcpServers object (e.g. redash). */
  serverKey: string;
  command: string;
  args: string[];
  transport: "stdio";
  /** Non-secret env values. */
  values: Record<string, string>;
  /** Secret env values — never leave this process via /api/state. */
  secrets: Record<string, string>;
  /** All env keys in original order. */
  envKeys: string[];
  skipReason?: string;
}

export interface McpImportCandidate {
  serverKey: string;
  command: string;
  args: string[];
  envKeys: string[];
  valueKeys: string[];
  secretKeys: string[];
  /** Suggested Connection display name (no secrets). */
  suggestedName: string;
  /** Suggested description / memo. */
  suggestedDescription: string;
  /** Integration id that would be reused or created. */
  integrationId: string;
  integrationExists: boolean;
  skipReason?: string;
}

export interface McpImportApplyResult {
  serverKey: string;
  integrationId: string;
  connectionId: string;
  connectionName: string;
  createdIntegration: boolean;
  createdConnection: boolean;
  skipped?: string;
}

/** Loose JSONC: // line comments, /* block *\/, trailing commas. */
export function parseJsonc(raw: string): unknown {
  let s = String(raw ?? "");
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  s = s.replace(/^\s*\/\/.*$/gm, "");
  // trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(s);
}

export function isProbablySecretEnvKey(key: string): boolean {
  const k = key.toLowerCase();
  return /token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private|bearer|access[_-]?key/.test(k);
}

export function integrationFingerprint(command: string, args: string[]): string {
  const cmd = String(command ?? "").trim();
  const a = (args ?? []).map((x) => String(x));
  return JSON.stringify([cmd, ...a]);
}

export function integrationIdFromLaunch(command: string, args: string[], serverKey: string): string {
  const fp = integrationFingerprint(command, args);
  // Prefer stable human id from server key when free; fingerprint suffix keeps uniqueness.
  const base = normalizeMcpId(serverKey || "mcp", "integration id");
  let hash = 0;
  for (let i = 0; i < fp.length; i++) hash = (hash * 33 + fp.charCodeAt(i)) >>> 0;
  return normalizeMcpId(`${base}-${hash.toString(16).slice(0, 6)}`, "integration id");
}

function fieldsFromEnvKeys(envKeys: string[]): McpField[] {
  return envKeys.map((key) => ({
    key: normalizeMcpId(key, "field"),
    label: key,
    secret: isProbablySecretEnvKey(key),
    required: true,
    envKey: key,
  }));
}

/** Extract stdio servers from a Cursor/Claude-style document. */
export function parseMcpServersDocument(raw: string | unknown): ParsedMcpServer[] {
  const doc = typeof raw === "string" ? parseJsonc(raw) : raw;
  if (!doc || typeof doc !== "object") throw new Error("MCP document must be a JSON object.");
  const root = doc as Record<string, unknown>;
  const servers = (root.mcpServers && typeof root.mcpServers === "object"
    ? root.mcpServers
    : root.servers && typeof root.servers === "object"
      ? root.servers
      : null) as Record<string, unknown> | null;
  if (!servers) throw new Error('Expected an object with "mcpServers" (Cursor/Claude style).');

  const out: ParsedMcpServer[] = [];
  for (const [serverKey, cfg] of Object.entries(servers)) {
    if (!cfg || typeof cfg !== "object") {
      out.push({
        serverKey,
        command: "",
        args: [],
        transport: "stdio",
        values: {},
        secrets: {},
        envKeys: [],
        skipReason: "Invalid server entry",
      });
      continue;
    }
    const c = cfg as Record<string, unknown>;
    const transportRaw = String(c.type ?? c.transport ?? "stdio").toLowerCase();
    if (transportRaw && transportRaw !== "stdio") {
      out.push({
        serverKey,
        command: String(c.command ?? ""),
        args: [],
        transport: "stdio",
        values: {},
        secrets: {},
        envKeys: [],
        skipReason: `Transport "${transportRaw}" is not supported yet (stdio only)`,
      });
      continue;
    }
    if (c.url && !c.command) {
      out.push({
        serverKey,
        command: "",
        args: [],
        transport: "stdio",
        values: {},
        secrets: {},
        envKeys: [],
        skipReason: "HTTP/SSE URL servers are not supported yet",
      });
      continue;
    }
    const command = String(c.command ?? "").trim();
    const args = Array.isArray(c.args) ? c.args.map((a) => String(a)) : [];
    const env = c.env && typeof c.env === "object" && !Array.isArray(c.env)
      ? c.env as Record<string, unknown>
      : {};
    const envKeys = Object.keys(env);
    const values: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      const key = normalizeMcpId(k, "field");
      const val = String(v ?? "");
      if (isProbablySecretEnvKey(k)) secrets[key] = val;
      else values[key] = val;
    }
    if (!command) {
      out.push({
        serverKey,
        command: "",
        args,
        transport: "stdio",
        values,
        secrets,
        envKeys,
        skipReason: "Missing command",
      });
      continue;
    }
    out.push({
      serverKey,
      command,
      args,
      transport: "stdio",
      values,
      secrets,
      envKeys,
    });
  }
  return out;
}

function readSourceFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function defaultMcpImportPaths(): Record<Exclude<McpImportSourceId, "paste">, string[]> {
  const home = homedir();
  return {
    cursor: [
      join(home, ".cursor", "mcp.json"),
    ],
    "claude-desktop": [
      join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
    ],
    "claude-code": [
      // Global-ish locations; project .mcp.json is handled when workspace is supplied.
      join(home, ".claude.json"),
    ],
  };
}

function serversFromClaudeCodeUserJson(raw: string): ParsedMcpServer[] {
  // ~/.claude.json is large; mcpServers may live under projects[path].mcpServers.
  let doc: unknown;
  try {
    doc = parseJsonc(raw);
  } catch {
    doc = JSON.parse(raw);
  }
  if (!doc || typeof doc !== "object") return [];
  const root = doc as Record<string, unknown>;
  const collected: ParsedMcpServer[] = [];
  if (root.mcpServers) {
    collected.push(...parseMcpServersDocument({ mcpServers: root.mcpServers }));
  }
  const projects = root.projects;
  if (projects && typeof projects === "object") {
    for (const [projPath, cfg] of Object.entries(projects as Record<string, unknown>)) {
      if (!cfg || typeof cfg !== "object") continue;
      const mcp = (cfg as Record<string, unknown>).mcpServers;
      if (!mcp) continue;
      const parsed = parseMcpServersDocument({ mcpServers: mcp });
      for (const p of parsed) {
        // Disambiguate keys from different projects when listing.
        collected.push({
          ...p,
          serverKey: p.serverKey,
          // encode project path into skipReason? better: leave and use description later
        });
        void projPath;
      }
    }
  }
  return collected;
}

export function probeMcpImportSource(
  id: Exclude<McpImportSourceId, "paste">,
  extraPaths: string[] = [],
): McpImportSourceProbe {
  const labels: Record<Exclude<McpImportSourceId, "paste">, string> = {
    cursor: "Cursor",
    "claude-desktop": "Claude Desktop",
    "claude-code": "Claude Code",
  };
  const paths = [...(defaultMcpImportPaths()[id] ?? []), ...extraPaths];
  let foundPath: string | null = null;
  let serverCount = 0;
  let error: string | undefined;
  for (const path of paths) {
    const raw = readSourceFile(path);
    if (raw == null) continue;
    foundPath = path;
    try {
      if (id === "claude-code" && path.endsWith(".claude.json")) {
        serverCount = serversFromClaudeCodeUserJson(raw).filter((s) => !s.skipReason).length;
      } else {
        serverCount = parseMcpServersDocument(raw).filter((s) => !s.skipReason).length;
      }
    } catch (err) {
      error = (err as Error).message;
      serverCount = 0;
    }
    break;
  }
  return {
    id,
    label: labels[id],
    paths,
    foundPath,
    serverCount,
    error,
  };
}

export function listMcpImportProbes(workspacePath?: string): McpImportSourceProbe[] {
  const extraCursor = workspacePath ? [join(workspacePath, ".cursor", "mcp.json")] : [];
  const extraClaudeCode = workspacePath ? [join(workspacePath, ".mcp.json")] : [];
  return [
    probeMcpImportSource("cursor", extraCursor),
    probeMcpImportSource("claude-desktop"),
    probeMcpImportSource("claude-code", extraClaudeCode),
  ];
}

function valueHint(values: Record<string, string>): string {
  for (const [k, v] of Object.entries(values)) {
    if (!v) continue;
    if (/url|host|endpoint|base/i.test(k)) {
      try {
        const u = new URL(v);
        return u.host || v.slice(0, 40);
      } catch {
        return v.replace(/^https?:\/\//, "").slice(0, 40);
      }
    }
  }
  return "";
}

/**
 * Human Connection names — avoid dumb "(2)" when Project only binds one.
 * Prefer: base → base · source → base · url-host → base · date.
 */
export function suggestConnectionName(
  serverKey: string,
  sourceLabel: string,
  values: Record<string, string>,
  takenNames: Set<string>,
): string {
  const base = String(serverKey || "connection").trim() || "connection";
  const candidates = [
    base,
    `${base} · ${sourceLabel}`,
  ];
  const hint = valueHint(values);
  if (hint) candidates.push(`${base} · ${hint}`);
  const day = new Date().toISOString().slice(0, 10);
  candidates.push(`${base} · ${day}`);
  for (const name of candidates) {
    if (![...takenNames].some((t) => t.toLowerCase() === name.toLowerCase())) return name;
  }
  // Last resort only — still better than bare (2): include short unique suffix.
  let n = 2;
  while (n < 100) {
    const name = `${base} · ${sourceLabel} ${n}`;
    if (![...takenNames].some((t) => t.toLowerCase() === name.toLowerCase())) return name;
    n++;
  }
  return `${base} · ${Date.now()}`;
}

function findIntegrationByFingerprint(
  config: Config,
  command: string,
  args: string[],
): { id: string; integration: McpIntegration } | undefined {
  const fp = integrationFingerprint(command, args);
  for (const [id, integ] of Object.entries(config.mcpIntegrations ?? {})) {
    if (integrationFingerprint(integ.command, integ.args ?? []) === fp) {
      return { id, integration: integ };
    }
  }
  return undefined;
}

function mergeFields(existing: McpField[], incomingKeys: string[]): McpField[] {
  const map = new Map(existing.map((f) => [f.key, f]));
  for (const key of incomingKeys) {
    const k = normalizeMcpId(key, "field");
    if (map.has(k)) continue;
    map.set(k, {
      key: k,
      label: key,
      secret: isProbablySecretEnvKey(key),
      required: true,
      envKey: key,
    });
  }
  return [...map.values()];
}

export function buildImportCandidates(
  config: Config,
  servers: ParsedMcpServer[],
  sourceLabel: string,
  sourcePath?: string,
): McpImportCandidate[] {
  const taken = new Set(
    Object.values(config.mcpConnections ?? {}).map((c) => c.name),
  );
  return servers.map((s) => {
    if (s.skipReason) {
      return {
        serverKey: s.serverKey,
        command: s.command,
        args: s.args,
        envKeys: s.envKeys,
        valueKeys: Object.keys(s.values),
        secretKeys: Object.keys(s.secrets),
        suggestedName: s.serverKey,
        suggestedDescription: "",
        integrationId: "",
        integrationExists: false,
        skipReason: s.skipReason,
      };
    }
    const existing = findIntegrationByFingerprint(config, s.command, s.args);
    const integrationId = existing?.id
      ?? integrationIdFromLaunch(s.command, s.args, s.serverKey);
    const name = suggestConnectionName(s.serverKey, sourceLabel, s.values, taken);
    taken.add(name);
    const descParts = [
      `Imported from ${sourceLabel}`,
      sourcePath ? sourcePath.replace(homedir(), "~") : "",
      s.serverKey !== name ? `server key: ${s.serverKey}` : "",
    ].filter(Boolean);
    return {
      serverKey: s.serverKey,
      command: s.command,
      args: s.args,
      envKeys: s.envKeys,
      valueKeys: Object.keys(s.values),
      secretKeys: Object.keys(s.secrets),
      suggestedName: name,
      suggestedDescription: descParts.join(" · "),
      integrationId,
      integrationExists: Boolean(existing),
    };
  });
}

export function loadServersFromSource(
  id: Exclude<McpImportSourceId, "paste">,
  pathOverride?: string,
  workspacePath?: string,
): { path: string; servers: ParsedMcpServer[] } {
  const probe = listMcpImportProbes(workspacePath).find((p) => p.id === id);
  const path = pathOverride || probe?.foundPath;
  if (!path) throw new Error(`${probe?.label || id} MCP config was not found in the usual locations.`);
  const raw = readSourceFile(path);
  if (raw == null) throw new Error(`Could not read ${path}.`);
  if (id === "claude-code" && path.endsWith(".claude.json")) {
    return { path, servers: serversFromClaudeCodeUserJson(raw) };
  }
  return { path, servers: parseMcpServersDocument(raw) };
}

export function applyMcpServerImports(
  config: Config,
  servers: ParsedMcpServer[],
  opts: {
    sourceLabel: string;
    sourcePath?: string;
    /** Only import these server keys; empty = all non-skipped. */
    serverKeys?: string[];
    /** Optional display name / description overrides keyed by serverKey. */
    nameByKey?: Record<string, string>;
    descriptionByKey?: Record<string, string>;
  },
): {
  config: Config;
  results: McpImportApplyResult[];
  /** Secrets to write after config save: connectionId → fieldKey → value */
  secretsToWrite: Array<{ connectionId: string; fieldKey: string; value: string }>;
} {
  const want = opts.serverKeys?.length ? new Set(opts.serverKeys) : null;
  const next: Config = {
    ...config,
    mcpIntegrations: { ...(config.mcpIntegrations ?? {}) },
    mcpConnections: { ...(config.mcpConnections ?? {}) },
  };
  const results: McpImportApplyResult[] = [];
  const secretsToWrite: Array<{ connectionId: string; fieldKey: string; value: string }> = [];
  const takenNames = new Set(Object.values(next.mcpConnections).map((c) => c.name));

  for (const server of servers) {
    if (want && !want.has(server.serverKey)) continue;
    if (server.skipReason) {
      results.push({
        serverKey: server.serverKey,
        integrationId: "",
        connectionId: "",
        connectionName: "",
        createdIntegration: false,
        createdConnection: false,
        skipped: server.skipReason,
      });
      continue;
    }

    let existingInteg = findIntegrationByFingerprint(next, server.command, server.args);
    let createdIntegration = false;
    let integrationId: string;
    if (existingInteg) {
      integrationId = existingInteg.id;
      // Merge any new env keys into the field schema.
      const merged = mergeFields(existingInteg.integration.fields ?? [], server.envKeys);
      next.mcpIntegrations[integrationId] = {
        ...existingInteg.integration,
        fields: merged,
      };
    } else {
      const { id, integration } = upsertMcpIntegration(next, {
        id: integrationIdFromLaunch(server.command, server.args, server.serverKey),
        name: server.serverKey,
        command: server.command,
        args: server.args,
        transport: "stdio",
        fields: fieldsFromEnvKeys(server.envKeys),
      });
      next.mcpIntegrations[id] = integration;
      integrationId = id;
      createdIntegration = true;
    }

    const displayName = (opts.nameByKey?.[server.serverKey] || "").trim()
      || suggestConnectionName(server.serverKey, opts.sourceLabel, server.values, takenNames);
    takenNames.add(displayName);
    const description = (opts.descriptionByKey?.[server.serverKey] || "").trim()
      || [
        `Imported from ${opts.sourceLabel}`,
        opts.sourcePath ? opts.sourcePath.replace(homedir(), "~") : "",
      ].filter(Boolean).join(" · ");

    // Same integration + identical non-secret values + same secret keys present → skip duplicate.
    // (We cannot compare secret values without reading them; identical display path uses name.)
    const duplicate = Object.entries(next.mcpConnections).find(([, conn]) => {
      if (conn.integrationId !== integrationId) return false;
      if (conn.name === displayName) return true;
      const keys = Object.keys(server.values);
      if (keys.length && keys.every((k) => conn.values?.[k] === server.values[k])) {
        // values match; treat as update path of same connection name preferred
        return conn.name.toLowerCase().startsWith(server.serverKey.toLowerCase());
      }
      return false;
    });

    if (duplicate && duplicate[1].name === displayName) {
      results.push({
        serverKey: server.serverKey,
        integrationId,
        connectionId: duplicate[0],
        connectionName: duplicate[1].name,
        createdIntegration,
        createdConnection: false,
        skipped: "Already imported with this name",
      });
      continue;
    }

    const { id: connectionId, connection } = upsertMcpConnection(next, {
      id: normalizeMcpId(`${integrationId}-${displayName}`, "connection id"),
      name: displayName,
      integrationId,
      values: server.values,
      description,
    });
    next.mcpConnections[connectionId] = connection;
    for (const [fieldKey, value] of Object.entries(server.secrets)) {
      if (value) secretsToWrite.push({ connectionId, fieldKey, value });
    }
    results.push({
      serverKey: server.serverKey,
      integrationId,
      connectionId,
      connectionName: displayName,
      createdIntegration,
      createdConnection: true,
    });
  }

  return { config: next, results, secretsToWrite };
}

/** Apply secrets after config is persisted (paths depend on state dir). */
export function writeImportedMcpSecrets(
  secrets: Array<{ connectionId: string; fieldKey: string; value: string }>,
): void {
  for (const row of secrets) {
    if (!row.value) continue;
    setMcpConnectionSecret(row.connectionId, row.fieldKey, row.value);
  }
}
