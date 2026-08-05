import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Config, ConfigSchema } from "./types.js";
import { resolveConfigPath } from "./paths.js";
import { enterRecoveryMode, writeConfigJson, writeFileAtomic } from "./config-store.js";

export function loadConfig(explicit?: string): { path: string; config: Config } {
  const path = resolveConfigPath(explicit);
  if (!existsSync(path)) {
    throw new Error(
      `No config found at ${path}.\nRun \`bumper init\` to create one, or set BUMPER_CONFIG.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    enterRecoveryMode(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
    throw new Error(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    enterRecoveryMode(`Config at ${path} is invalid:\n${parsed.error.toString()}`);
    throw new Error(`Config at ${path} is invalid:\n${parsed.error.toString()}`);
  }
  try {
    validateReferences(parsed.data, path);
  } catch (err) {
    enterRecoveryMode((err as Error).message);
    throw err;
  }
  return { path, config: parsed.data };
}

/** Create the GUI's safe, useful first-run config when no config exists yet. */
export function ensureConfig(explicit?: string): { path: string; config: Config } {
  const path = resolveConfigPath(explicit);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const initial = {
      webPort: 4319,
      defaultContext: "Local workspace",
      globalPolicy: {
        mode: "read-write",
        native: { allow: [], deny: [] },
        commands: {
          gitRead: "allow", gitLocalWrite: "allow", gitRemoteRead: "allow",
          gitRemoteWrite: "block", shellRead: "allow", shellWrite: "allow", unknown: "block",
        },
        readPaths: [], writePaths: [], denyReadPaths: [], denyWritePaths: [],
      },
      backends: {},
      contexts: {
        "Local workspace": {
          description: "Only the folder selected when a session starts",
          backends: [], mode: "read-write", inheritMode: true, policies: {}, commands: {},
          native: { allow: [], deny: [] }, writePaths: [], readPaths: [], denyReadPaths: [],
          denyWritePaths: [], gitIgnored: "visible", repos: [], allowedHosts: [],
          room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked", doors: [] },
        },
      },
    };
    writeFileAtomic(path, `${JSON.stringify(initial, null, 2)}\n`, 0o600);
  }
  return loadConfig(path);
}

/** Persist a full Config object atomically (with backup rotation). */
export function saveConfig(config: Config, explicit?: string): string {
  const path = resolveConfigPath(explicit);
  writeConfigJson(path, config);
  return path;
}

/** Catch typos: contexts referencing unknown backends, empty config, etc. */
function validateReferences(config: Config, path: string): void {
  const backendNames = new Set(Object.keys(config.backends));
  for (const [ctxName, ctx] of Object.entries(config.contexts)) {
    for (const b of ctx.backends) {
      if (!backendNames.has(b)) {
        throw new Error(
          `Config ${path}: context "${ctxName}" references unknown backend "${b}".`,
        );
      }
    }
    for (const b of Object.keys(ctx.policies)) {
      if (!ctx.backends.includes(b)) {
        throw new Error(
          `Config ${path}: context "${ctxName}" has a policy for "${b}" but does not list it in backends.`,
        );
      }
    }
  }
  if (config.defaultContext && !config.contexts[config.defaultContext]) {
    throw new Error(
      `Config ${path}: defaultContext "${config.defaultContext}" is not a defined context.`,
    );
  }
}

export const EXAMPLE_CONFIG = {
  webPort: 4319,
  defaultContext: "personal",
  backends: {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/bumper-demo"],
      description: "Local filesystem demo server",
    },
  },
  contexts: {
    personal: {
      description: "Your own stuff — full access.",
      backends: ["filesystem"],
      mode: "read-write",
    },
    "clientA": {
      description: "Client A — read-only, cannot touch anything else.",
      backends: ["filesystem"],
      mode: "read-only",
    },
  },
};
