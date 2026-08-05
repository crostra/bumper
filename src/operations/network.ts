/**
 * Project network (egress) — the one place the mode is validated and written.
 *
 * The GUI's Network control and `bumper network` both land here, so "Off means
 * Off" is decided once. `normalizeEgress` is exported separately because
 * app.ts's saveContext still rebuilds a whole Context from an HTTP form blob;
 * sharing the normalizer keeps the two write paths from drifting on what counts
 * as a valid mode or a usable host, ahead of that handler being extracted.
 */
import type { Config, Context } from "../types.js";
import { EGRESS_TEMPLATES, egressTemplateHosts } from "../room/egress-proxy.js";
import { OperationError } from "./error.js";

export type EgressMode = "blocked" | "allowlist" | "open";

/** CLI verbs → stored mode. The stored words are not the words users say. */
export const NETWORK_VERBS: Record<string, EgressMode> = {
  off: "blocked",
  blocked: "blocked",
  allowed: "allowlist",
  allowlist: "allowlist",
  open: "open",
};

/** The label the GUI shows for a stored mode. Kept identical on purpose. */
export function networkLabel(mode: EgressMode): string {
  switch (mode) {
    case "blocked": return "Off";
    case "allowlist": return "Allowed only";
    case "open": return "Open";
  }
}

export function networkSentence(mode: EgressMode): string {
  switch (mode) {
    case "blocked": return "No internet";
    case "allowlist": return "Allowed sites only";
    case "open": return "Full internet";
  }
}

export function listEgressTemplates(): { id: string; label: string; hosts: string[] }[] {
  return Object.entries(EGRESS_TEMPLATES).map(([id, value]) => ({ id, label: value.label, hosts: value.hosts }));
}

export interface NormalizedEgress {
  egress: EgressMode;
  egressTemplates: string[];
  egressHosts: string[];
}

/**
 * Coerce arbitrary input into a storable egress triple.
 * Unknown modes fall back to "blocked" — the safe direction, matching the GUI.
 */
export function normalizeEgress(input: {
  egress?: unknown;
  egressTemplates?: unknown;
  egressHosts?: unknown;
}): NormalizedEgress {
  const mode: EgressMode =
    input.egress === "open" || input.egress === "allowlist" ? input.egress : "blocked";
  const templates = Array.isArray(input.egressTemplates)
    ? input.egressTemplates.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const hosts = Array.isArray(input.egressHosts)
    ? input.egressHosts.map((value) => String(value).trim()).filter(Boolean)
    : [];
  return {
    egress: mode,
    egressTemplates: [...new Set(templates)],
    egressHosts: [...new Set(hosts)],
  };
}

export interface SetProjectNetworkInput {
  config: Config;
  projectName: string;
  mode: EgressMode;
  /** Replaces the stored list when the mode is "allowlist". */
  hosts?: string[];
  /** Vendor template ids (see listEgressTemplates). */
  templates?: string[];
}

export interface SetProjectNetworkResult {
  projectName: string;
  previous: NormalizedEgress;
  next: NormalizedEgress;
  /** Hosts the allowlist actually resolves to (templates expanded). */
  effectiveHosts: string[];
  /** Bumper applies boundary changes to new Sessions, never to a running one. */
  appliesToNewSessions: true;
}

/**
 * Set a Project's network mode. Mutates `config` in memory; the caller persists.
 *
 * Persistence stays with the caller because the two adapters already own
 * different write paths (`writeRawConfig` in the GUI, the config-store write in
 * the CLI). What must not differ — validation, allowlist emptiness, template
 * expansion — is what lives here.
 */
export function setProjectNetwork(input: SetProjectNetworkInput): SetProjectNetworkResult {
  const name = input.projectName.trim();
  const project: Context | undefined = input.config.contexts[name];
  if (!project) {
    const available = Object.keys(input.config.contexts).join(", ") || "(none)";
    throw new OperationError("not-found", `Unknown project "${name}". Available: ${available}.`, [
      "bumper contexts        # list Projects",
    ]);
  }

  const previous = normalizeEgress(project.room ?? {});

  const templates = [...new Set((input.templates ?? []).map((value) => value.trim()).filter(Boolean))];
  const unknown = templates.filter((id) => !EGRESS_TEMPLATES[id]);
  if (unknown.length) {
    throw new OperationError(
      "invalid",
      `Unknown network template${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
      [`Available: ${Object.keys(EGRESS_TEMPLATES).join(", ")}`],
    );
  }

  const hosts = [...new Set((input.hosts ?? []).map((value) => value.trim()).filter(Boolean))];
  for (const host of hosts) {
    // A host, not a URL and not a path — the proxy matches on hostname.
    if (/[/\s]/.test(host) || host.includes("://")) {
      throw new OperationError("invalid", `"${host}" is not a hostname.`, [
        "Pass bare hosts: bumper network allowed api.anthropic.com github.com",
      ]);
    }
  }

  const next: NormalizedEgress =
    input.mode === "allowlist"
      ? { egress: "allowlist", egressTemplates: templates, egressHosts: hosts }
      // Off / Open keep the stored allowlist so switching back does not lose it.
      : { egress: input.mode, egressTemplates: previous.egressTemplates, egressHosts: previous.egressHosts };

  const effectiveHosts =
    next.egress === "allowlist"
      ? [...new Set([...egressTemplateHosts(next.egressTemplates), ...next.egressHosts])]
      : [];

  if (next.egress === "allowlist" && effectiveHosts.length === 0) {
    throw new OperationError(
      "invalid",
      "Allowed only with an empty list would block everything without saying so. Name at least one host or template.",
      [
        "bumper network allowed api.anthropic.com",
        `bumper network allowed --template ${Object.keys(EGRESS_TEMPLATES)[0]}`,
        "bumper network off        # if blocking everything is what you want",
      ],
    );
  }

  project.room = {
    ...project.room,
    enabled: project.room?.enabled !== false,
    image: project.room?.image ?? "",
    ...next,
  } as Context["room"];

  return {
    projectName: name,
    previous,
    next,
    effectiveHosts,
    appliesToNewSessions: true,
  };
}
