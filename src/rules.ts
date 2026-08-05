import { readFileSync, writeFileSync } from "node:fs";
import { resolveConfigPath } from "./paths.js";
import { loadConfig } from "./config.js";
import { getActiveContext } from "./state.js";
import { readEvents } from "./log.js";

export type Spec =
  | { kind: "native-command"; value: string; label: string } // "Bash:git push"
  | { kind: "native-tool"; value: string; label: string }; // "Write"

/**
 * Git provider results cannot become local Allow/Deny rules. Repository and
 * token scope change only through Project → Git. Generic egress/proxy targets
 * also cannot become rules (change Project → Network instead).
 */
export function inferSpecFromEvent(surface: string, target: string): Spec | undefined {
  if (surface === "network") {
    return undefined;
  }
  if (surface === "native") {
    // "Bash · git push origin main"  |  "Write · /path"
    const [tool, ...rest] = target.split(" · ");
    if (tool === "Bash") {
      const cmd = rest.join(" · ").trim();
      const prefix = cmd.split(/\s+/).slice(0, 2).join(" "); // "git push"
      return { kind: "native-command", value: `Bash:${prefix}`, label: `Bash commands starting "${prefix}"` };
    }
    return { kind: "native-tool", value: tool, label: `the ${tool} tool` };
  }
  return undefined;
}

/**
 * Parse an explicit rule string a user typed.
 * Host/path-shaped strings (e.g. github.com/acme) used to mean "repo allow";
 * that path is gone — Git scope is a Project/provider setting.
 */
export function inferSpecFromString(s: string): Spec {
  const trimmed = String(s ?? "").trim();
  if (!trimmed) throw new Error("Empty rule.");
  // Reject legacy "bumper allow github.com/acme" style — no longer a rule.
  if (!trimmed.includes(":") && trimmed.includes("/") && /\./.test(trimmed)) {
    throw new Error(
      "A repository cannot become a local Allow rule. Choose its GitHub token scope in Project → Git.",
    );
  }
  if (trimmed.includes(":")) return { kind: "native-command", value: trimmed, label: trimmed };
  return { kind: "native-tool", value: trimmed, label: `the ${trimmed} tool` };
}

function ensureArray(obj: any, key: string): string[] {
  if (!Array.isArray(obj[key])) obj[key] = [];
  return obj[key];
}

function readRaw(): { path: string; raw: any } {
  const path = resolveConfigPath();
  return { path, raw: JSON.parse(readFileSync(path, "utf8")) };
}

/** Add (or remove) a native intent rule on a context. Returns a human description. */
export function applyRule(action: "allow" | "deny", spec: Spec, contextName?: string): { context: string; message: string } {
  const { config } = loadConfig();
  const context = contextName ?? getActiveContext(config.defaultContext);
  if (!context) throw new Error("No active context. Run `bumper use <context>` first.");

  const { path, raw } = readRaw();
  const ctx = raw.contexts?.[context];
  if (!ctx) throw new Error(`Context "${context}" not found in config.`);

  // Never write ctx.repos — legacy field kept only for config read compatibility.
  // native — command/tool rules are hook/Seatbelt intent; Room does not enforce them as an OS boundary.
  ctx.native = ctx.native ?? { allow: [], deny: [] };
  const allow = ensureArray(ctx.native, "allow");
  const deny = ensureArray(ctx.native, "deny");
  let message: string;
  if (action === "allow") {
    if (!allow.includes(spec.value)) allow.push(spec.value);
    ctx.native.deny = deny.filter((d: string) => d !== spec.value);
    message = `Saved allow intent for ${spec.label} in "${context}" (new sessions). Not enforced inside Sandbox — does not open the current Sandbox filesystem or network boundary.`;
  } else {
    if (!deny.includes(spec.value)) deny.push(spec.value);
    ctx.native.allow = allow.filter((a: string) => a !== spec.value);
    message = `Saved block intent for ${spec.label} in "${context}" (new sessions). Not enforced as a Room OS boundary.`;
  }
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  return { context, message };
}

/** The most recent blocked event (for `bumper allow last`). */
export function lastBlockedSpec(): Spec | undefined {
  const [ev] = readEvents({ decision: "blocked", limit: 1 });
  if (!ev) return undefined;
  return inferSpecFromEvent(ev.surface, ev.target);
}
