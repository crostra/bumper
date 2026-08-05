/**
 * Enforcement-source classification for a project's effective policy.
 *
 * The audit's central risk is that the UI blurs different enforcement sources:
 *
 *  - "vm"           — enforced structurally by the Apple container microVM. The
 *                     room simply does not contain anything else; there is no
 *                     bypass short of a hypervisor escape. This is the strong
 *                     guarantee and should read as such.
 *  - "broker"       — enforced by a Bumper-side broker the room must go through
 *                     (today: the MCP Hub). Strong, but it lives on the host,
 *                     not in the kernel, and only covers the path that actually
 *                     routes through it. A broker can only hold a boundary when
 *                     the room never obtains the capability itself — which is
 *                     why a provider-enforced Git token is described separately.
 *  - "provider"     — enforced by the remote provider on a capability already
 *                     inside the room (today: GitHub repository + contents scope).
 *  - "not-enforced" — policy *intent* that the Room backend does not (yet)
 *                     enforce. Showing it as if it were enforced is the exact
 *                     confusion this module exists to prevent.
 *
 * Everything here is pure and derived from the effective Context, so it can be
 * unit-tested and shown identically in the app and in verification output.
 */
import type { Context } from "../types.js";

export type EnforcementSource = "vm" | "broker" | "provider" | "not-enforced";

export interface AssuranceItem {
  id: string;
  label: string;
  detail: string;
  source: EnforcementSource;
}

export const ASSURANCE_LEGEND: Record<EnforcementSource, string> = {
  vm: "Enforced by the Apple container microVM — structural, no bypass.",
  broker: "Enforced by a Bumper broker the room routes through (host-side).",
  provider: "Enforced by the remote provider on the short-lived capability.",
  "not-enforced": "Policy intent only — the Sandbox backend does not enforce this yet.",
};

/** Does this project mount its whole workspace as one door? */
function mountsWholeWorkspace(context: Context): boolean {
  return context.room.workspaceShare !== "selected";
}

/** Build the ordered assurance list for a project's effective policy. */
export function roomAssurance(context: Context): AssuranceItem[] {
  const items: AssuranceItem[] = [];
  const room = context.room;

  items.push({
    id: "sealed-room",
    label: "Sealed room",
    detail: `Apple container microVM from ${room.image || "not set"}; only declared doors exist. Host home is absent.`,
    source: "vm",
  });

  const selected = context.room.workspaceShare === "selected";
  const subCount = selected ? (context.room.shareSubpaths ?? []).filter((s) => s.trim()).length : 0;
  const rw = context.mode === "read-write";
  items.push({
    id: "workspace-door",
    label: selected
      ? `${subCount} workspace sub-folder${subCount === 1 ? "" : "s"} shared (${rw ? "read-write" : "read-only"})`
      : rw ? "Workspace is read-write" : "Workspace is read-only",
    detail: selected
      ? "Only the listed sub-folders are mounted; the rest of the workspace does not exist inside the room."
      : rw
        ? "The whole workspace door is mounted read-write; everything outside it is unreachable."
        : "The whole workspace door is mounted read-only; writes fail at the mount.",
    source: "vm",
  });

  const extraDoors = (context.readPaths?.length ?? 0) + (context.writePaths?.length ?? 0) + (context.room.doors?.length ?? 0);
  if (extraDoors > 0) {
    items.push({
      id: "shared-folders",
      label: `${extraDoors} extra shared folder${extraDoors === 1 ? "" : "s"}`,
      detail: "Only these additional folders are shared in; each keeps its own read-only / read-write access.",
      source: "vm",
    });
  }

  switch (room.egress) {
    case "open":
      items.push({
        id: "egress",
        label: "Network is Open — unrestricted",
        detail: "The room can reach any host. This is not a protected allowlist — Bumper is not filtering egress.",
        source: "not-enforced",
      });
      break;
    case "allowlist": {
      const hostCount = (room.egressTemplates?.length ?? 0) + (room.egressHosts?.length ?? 0);
      items.push({
        id: "egress",
        label: `Network is Allowlist — ${hostCount} host group${hostCount === 1 ? "" : "s"}`,
        detail: "The room runs on a host-only network: the only address it can reach is this Mac, where Bumper's filtering proxy decides each host. A direct-IP connection, another machine on your LAN and external DNS are all unreachable — the allowlist is not a convention the room could ignore.",
        source: "vm",
      });
      break;
    }
    default:
      items.push({
        id: "egress",
        label: "Network is Off — no network",
        detail: "The room has no network (--network none); only loopback exists. Direct Internet and DNS fail.",
        source: "vm",
      });
  }

  /*
   * Be explicit about what a network — of any kind — still exposes. Reaching
   * the host is exactly how the allowlist proxy works, so it cannot be removed;
   * what matters is that it is stated rather than discovered. Bumper's own
   * control plane binds 127.0.0.1 only and is not reachable this way, but a
   * dev server bound to 0.0.0.0 on this Mac is.
   */
  if (room.egress !== "blocked") {
    items.push({
      id: "host-services",
      label: "Services listening on this Mac are reachable",
      detail: room.egress === "allowlist"
        ? "A host-only network means the room can still open ports on this Mac. Bumper's own control plane is bound to 127.0.0.1 and stays unreachable, but your own dev servers bound to 0.0.0.0 are visible to the room. Use Network Off for work that should reach nothing."
        : "An open network reaches both the Internet and services on this Mac. Bumper's own control plane is bound to 127.0.0.1 and stays unreachable.",
      source: "not-enforced",
    });
  }

  const configuredGitAccess = context.gitAccess ?? "none";
  const temporaryWriteUntil = Date.parse(context.gitWriteUntil ?? "");
  const gitAccess = configuredGitAccess === "read"
    && Number.isFinite(temporaryWriteUntil)
    && temporaryWriteUntil > Date.now()
    ? "write"
    : configuredGitAccess;
  if (gitAccess === "none") {
    items.push({
      id: "git-credentials", label: "No host git identity in the room",
      detail: "~/.ssh, ~/.netrc and the host git credential store are not mounted. This Project does not receive a Git credential.", source: "vm",
    });
  } else {
    items.push({
      id: "git-credentials", label: "No host git identity; provider-scoped Git token",
      detail: `~/.ssh, ~/.netrc and the host git credential store are not mounted. GitHub issues a short-lived ${gitAccess === "write" ? "read and write" : "read-only"} token only for this Project's selected repository. Bumper does not inspect git command contents.`,
      source: "provider",
    });
  }

  const mcpCount = Object.keys(context.mcpBindings ?? {}).length;
  /*
   * Two separate truths, and conflating them is exactly the confusion this
   * module exists to prevent:
   *  - the Sandbox never receives the Connection's credential (host-side broker), and
   *  - a bound Connection is a capability that reaches *past* the Sandbox's walls
   *    by construction. Binding one is a decision about blast radius, not a
   *    containment feature, so this is never `vm`.
   */
  items.push({
    id: "mcp-hub",
    label: mcpCount
      ? `MCP Hub: ${mcpCount} Connection${mcpCount === 1 ? "" : "s"} reach the AI, credentials do not`
      : "MCP Hub: no Connections bound",
    detail: mcpCount
      ? "The AI calls tools through a bridge on the Connector door; the MCP servers and their secrets run on this Mac and are never mounted into the Room. Every call is decided against this Project's read-only / read-write mode and appears in Events. The tools themselves act outside the Room — bind only what this Project should reach."
      : "Bind a Library MCP Connection on Project → Connections to give the AI tools. Nothing MCP-related is reachable from the Room until you do.",
    source: "broker",
  });

  // Subtree deny-lists are NOT honored while the whole workspace is one door:
  // a denied subfolder is still inside the mounted /workspace tree. Be honest.
  const denies = (context.denyReadPaths?.length ?? 0) + (context.denyWritePaths?.length ?? 0);
  if (denies > 0 && mountsWholeWorkspace(context)) {
    items.push({
      id: "hidden-subpaths",
      label: `${denies} hidden subpath${denies === 1 ? "" : "s"} not enforced in Sandbox`,
      detail: "These deny-list paths sit inside the mounted workspace, so the room can still reach them. Share only the sub-folders you want visible instead.",
      source: "not-enforced",
    });
  }

  // Command categories other than git push are a Seatbelt/hook-era concept and
  // are not applied inside the room; git push is covered by the broker above.
  const cmds = context.commands ?? {};
  const nonGitBlocks = [cmds.shellWrite === "block", cmds.unknown === "block"].filter(Boolean).length;
  if (nonGitBlocks > 0) {
    items.push({
      id: "command-rules",
      label: "Shell command rules are not enforced in Sandbox",
      detail: "Command classification (shell / unknown) was a Seatbelt/hook control. Inside the room, safety comes from the filesystem and network boundary, not command matching.",
      source: "not-enforced",
    });
  }

  return items;
}
