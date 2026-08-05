import type { RunResult } from "./backend.js";

export interface RoomExecutablePreflight {
  executable: string;
  command: string[];
}

/**
 * Exit code meaning "the CLI is fine, but this image has no node".
 *
 * The MCP Hub bridge inside a Room is a node script, and a custom image may not
 * carry node. That must not fail the launch — the Room is still a Room — so it
 * gets its own code and the launch paths drop MCP and say so.
 */
export const ROOM_MCP_RUNTIME_MISSING_EXIT = 3;

/**
 * One-shot check that the target CLI is on PATH and resolvable after the same
 * mounts launch will use (including auth doors). Also fails when `command -v`
 * finds a symlink whose target is missing — the classic empty auth overlay
 * over a vendor home tree that held the real binary.
 *
 * With `requireNode`, the same run also reports whether the MCP Hub bridge can
 * run here — one container start instead of two.
 */
export function roomExecutablePreflight(
  command: string[],
  options: { requireNode?: boolean } = {},
): RoomExecutablePreflight {
  const executable = command[0]?.trim();
  if (!executable) throw new Error("Sandbox command is empty.");
  // $1 = executable name. Resolve, require executable bit, and if it is a
  // symlink require the ultimate target to exist (broken link after overlay).
  const script = [
    'bin=$(command -v "$1") || exit 1',
    'test -n "$bin" || exit 1',
    'test -x "$bin" || exit 1',
    'if [ -L "$bin" ]; then',
    '  target=$(readlink -f "$bin" 2>/dev/null || true)',
    '  if [ -z "$target" ]; then target=$(readlink "$bin" 2>/dev/null || true); fi',
    '  case "$target" in',
    '    /*) test -e "$target" || exit 1 ;;',
    '    *) dir=$(dirname "$bin"); test -e "$dir/$target" || exit 1 ;;',
    "  esac",
    "fi",
    ...(options.requireNode
      ? [`command -v node >/dev/null 2>&1 || exit ${ROOM_MCP_RUNTIME_MISSING_EXIT}`]
      : []),
  ].join("\n");
  return {
    executable,
    command: ["/bin/sh", "-c", script, "bumper-preflight", executable],
  };
}

export function roomPreflightSuccessDetail(agentName: string, executable: string, image: string): string {
  return `${agentName} is ready: "${executable}" exists in Sandbox image ${image}.`;
}

function diagnosticOutput(result?: RunResult): string {
  const output = [result?.stderr, result?.stdout].map((value) => value?.trim()).filter(Boolean).join("\n");
  return output.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\[\d+\/\d+\]\s/.test(line))
    .join("\n");
}

export function roomPreflightFailureDetail(agentName: string, command: string[], image: string, result?: RunResult): string {
  const executable = command[0] || "(empty command)";
  const rawOutput = [result?.stderr, result?.stdout].map((value) => value?.trim()).filter(Boolean).join("\n");
  const output = diagnosticOutput(result);
  const shellMissing = rawOutput.includes("/bin/sh") && /not found|failed to find target executable|no such file/i.test(rawOutput);
  if (shellMissing) {
    return `${agentName} cannot be checked because Sandbox image ${image} does not include /bin/sh. Use a Linux image with /bin/sh and "${executable}".`;
  }
  const diagnostic = output ? ` Container detail: ${output}` : "";
  const recommended = /bumper\/ai-room/.test(image);
  const rebuildHint = recommended
    ? ` If auth mounts hide "${executable}", the local image likely predates materialize_path_bin — run: bumper room-image build --force`
    : "";
  return `${agentName} cannot start in Sandbox image ${image}: executable "${executable}" was not found. Use a Sandbox image that includes "${executable}", then launch again.${rebuildHint}${diagnostic}`;
}
