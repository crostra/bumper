import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveConfigPath } from "./paths.js";
import { getActiveContext } from "./state.js";
import type { AgentId } from "./agents.js";

function readJson(path: string): Record<string, any> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} exists but is not valid JSON — fix or remove it, then retry.`);
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/**
 * Wire bumper into Claude Code for a project directory: the MCP proxy
 * (.mcp.json) and the native-tool hook (.claude/settings.json). Merges into
 * existing files instead of clobbering them, and is idempotent.
 */
function sh(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

function runner(binPath: string, subcommand: string, context?: string) {
  const configPath = resolveConfigPath();
  const env: Record<string, string> = { BUMPER_CONFIG: configPath };
  if (context) env.BUMPER_CONTEXT = context;
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return { command: process.execPath, args: [binPath, subcommand], env };
}

function hookCommand(binPath: string, context?: string): string {
  const run = runner(binPath, "hook", context);
  const env = Object.entries(run.env).map(([key, value]) => `${key}=${sh(value)}`).join(" ");
  return `${env} ${sh(run.command)} ${run.args.map(sh).join(" ")}`;
}

export function installClaude(targetDir: string, binPath: string, context?: string): string[] {
  const dir = resolve(targetDir);
  if (!existsSync(dir)) throw new Error(`Directory not found: ${dir}`);
  const configPath = resolveConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`No bumper config found (${configPath}). Run \`bumper init\` first.`);
  }
  const notes: string[] = [];

  // 1. MCP proxy → .mcp.json
  const mcpPath = join(dir, ".mcp.json");
  const mcp = readJson(mcpPath) ?? {};
  mcp.mcpServers = mcp.mcpServers ?? {};
  mcp.mcpServers["bumper"] = runner(binPath, "serve", context);
  writeJson(mcpPath, mcp);
  notes.push(`✓ ${mcpPath}  (MCP proxy)`);

  // 2. Native-tool hook → .claude/settings.json
  const claudeDir = join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  const settings = readJson(settingsPath) ?? {};
  settings.hooks = settings.hooks ?? {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse ?? [];
  const command = hookCommand(binPath, context);
  const already = settings.hooks.PreToolUse.some((m: any) =>
    (m.hooks ?? []).some((h: any) => h.command === command),
  );
  if (already) {
    notes.push(`• ${settingsPath}  (hook already present)`);
  } else {
    settings.hooks.PreToolUse.push({ matcher: "*", hooks: [{ type: "command", command }] });
    writeJson(settingsPath, settings);
    notes.push(`✓ ${settingsPath}  (native-tool hook)`);
  }

  return notes;
}

function installCursor(targetDir: string, binPath: string, context?: string): string[] {
  const dir = resolve(targetDir);
  const cursorDir = join(dir, ".cursor");
  mkdirSync(cursorDir, { recursive: true });
  const path = join(cursorDir, "mcp.json");
  const data = readJson(path) ?? {};
  data.mcpServers = data.mcpServers ?? {};
  data.mcpServers.bumper = runner(binPath, "serve", context);
  writeJson(path, data);
  return [`✓ ${path}  (MCP proxy)`];
}

function installCodex(targetDir: string, binPath: string, context?: string): string[] {
  const dir = resolve(targetDir);
  const codexDir = join(dir, ".codex");
  mkdirSync(codexDir, { recursive: true });
  const hookPath = join(codexDir, "hooks.json");
  const hooks = readJson(hookPath) ?? {};
  hooks.description = hooks.description ?? "Workspace lifecycle hooks";
  hooks.hooks = hooks.hooks ?? {};
  hooks.hooks.PreToolUse = hooks.hooks.PreToolUse ?? [];
  const command = hookCommand(binPath, context);
  const already = hooks.hooks.PreToolUse.some((entry: any) =>
    (entry.hooks ?? []).some((hook: any) => hook.command === command),
  );
  if (!already) hooks.hooks.PreToolUse.push({ matcher: "*", hooks: [{ type: "command", command }] });
  writeJson(hookPath, hooks);

  const configPath = join(codexDir, "config.toml");
  const run = runner(binPath, "serve", context);
  const original = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const begin = "# >>> bumper managed MCP";
  const end = "# <<< bumper managed MCP";
  const withoutManaged = original.replace(new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g"), "").trimEnd();
  const tomlString = (value: string) => JSON.stringify(value);
  const envEntries = Object.entries(run.env).map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ");
  const block = [
    begin,
    "[mcp_servers.bumper]",
    `command = ${tomlString(run.command)}`,
    `args = [${run.args.map(tomlString).join(", ")}]`,
    `env = { ${envEntries} }`,
    end,
  ].join("\n");
  writeFileSync(configPath, `${withoutManaged}${withoutManaged ? "\n\n" : ""}${block}\n`);
  return [`✓ ${configPath}  (MCP proxy)`, `✓ ${hookPath}  (native hook; Codex may ask you to trust it once)`];
}

/** Install only integrations that the target client officially supports. */
export function installAgent(agent: AgentId, targetDir: string, binPath: string, context?: string): string[] {
  if (agent === "claude") return installClaude(targetDir, binPath, context);
  if (agent === "codex") return installCodex(targetDir, binPath, context);
  if (agent === "cursor") return installCursor(targetDir, binPath, context);
  return ["OS sandbox enabled; this client has no Bumper-native hook adapter."];
}
