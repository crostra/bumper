import { z } from "zod";

/**
 * A backend MCP server that bumper proxies. Secrets (env) live here, in the
 * proxy's config — they are never handed to the AI client.
 */
export const BackendSchema = z.object({
  /** Executable to spawn for a stdio MCP server, e.g. "npx". */
  command: z.string(),
  args: z.array(z.string()).default([]),
  /** Environment for the spawned process. This is where secrets go. */
  env: z.record(z.string()).default({}),
  /** Optional human description shown in the trust surface. */
  description: z.string().optional(),
});
export type Backend = z.infer<typeof BackendSchema>;

/** Per-backend policy override inside a context. */
export const BackendPolicySchema = z.object({
  /** Override the context mode for this backend. */
  mode: z.enum(["read-only", "read-write"]).optional(),
  /** Tool names always allowed (even in read-only), user vouches they are safe. */
  allow: z.array(z.string()).default([]),
  /** Tool names always blocked. */
  deny: z.array(z.string()).default([]),
});
export type BackendPolicy = z.infer<typeof BackendPolicySchema>;

export const CommandPolicySchema = z.object({
  gitRead: z.enum(["allow", "block"]).default("allow"),
  gitLocalWrite: z.enum(["allow", "block"]).default("allow"),
  gitRemoteRead: z.enum(["allow", "block"]).default("allow"),
  gitRemoteWrite: z.enum(["allow", "block"]).default("block"),
  shellRead: z.enum(["allow", "block"]).default("allow"),
  shellWrite: z.enum(["allow", "block"]).default("allow"),
  unknown: z.enum(["allow", "block"]).default("block"),
});
export type CommandPolicy = z.infer<typeof CommandPolicySchema>;

export const GlobalPolicySchema = z.object({
  mode: z.enum(["read-only", "read-write"]).default("read-write"),
  native: z.object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }).default({ allow: [], deny: [] }),
  commands: CommandPolicySchema.default({}),
  readPaths: z.array(z.string()).default([]),
  writePaths: z.array(z.string()).default([]),
  denyReadPaths: z.array(z.string()).default([]),
  denyWritePaths: z.array(z.string()).default([]),
});
export type GlobalPolicy = z.infer<typeof GlobalPolicySchema>;

export const RoomDoorSchema = z.object({
  hostPath: z.string(),
  roomPath: z.string().default("/workspace"),
  access: z.enum(["read-only", "read-write"]).default("read-only"),
});
export type RoomDoor = z.infer<typeof RoomDoorSchema>;

export const RoomPolicySchema = z.object({
  enabled: z.boolean().default(true),
  image: z.string().default("docker.io/library/alpine:3.20"),
  egress: z.enum(["blocked", "open", "allowlist"]).default("blocked"),
  /** Vendor templates (see EGRESS_TEMPLATES) allowed when egress is "allowlist". */
  egressTemplates: z.array(z.string()).default([]),
  /** Extra explicit hosts allowed when egress is "allowlist". */
  egressHosts: z.array(z.string()).default([]),
  doors: z.array(RoomDoorSchema).default([]),
  /**
   * How much of the workspace is shared into the room:
   *  - "whole"    — the entire workspace is one door at /workspace. Simple, but a
   *                 deny-listed subfolder is still physically inside the mount, so
   *                 it cannot actually be hidden (see docs/SECURITY_MODEL.md).
   *  - "selected" — ONLY the listed sub-folders are mounted. Anything not listed
   *                 is absent by construction, so "hidden" really means hidden.
   */
  workspaceShare: z.enum(["whole", "selected"]).default("whole"),
  /** Workspace-relative sub-folders to mount when workspaceShare is "selected". */
  shareSubpaths: z.array(z.string()).default([]),
  /**
   * Selected mounts with per-path access (Phase 2 Folders).
   * When non-empty and workspaceShare is "selected", these win over shareSubpaths+mode.
   */
  shareEntries: z
    .array(
      z.object({
        path: z.string(),
        access: z.enum(["read-only", "read-write"]).default("read-write"),
      }),
    )
    .default([]),
});
export type RoomPolicy = z.infer<typeof RoomPolicySchema>;

export const DevelopmentPolicySchema = z.object({
  /** Loopback-only Session preview. A host listener opens only for a live Room port. */
  preview: z.object({
    enabled: z.boolean().default(true),
  }).default({ enabled: true }),
  /** Lazy Project-scoped Docker Engine Sandbox. No daemon runs until the first command. */
  docker: z.object({
    enabled: z.boolean().default(true),
  }).default({ enabled: true }),
}).default({
  preview: { enabled: true },
  docker: { enabled: true },
});
export type DevelopmentPolicy = z.infer<typeof DevelopmentPolicySchema>;

/**
 * Named snapshot of Project boundary pieces (Access extras / egress / network).
 * Workspace path is intentionally omitted — it is project-local.
 * Apply copies these fields onto another Project.
 * `repos` remains in the schema for old configs only — never a live boundary.
 */
export const PermissionSetupSchema = z.object({
  description: z.string().optional(),
  mode: z.enum(["read-only", "read-write"]).default("read-only"),
  inheritMode: z.boolean().default(false),
  commands: CommandPolicySchema.partial().default({}),
  native: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({ allow: [], deny: [] }),
  writePaths: z.array(z.string()).default([]),
  readPaths: z.array(z.string()).default([]),
  denyReadPaths: z.array(z.string()).default([]),
  denyWritePaths: z.array(z.string()).default([]),
  gitIgnored: z.enum(["visible", "read-only", "hidden"]).default("visible"),
  repos: z.array(z.string()).default([]),
  allowedHosts: z.array(z.string()).default([]),
  room: z
    .object({
      egress: z.enum(["blocked", "open", "allowlist"]).optional(),
      egressTemplates: z.array(z.string()).optional(),
      egressHosts: z.array(z.string()).optional(),
      doors: z.array(RoomDoorSchema).optional(),
      workspaceShare: z.enum(["whole", "selected"]).optional(),
      shareSubpaths: z.array(z.string()).optional(),
      shareEntries: z
        .array(
          z.object({
            path: z.string(),
            access: z.enum(["read-only", "read-write"]).default("read-write"),
          }),
        )
        .optional(),
      image: z.string().optional(),
    })
    .default({}),
});
export type PermissionSetup = z.infer<typeof PermissionSetupSchema>;

/**
 * One repository this Project may reach, and how far.
 *
 * The provider ids are what actually pin access: a full name can be renamed or
 * re-pointed, an id cannot. All three are required together — a binding that
 * cannot name its connection, installation and repository is not usable and
 * must not silently fall back to guessing another connection.
 */
export const GitRepositoryBindingSchema = z.object({
  fullName: z.string().min(1),
  connectionId: z.string().min(1),
  installationId: z.number().int().positive(),
  repositoryId: z.number().int().positive(),
  capability: z.enum(["none", "read", "write", "pr", "workflow"]).default("read"),
});
export type GitRepositoryBinding = z.infer<typeof GitRepositoryBindingSchema>;

/**
 * A work-context (e.g. "clientA", "personal"). Exactly one is active at a time.
 * The active context defines — structurally — which backends and operations the
 * AI can reach. Everything else is unreachable (deny-by-default).
 */
export const ContextSchema = z.object({
  description: z.string().optional(),
  /** Optional project folder used to prefill protected launch and verification. */
  workspace: z.string().optional(),
  /** Backends visible in this context. Any backend not listed is unreachable. */
  backends: z.array(z.string()).default([]),
  /** Default operation mode for the context. Applies to MCP tools AND native client tools. */
  mode: z.enum(["read-only", "read-write"]).default("read-only"),
  /** Use the global mode until this project explicitly chooses its own. */
  inheritMode: z.boolean().default(false),
  /** Optional per-backend overrides (MCP). */
  policies: z.record(BackendPolicySchema).default({}),
  /**
   * Policy for the client's NATIVE tools (Write/Edit/Bash…) that bypass MCP.
   * Entries are tool names ("Write", "Bash") or command prefixes ("Bash:git status").
   */
  native: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({ allow: [], deny: [] }),
  /** Per-project overrides. Missing keys inherit the global command policy. */
  commands: CommandPolicySchema.partial().default({}),
  /**
   * Folders the AI may WRITE to under the OS sandbox (`bumper run`). Everything
   * outside these (other clients, ~/.ssh, the rest of $HOME) becomes read-only
   * at the kernel level. Reads are not restricted. Absolute paths or ~ .
   */
  writePaths: z.array(z.string()).default([]),
  /** Extra folders readable in addition to the selected workspace. */
  readPaths: z.array(z.string()).default([]),
  /** Explicit exceptions that remain blocked even inside a broader allowed path. */
  denyReadPaths: z.array(z.string()).default([]),
  denyWritePaths: z.array(z.string()).default([]),
  /** How paths currently matched by the project's .gitignore are treated. */
  gitIgnored: z.enum(["visible", "read-only", "hidden"]).default("visible"),
  /**
   * Provider-enforced Room Git token scope. Bumper never inspects git argv.
   *
   * Singular binding, kept because it is still the shape the pre-ladder config
   * on disk uses. `gitRepositories` below is authoritative; these fields are
   * migrated into it on load and mirrored back out so an older build reading
   * the same config still sees its first repository.
   */
  gitAccess: z.enum(["none", "read", "write"]).default("none"),
  /** One selected GitHub owner/name repository by default; no credential is config data. */
  gitRepository: z.string().default(""),
  /** Stable local GitHub App connection id. Selects the PEM; never inferred at token issue time. */
  gitProviderConnectionId: z.string().default(""),
  /** Provider ids pin the exact installation and repository inside the selected connection. */
  gitInstallationId: z.number().int().positive().optional(),
  gitRepositoryId: z.number().int().positive().optional(),
  /**
   * Every repository this Project may reach, each at its own rung of the
   * capability ladder (see src/git-capability.ts).
   *
   * A Project routinely spans app + infra + docs, and those do not deserve the
   * same access — so the rung lives on the binding, not on the Project. An
   * installation token carries one permission set for a list of repositories,
   * so the broker mints one token per (connection, installation, capability)
   * group rather than one token for the Project.
   */
  gitRepositories: z.array(GitRepositoryBindingSchema).default([]),
  /** Optional temporary elevation from read to write. Expiry is host-controlled and non-secret. */
  gitWriteUntil: z.string().default(""),
  /**
   * Legacy field kept for config backward compatibility only.
   * It is not a boundary. Provider-enforced Git access is represented only by
   * gitRepository + gitAccess above.
   */
  repos: z.array(z.string()).default([]),
  /**
   * Optional Library Git Connection id — a name/host label for the Project.
   * Holds no secret and grants no access. GitHub App access is separate.
   */
  gitConnectionId: z.string().optional(),
  /**
   * MCP Hub bindings: Integration id → Connection id (at most one Connection
   * per Integration). Secrets stay in host handles; Room/AI never receive them.
   */
  mcpBindings: z.record(z.string()).default({}),
  /** Network destinations shown as policy intent. Enforcement is adapter-dependent. */
  allowedHosts: z.array(z.string()).default([]),
  /** Sealed-room backend policy. Protected launches run in a Room by default. */
  room: RoomPolicySchema.default({}),
  /** Development capabilities remain host-controlled and Session-revocable. */
  development: DevelopmentPolicySchema,
  /**
   * AI login profile per agent (agentId → profileId). Default profile "default"
   * preserves legacy room-auth host paths. Other profiles isolate login slots.
   */
  loginProfiles: z.record(z.string()).default({}),
  /**
   * Run the AI CLI with its own approval prompts disabled inside the Room.
   *
   * This does NOT widen the boundary: the room still contains only the declared
   * doors and egress. It removes the per-action confirmation UX whose only job
   * was to compensate for the absence of a boundary. Tools without a verified
   * auto-approve flag ignore this (see agents.ts autoApproveArgs).
   */
  autoApprove: z.boolean().default(false),
  /** Last permission setup name applied (UI convenience; not enforced). */
  appliedPermissionSetup: z.string().optional(),
});
export type Context = z.infer<typeof ContextSchema>;

/**
 * Reusable HTTPS Git identity (Library). Secret token is a host-side handle,
 * never stored in this object or returned to the renderer.
 */
export const GitConnectionSchema = z.object({
  name: z.string(),
  provider: z.enum(["github", "gitlab", "bitbucket", "other"]).default("github"),
  /** Hostname only, e.g. github.com — not a URL and not SSH. */
  host: z.string().default("github.com"),
  /** Display label (username/org hint). Not a secret. */
  identity: z.string().default(""),
  /**
   * Commit identity applied only in host copy commands (git -c …). Never written
   * into the repo config unless the user pastes the command themselves.
   */
  userName: z.string().default(""),
  userEmail: z.string().default(""),
  /**
   * Host path to an SSH private key. Path reference only — Bumper never reads
   * the file contents, never stores the key, never mounts it into a Room.
   */
  sshKeyPath: z.string().default(""),
});
export type GitConnection = z.infer<typeof GitConnectionSchema>;

/** Public GitHub App metadata. The private key and installation tokens never live in config. */
export const GitHubAppRepositorySchema = z.object({
  id: z.number().int(),
  fullName: z.string(),
  private: z.boolean().default(true),
});
export type GitHubAppRepository = z.infer<typeof GitHubAppRepositorySchema>;

export const GitHubAppInstallationSchema = z.object({
  id: z.number().int(),
  accountLogin: z.string(),
  accountType: z.string().default(""),
  repositorySelection: z.enum(["all", "selected"]).default("selected"),
  settingsUrl: z.string().url().optional(),
  repositories: z.array(GitHubAppRepositorySchema).default([]),
});
export type GitHubAppInstallation = z.infer<typeof GitHubAppInstallationSchema>;

export const GitHubAppSchema = z.object({
  id: z.string().default(""),
  appId: z.number().int().positive(),
  slug: z.string().min(1),
  /** Account that owns the per-user App. Organization-owned Apps stay private. */
  ownerLogin: z.string().default(""),
  ownerType: z.string().default(""),
  lastRefreshedAt: z.string().optional(),
  installations: z.array(GitHubAppInstallationSchema).default([]),
});
export type GitHubApp = z.infer<typeof GitHubAppSchema>;
export const GitHubAppsSchema = z.record(GitHubAppSchema).default({});

/** Field on an MCP Integration form (Connection values / secret handles). */
export const McpFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  secret: z.boolean().default(false),
  required: z.boolean().default(true),
  /** Env var name passed to the Integration process (defaults to key). */
  envKey: z.string().optional(),
});
export type McpField = z.infer<typeof McpFieldSchema>;

/**
 * Library MCP Integration — launch recipe + Connection field schema.
 * Secrets are never stored here.
 */
export const McpIntegrationSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  transport: z.enum(["stdio"]).default("stdio"),
  fields: z.array(McpFieldSchema).default([]),
});
export type McpIntegration = z.infer<typeof McpIntegrationSchema>;

/**
 * Library MCP Connection — Integration + non-secret field values.
 * Secret field values are host handles, never in this object.
 * `description` is a human memo (import source, workspace note) — never a secret.
 */
export const McpConnectionSchema = z.object({
  name: z.string(),
  integrationId: z.string(),
  values: z.record(z.string()).default({}),
  description: z.string().default(""),
});
export type McpConnection = z.infer<typeof McpConnectionSchema>;

export const ConfigSchema = z.object({
  globalPolicy: GlobalPolicySchema.default({}),
  backends: z.record(BackendSchema).default({}),
  contexts: z.record(ContextSchema).default({}),
  /** Named Permission setup snapshots (boundary reuse across Projects). */
  permissionSetups: z.record(PermissionSetupSchema).default({}),
  /**
   * Known AI login profile ids (global catalog). "default" is always valid
   * even if omitted. Extra ids (e.g. work) appear in Project pickers.
   */
  authProfiles: z.array(z.string()).default(["default"]),
  /** Library Git Connections (credential identity; secrets are host handles). */
  gitConnections: z.record(GitConnectionSchema).default({}),
  /** Legacy singular metadata; migrated to githubApps without discarding its Keychain PEM. */
  githubApp: GitHubAppSchema.optional(),
  /** Owner-scoped local Private GitHub Apps. Keys are stable local connection ids. */
  githubApps: GitHubAppsSchema,
  /** Non-secret connection ids whose remembered tokens need another best-effort revoke after disconnect. */
  githubTokenSweepConnections: z.array(z.string()).default([]),
  /** Library MCP Integrations (launch + field schema). */
  mcpIntegrations: z.record(McpIntegrationSchema).default({}),
  /** Library MCP Connections (values; secrets are host handles). */
  mcpConnections: z.record(McpConnectionSchema).default({}),
  /** Context that is active if none has been selected yet. */
  defaultContext: z.string().optional(),
  /** Port for the local trust-surface web page. */
  /** Local UI port. Zero asks the OS to choose an available ephemeral port. */
  webPort: z.number().int().nonnegative().default(4319),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Result of classifying a single backend tool for the active context. */
export type Access = "read" | "write";

export interface ToolDecision {
  backend: string;
  /** Original tool name on the backend. */
  toolName: string;
  /** Namespaced name exposed to the client, e.g. "github__search_issues". */
  exposedName: string;
  access: Access;
  allowed: boolean;
  /** Why it was allowed/blocked — surfaced to the user for trust. */
  reason: string;
}
