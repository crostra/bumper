import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stateDir } from "../paths.js";

const CONTAINER_BIN = "/usr/local/bin/container";

export const RECOMMENDED_ROOM_IMAGE = "bumper/ai-room:latest";

/**
 * Recipe id stamped on the recommended image. Bump when auth/binary layout
 * changes in a way that requires rebuild (e.g. materialize_path_bin).
 */
export const RECOMMENDED_ROOM_RECIPE = "materialize_path_bin-v2";
export const RECOMMENDED_ROOM_RECIPE_LABEL = "com.crostra.bumper.room-recipe";

export interface RoomBuildResult {
  ok: boolean;
  image: string;
  containerfile: string;
  log: string;
  /** When ok is false: the install step we believe failed, and a hint. */
  failedTool?: string;
  hint?: string;
  /** Present after a successful build when auth-overlay probe ran. */
  verifyOk?: boolean;
  verifyDetail?: string;
}

export interface RoomBuildOptions {
  /** Skip build cache — required to replace a pre-materialize_path_bin image reliably. */
  noCache?: boolean;
  /** After build, probe bins under empty auth overlays (default true). */
  verify?: boolean;
}

export interface RecommendedRoomRecipeStatus {
  present: boolean;
  recipe?: string;
  /** True when image exists but lacks the current recipe label (or wrong recipe). */
  stale: boolean;
  detail: string;
}

/**
 * The install steps in the recommended Containerfile, in build order, each with
 * patterns that identify its lines in `--progress plain` output. Used to name
 * the tool whose install failed instead of dumping a raw log at the user.
 */
const BUILD_STEPS: { tool: string; hint: string; patterns: RegExp[] }[] = [
  { tool: "System packages", hint: "apt-get could not install base packages — check the base image and network.", patterns: [/apt-get/, /bookworm/] },
  { tool: "Claude Code & Codex (npm)", hint: "npm could not install the Anthropic/OpenAI CLIs — check the npm registry is reachable.", patterns: [/npm install -g/, /@anthropic-ai\/claude-code/, /@openai\/codex/] },
  { tool: "Cursor Agent", hint: "cursor.com/install failed — the vendor script or its download may have changed.", patterns: [/cursor\.com\/install/, /cursor-agent/] },
  { tool: "Antigravity CLI", hint: "antigravity.google install script failed — the vendor script may have changed.", patterns: [/antigravity\.google/, /\bagy\b/] },
  { tool: "Grok CLI", hint: "x.ai/cli install script failed — the vendor script may have changed.", patterns: [/x\.ai\/cli/, /\bgrok\b/] },
];

/**
 * Guess which install step a failed build died in, by finding the step whose
 * markers appear latest in the log (the build got furthest into that step).
 */
export function classifyBuildFailure(log: string): { failedTool: string; hint: string } | undefined {
  let best: { tool: string; hint: string; at: number } | undefined;
  for (const step of BUILD_STEPS) {
    let at = -1;
    for (const pattern of step.patterns) {
      const index = log.search(pattern);
      // search() returns the first match; scan for the LAST by walking matches.
      const global = new RegExp(pattern.source, "g");
      let m: RegExpExecArray | null;
      while ((m = global.exec(log))) at = Math.max(at, m.index);
      if (index < 0) continue;
    }
    if (at >= 0 && (!best || at > best.at)) best = { tool: step.tool, hint: step.hint, at };
  }
  return best ? { failedTool: best.tool, hint: best.hint } : undefined;
}

/** Human description of where a Room image comes from, for the UI. */
export function describeImageSource(image: string): { kind: "recommended" | "custom" | "base"; label: string } {
  if (image === RECOMMENDED_ROOM_IMAGE) return { kind: "recommended", label: "Bumper recommended AI Sandbox image" };
  if (/^(docker\.io\/library\/)?(alpine|ubuntu|debian|node)(:|$)/.test(image)) {
    return { kind: "base", label: "Plain Linux base image — no AI CLIs preinstalled" };
  }
  return { kind: "custom", label: `Custom image (${basename(image)}) — your own or your company's` };
}

export function roomImageBuildDir(): string {
  return join(stateDir(), "room-image");
}

export function recommendedRoomDockerfile(): string {
  return `FROM docker.io/library/node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.local/bin:/usr/local/bin:$PATH"

RUN apt-get update \\
  && apt-get install -y --no-install-recommends \\
    bash ca-certificates curl git jq openssh-client python3 python3-pip ripgrep \\
  && rm -rf /var/lib/apt/lists/*

# Claude Code and ChatGPT Codex publish npm installation paths for Linux.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Cursor Agent, Antigravity, and Grok Build publish Linux install scripts.
RUN curl https://cursor.com/install -fsS | bash \\
  && if [ -x /root/.local/bin/agent ] && [ ! -e /root/.local/bin/cursor-agent ]; then ln -s /root/.local/bin/agent /root/.local/bin/cursor-agent; fi \\
  && test -x /root/.local/bin/cursor-agent

RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \\
  && test -x /root/.local/bin/agy

RUN curl -fsSL https://x.ai/cli/install.sh | bash \\
  && test -x /root/.local/bin/grok

# Keep PATH binaries as real files under /root/.local/bin so empty auth-door
# overlays (e.g. host state at /root/.grok) cannot hide vendor-tree installs.
RUN set -eu; \\
  materialize_path_bin() { \\
    name="$1"; \\
    dest="/root/.local/bin/$name"; \\
    mkdir -p /root/.local/bin; \\
    if [ -L "$dest" ]; then \\
      target=$(readlink -f "$dest" 2>/dev/null || readlink "$dest" || true); \\
      if [ -n "$target" ] && [ -x "$target" ]; then \\
        cp -f "$target" "$dest.real" && mv -f "$dest.real" "$dest" && chmod a+x "$dest"; \\
      fi; \\
    fi; \\
    if [ ! -x "$dest" ]; then \\
      for candidate in "/root/.grok/bin/$name" "/root/.local/share/$name/$name" "/usr/local/bin/$name" "/usr/bin/$name"; do \\
        if [ -x "$candidate" ] && [ ! -d "$candidate" ]; then \\
          cp -fL "$candidate" "$dest" 2>/dev/null || cp -f "$candidate" "$dest"; \\
          chmod a+x "$dest"; \\
          break; \\
        fi; \\
      done; \\
    fi; \\
    test -x "$dest"; \\
    if [ -L "$dest" ]; then \\
      target=$(readlink -f "$dest" 2>/dev/null || readlink "$dest" || true); \\
      case "$target" in \\
        /root/.grok/*|/root/.claude/*|/root/.codex/*|/root/.cursor/*|/root/.antigravity/*) \\
          echo "refusing PATH symlink into auth overlay tree: $dest -> $target" >&2; exit 1 ;; \\
      esac; \\
    fi; \\
  }; \\
  wrap_path_bin() { \\
    name="$1"; vendor="$2"; \\
    dest="/root/.local/bin/$name"; \\
    test -x "$vendor"; \\
    case "$vendor" in \\
      /root/.grok/*|/root/.claude/*|/root/.codex/*|/root/.cursor/*|/root/.antigravity/*|/root/.config/*) \\
        echo "refusing wrapper into auth overlay tree: $dest -> $vendor" >&2; exit 1 ;; \\
    esac; \\
    printf '#!/bin/sh\\nexec "%s" "$@"\\n' "$vendor" > "$dest.wrap"; \\
    mv -f "$dest.wrap" "$dest"; \\
    chmod a+x "$dest"; \\
  }; \\
  cursor_launcher=$(ls -d /root/.local/share/cursor-agent/versions/*/cursor-agent 2>/dev/null | tail -1 || true); \\
  if [ -n "$cursor_launcher" ]; then \\
    wrap_path_bin cursor-agent "$cursor_launcher"; \\
  else \\
    materialize_path_bin cursor-agent; \\
  fi; \\
  materialize_path_bin agy; \\
  materialize_path_bin grok; \\
  if [ -L /root/.local/bin/grok ]; then echo "grok must not remain a symlink into /root/.grok" >&2; exit 1; fi; \\
  command -v claude; \\
  command -v codex; \\
  command -v cursor-agent; \\
  command -v agy; \\
  command -v grok

# Every CLI must actually RUN, not merely exist on PATH. Copying a vendor
# launcher out of its install tree can break how it finds its own runtime
# (cursor-agent derives NODE_BIN from the script's own directory), which a
# command -v check cannot catch — that failure only appears at first launch.
RUN set -eu; \\
  claude --version >/dev/null; \\
  codex --version >/dev/null; \\
  cursor-agent --version >/dev/null; \\
  agy --help >/dev/null; \\
  grok --version >/dev/null

# Stamped so bumper status / room-image verify can detect pre-materialize images.
LABEL ${RECOMMENDED_ROOM_RECIPE_LABEL}="${RECOMMENDED_ROOM_RECIPE}"

WORKDIR /workspace
CMD ["/bin/bash"]
`;
}

export function writeRecommendedRoomDockerfile(): string {
  const dir = roomImageBuildDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "Containerfile");
  writeFileSync(path, recommendedRoomDockerfile(), { mode: 0o600 });
  return path;
}

/**
 * Parse `container image inspect` JSON for the Bumper recipe label.
 * Exported for unit tests (no live container required).
 */
export function recipeFromImageInspect(inspectJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspectJson);
  } catch {
    return undefined;
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const root = entry as Record<string, unknown>;
    const candidates: unknown[] = [
      root.Labels,
      root.labels,
      (root.config as Record<string, unknown> | undefined)?.Labels,
      (root.config as Record<string, unknown> | undefined)?.labels,
      ((root.config as Record<string, unknown> | undefined)?.config as Record<string, unknown> | undefined)?.Labels,
      ((root.variants as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined)?.config
        && ((((root.variants as unknown[])[0] as Record<string, unknown>).config as Record<string, unknown>).config as Record<string, unknown> | undefined)?.Labels,
      (root.configuration as Record<string, unknown> | undefined)?.descriptor
        && (((root.configuration as Record<string, unknown>).descriptor as Record<string, unknown>).annotations as Record<string, unknown> | undefined),
    ];
    for (const labels of candidates) {
      if (!labels || typeof labels !== "object") continue;
      const value = (labels as Record<string, unknown>)[RECOMMENDED_ROOM_RECIPE_LABEL];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    // Fallback: history created_by mentioning materialize_path_bin (pre-label rebuilds).
    const history = ((root.variants as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined)?.config
      && ((((root.variants as unknown[])[0] as Record<string, unknown>).config as Record<string, unknown>).history as unknown[]);
    const hist = Array.isArray(history) ? history : (root.History as unknown[]) || (root.history as unknown[]);
    if (Array.isArray(hist)) {
      for (const step of hist) {
        const createdBy = String((step as Record<string, unknown>)?.created_by ?? (step as Record<string, unknown>)?.CreatedBy ?? "");
        if (createdBy.includes("materialize_path_bin")) return RECOMMENDED_ROOM_RECIPE;
      }
    }
  }
  return undefined;
}

/** Inspect local recommended image for the recipe stamp (fast; no run). */
/** Unconfigured safe base: a plain Linux image with zero AI CLIs. */
export const SAFE_BASE_ROOM_IMAGE = "docker.io/library/alpine:3.20";

/**
 * Image a brand-new Project should start on.
 *
 * The safe base (no AI CLIs) stays the default so Bumper never downloads or
 * builds anything on its own. But when the user has already built the
 * recommended image, starting a new Project on the base image is a dead end:
 * the first `bumper <cli>` refuses for a reason the user already resolved.
 */
export function initialRoomImage(): string {
  try {
    const status = inspectRecommendedRoomRecipe();
    if (status.present && !status.stale) return RECOMMENDED_ROOM_IMAGE;
  } catch {
    /* container CLI missing — keep the safe base */
  }
  return SAFE_BASE_ROOM_IMAGE;
}

export function inspectRecommendedRoomRecipe(image = RECOMMENDED_ROOM_IMAGE): RecommendedRoomRecipeStatus {
  const probe = spawnSync(CONTAINER_BIN, ["image", "inspect", image], { encoding: "utf8", timeout: 30_000 });
  if (probe.error) {
    return { present: false, stale: false, detail: probe.error.message };
  }
  if (probe.status !== 0) {
    const err = (probe.stderr || probe.stdout || "image not found").trim();
    return { present: false, stale: false, detail: err || `Image ${image} not found locally.` };
  }
  const recipe = recipeFromImageInspect(probe.stdout || "[]");
  if (!recipe) {
    return {
      present: true,
      stale: true,
      detail: `${image} predates ${RECOMMENDED_ROOM_RECIPE} (no recipe label). Rebuild with: bumper room-image build --force`,
    };
  }
  if (recipe !== RECOMMENDED_ROOM_RECIPE) {
    return {
      present: true,
      recipe,
      stale: true,
      detail: `${image} has recipe ${recipe}; need ${RECOMMENDED_ROOM_RECIPE}. Rebuild: bumper room-image build --force`,
    };
  }
  return {
    present: true,
    recipe,
    stale: false,
    detail: `${image} recipe ${recipe} (materialize_path_bin; bins outside auth overlays).`,
  };
}

/**
 * Shell probe: PATH CLIs that vendors often leave as symlinks into auth trees
 * must remain real executables when those trees are empty overlays.
 */
export function authOverlayProbeScript(): string {
  return [
    "set -eu",
    "fail=0",
    "for name in cursor-agent agy grok; do",
    '  bin=$(command -v "$name" || true)',
    '  if [ -z "$bin" ] || [ ! -x "$bin" ]; then echo "MISSING $name"; fail=1; continue; fi',
    '  if [ -L "$bin" ]; then',
    '    target=$(readlink -f "$bin" 2>/dev/null || readlink "$bin" || true)',
    '    case "$target" in',
    "      /root/.grok/*|/root/.claude/*|/root/.codex/*|/root/.cursor/*|/root/.gemini/*|/root/.config/cursor/*|/root/.antigravity/*|/root/.config/antigravity/*)",
    '        echo "STALE_SYMLINK $name -> $target"; fail=1 ;;',
    "    esac",
    "  fi",
    "done",
    'if [ "$fail" -ne 0 ]; then exit 1; fi',
    'echo "AUTH_OVERLAY_OK"',
  ].join("\n");
}

/**
 * Run recommended image with empty auth-door mounts and confirm materialize_path_bin
 * kept cursor-agent / agy / grok usable (the failure mode of pre-Phase-0 images).
 */
export function verifyRecommendedRoomAuthOverlay(image = RECOMMENDED_ROOM_IMAGE): { ok: boolean; detail: string } {
  const emptyRoot = mkdtempSync(join(tmpdir(), "bumper-auth-probe-"));
  const mounts = [
    "/root/.grok",
    "/root/.claude",
    "/root/.codex",
    "/root/.cursor",
    "/root/.gemini",
    "/root/.antigravity",
    "/root/.config/cursor",
    "/root/.config/antigravity",
  ];
  try {
    for (const roomPath of mounts) {
      mkdirSync(join(emptyRoot, roomPath.replace(/\//g, "_")), { recursive: true });
    }
    const args = ["run", "--rm", "--cap-drop", "ALL"];
    for (const roomPath of mounts) {
      const host = join(emptyRoot, roomPath.replace(/\//g, "_"));
      args.push("--mount", `type=bind,source=${host},target=${roomPath}`);
    }
    args.push(image, "/bin/sh", "-c", authOverlayProbeScript());
    const probe = spawnSync(CONTAINER_BIN, args, { encoding: "utf8", timeout: 120_000 });
    const out = `${probe.stdout || ""}\n${probe.stderr || ""}`.trim();
    if (probe.error) return { ok: false, detail: probe.error.message };
    if (probe.status === 0 && /AUTH_OVERLAY_OK/.test(out)) {
      return { ok: true, detail: "PATH CLIs survive empty auth overlays (materialize_path_bin)." };
    }
    const hint = /STALE_SYMLINK|MISSING/.test(out)
      ? " Image still symlinks CLIs into auth trees — rebuild with bumper room-image build --force."
      : "";
    return { ok: false, detail: `${out.slice(0, 500) || `probe exited ${probe.status}`}.${hint}` };
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
}

/**
 * Build the recommended Room image, streaming each log line to `onLog` as it
 * arrives so the UI can show live progress. Returns a structured result instead
 * of throwing: on failure it still carries the full log plus the tool we believe
 * failed, so the user gets an actionable message rather than a stack trace.
 *
 * Prefer `noCache: true` when replacing an older local `bumper/ai-room:latest`
 * that still symlinks grok into `/root/.grok` (auth overlay hides the binary).
 */
export function buildRecommendedRoomImage(
  onLog?: (line: string) => void,
  options: RoomBuildOptions = {},
): Promise<RoomBuildResult> {
  const containerfile = writeRecommendedRoomDockerfile();
  const dir = roomImageBuildDir();
  const args = ["build", "--progress", "plain", "--pull", "-t", RECOMMENDED_ROOM_IMAGE, "-f", containerfile];
  if (options.noCache) args.push("--no-cache");
  args.push(dir);
  return new Promise((resolvePromise) => {
    const child = spawn(CONTAINER_BIN, args);
    let log = "";
    let carry = "";
    const consume = (chunk: Buffer) => {
      carry += chunk.toString();
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? "";
      for (const line of lines) { log += line + "\n"; onLog?.(line); }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 20 * 60 * 1000);
    child.on("error", (err) => {
      clearTimeout(timeout);
      resolvePromise({ ok: false, image: RECOMMENDED_ROOM_IMAGE, containerfile, log: `${log}\n${err.message}`.trim(), failedTool: "Apple container", hint: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (carry) { log += carry; onLog?.(carry); }
      log = log.trim();
      if (code !== 0) {
        const failure = classifyBuildFailure(log);
        resolvePromise({
          ok: false,
          image: RECOMMENDED_ROOM_IMAGE,
          containerfile,
          log,
          failedTool: failure?.failedTool ?? "Sandbox image build",
          hint: failure?.hint ?? `Build exited with code ${code}.`,
        });
        return;
      }
      if (options.verify === false) {
        resolvePromise({ ok: true, image: RECOMMENDED_ROOM_IMAGE, containerfile, log });
        return;
      }
      onLog?.("bumper: verifying PATH CLIs under empty auth overlays…");
      const verify = verifyRecommendedRoomAuthOverlay(RECOMMENDED_ROOM_IMAGE);
      if (!verify.ok) {
        resolvePromise({
          ok: false,
          image: RECOMMENDED_ROOM_IMAGE,
          containerfile,
          log: `${log}\n${verify.detail}`.trim(),
          failedTool: "Auth overlay verify",
          hint: `${verify.detail} Re-run: bumper room-image build --force`,
          verifyOk: false,
          verifyDetail: verify.detail,
        });
        return;
      }
      resolvePromise({
        ok: true,
        image: RECOMMENDED_ROOM_IMAGE,
        containerfile,
        log,
        verifyOk: true,
        verifyDetail: verify.detail,
      });
    });
  });
}
