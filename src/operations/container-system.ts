/**
 * Apple container's background services.
 *
 * `container` ships its API server as a per-user launchd service that has to be
 * running before any image or Sandbox call works. Making a first-time user
 * discover `container system start` from an XPC error is friction with no
 * upside: the service is user-scoped (`gui/<uid>`, no sudo), starting it is
 * exactly what the product needs it for, and stopping it again is one command.
 *
 * So Bumper starts it. It says that it did — an autostart the user cannot see
 * is worse than the error it replaced.
 */
import { spawnSync } from "node:child_process";

const CONTAINER_BIN = "/usr/local/bin/container";

export type ContainerSystemState = "running" | "stopped" | "unavailable";

export interface ContainerSystemStatus {
  state: ContainerSystemState;
  detail: string;
}

/**
 * Ask `container system status` rather than inferring from a failed call.
 * It exits 0 whether or not the service is up, and says which, so this is a
 * real answer instead of an error-string heuristic.
 */
export function containerSystemStatus(): ContainerSystemStatus {
  const probe = spawnSync(CONTAINER_BIN, ["system", "status"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (probe.error) {
    return { state: "unavailable", detail: "`container` CLI not found — install Apple container 1.1.0+." };
  }
  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  if (/not running|not registered/i.test(output)) {
    return { state: "stopped", detail: output || "apiserver is not running." };
  }
  if (probe.status !== 0) {
    return { state: "unavailable", detail: output || `container system status exited ${probe.status}.` };
  }
  return { state: "running", detail: output || "apiserver is running." };
}

export interface EnsureContainerSystemResult {
  /** True when the services are up by the time this returns. */
  running: boolean;
  /** True when this call is what started them (worth telling the user). */
  started: boolean;
  detail: string;
}

/**
 * Make sure the services are up, starting them when they are not.
 *
 * `allowStart: false` turns this into a pure probe — for `--no-start`, and for
 * anything that must not change host state as a side effect of reporting.
 */
export function ensureContainerSystem(
  options: { allowStart?: boolean } = {},
): EnsureContainerSystemResult {
  // Starting a launchd service is a change to the host, so there has to be a
  // way to say no once, globally: CI, a test run, or someone who manages the
  // service themselves. Without it, `npm test` silently starts the developer's
  // container services just by asserting on CLI output.
  const envBlocked = process.env.BUMPER_NO_CONTAINER_AUTOSTART === "1";
  const allowStart = options.allowStart !== false && !envBlocked;
  const before = containerSystemStatus();

  if (before.state === "running") {
    return { running: true, started: false, detail: before.detail };
  }
  if (before.state === "unavailable") {
    return { running: false, started: false, detail: before.detail };
  }
  if (!allowStart) {
    return { running: false, started: false, detail: before.detail };
  }

  const start = spawnSync(CONTAINER_BIN, ["system", "start"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (start.error) {
    return { running: false, started: false, detail: start.error.message };
  }

  const after = containerSystemStatus();
  if (after.state === "running") {
    return { running: true, started: true, detail: after.detail };
  }
  const output = `${start.stderr ?? ""}${start.stdout ?? ""}`.trim();
  return {
    running: false,
    started: false,
    detail: output || after.detail || "container system start did not bring the services up.",
  };
}
