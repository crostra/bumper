import { loadConfig } from "./config.js";
import { getActiveContext } from "./state.js";
import { decideNative } from "./native.js";
import { logEvent } from "./log.js";
import { effectiveContext } from "./effective.js";

interface PreToolUseInput {
  tool_name?: string;
  tool_input?: unknown;
  hook_event_name?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // If nothing is piped, don't hang forever.
    setTimeout(() => resolve(data), 2000).unref();
  });
}

function emitDeny(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `bumper: ${reason}`,
      },
    }),
  );
}

function emitDefer(): void {
  // No decision → the client's normal permission flow applies.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "defer" },
    }),
  );
}

/**
 * Claude Code PreToolUse hook target. Reads the tool call on stdin, asks the
 * bumper policy engine (active context), and denies mutating actions in a
 * read-only context. Fails open (defer) on misconfig so it never bricks the
 * client — but warns on stderr so the gap is visible.
 */
export async function runHook(): Promise<void> {
  const raw = await readStdin();
  let input: PreToolUseInput = {};
  try {
    input = JSON.parse(raw) as PreToolUseInput;
  } catch {
    console.error("bumper hook: could not parse hook input; deferring.");
    return emitDefer();
  }

  const toolName = input.tool_name;
  if (!toolName) return emitDefer();

  let config, activeName;
  try {
    ({ config } = loadConfig());
    activeName = getActiveContext(config.defaultContext);
  } catch (err) {
    console.error(`bumper hook: ${(err as Error).message}; deferring (NOT enforced).`);
    return emitDefer();
  }

  function describeTool(name: string, inp: unknown): string {
    const cmd = (inp as { command?: string; file_path?: string } | undefined)?.command;
    if (name === "Bash" && cmd) return `Bash · ${cmd}`;
    const fp = (inp as { file_path?: string } | undefined)?.file_path;
    if (fp) return `${name} · ${fp}`;
    return name;
  }

  const context = activeName && config.contexts[activeName] ? effectiveContext(config, activeName) : undefined;
  if (!context) {
    console.error(`bumper hook: no active context; deferring (NOT enforced).`);
    return emitDefer();
  }

  const d = decideNative(context, toolName, input.tool_input);
  const target = describeTool(toolName, input.tool_input);
  logEvent({
    context: activeName!,
    surface: "native",
    decision: d.decision === "deny" ? "blocked" : "allowed",
    access: d.access,
    target,
    reason: d.reason,
  });
  if (d.decision === "deny") {
    return emitDeny(`${d.reason} [context "${activeName}", tool ${toolName}]`);
  }
  return emitDefer();
}
