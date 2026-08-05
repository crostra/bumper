/**
 * Load the pure launch-gate module (assets/launch-gate.js) in Node.
 * Same decision tree as the renderer — CLI readiness must stay CLI-honest with GUI.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export type LaunchGateAction =
  | "install-container"
  | "choose-project"
  | "choose-workspace"
  | "choose-tool"
  | "build-image"
  | "wait-image"
  | "sign-in"
  | "open-project-settings"
  | "launch";

export type LaunchGateItemStatus = "ready" | "blocked" | "checking" | "optional";

export interface LaunchGateChecklistItem {
  id: string;
  label: string;
  status: LaunchGateItemStatus;
  detail: string;
  actionLabel?: string;
  action?: LaunchGateAction;
}

export interface LaunchGateResult {
  canLaunch: boolean;
  reason: string;
  nextAction: LaunchGateAction | null;
  nextActionLabel: string;
  checklist: LaunchGateChecklistItem[];
  protectionState: "setup" | "unavailable" | "ready";
}

export interface LaunchGateInput {
  macOS: boolean;
  roomAvailable: boolean;
  projectName: string | null | undefined;
  workspace: string;
  roomEnabled: boolean;
  agentId: string | null | undefined;
  agentMapped: boolean;
  imageStatus: string;
  imageDetail?: string;
  authRelevant?: boolean;
  authPersisted?: boolean;
}

export interface LaunchGateApi {
  computeLaunchGate: (input: LaunchGateInput) => LaunchGateResult;
  ACTION_LABELS: Record<string, string>;
  baseImageSetupReadiness: () => { status: string; label: string; detail: string };
  shouldAutoPreflightOnHome: (imageKind: string) => boolean;
  SAFE_BASE_IMAGE_DETAIL: string;
  SAFE_BASE_LAUNCH_REASON: string;
}

let cached: LaunchGateApi | undefined;

function assetsDir(): string {
  // dist/launch-gate-node.js → ../assets ; src path is not used at runtime
  const here = fileURLToPath(new URL(".", import.meta.url));
  return join(here, "..", "assets");
}

/** Load once; package.json is "type":"module" so CJS require cannot load the asset. */
export function loadLaunchGate(): LaunchGateApi {
  if (cached) return cached;
  const code = readFileSync(join(assetsDir(), "launch-gate.js"), "utf8");
  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    exports: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  const api = (sandbox.BumperLaunchGate || (sandbox.module as { exports: LaunchGateApi }).exports) as LaunchGateApi;
  if (typeof api?.computeLaunchGate !== "function") {
    throw new Error("assets/launch-gate.js did not export computeLaunchGate");
  }
  cached = api;
  return api;
}

export function computeLaunchGate(input: LaunchGateInput): LaunchGateResult {
  return loadLaunchGate().computeLaunchGate(input);
}
