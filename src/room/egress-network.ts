/**
 * The forced gateway that makes an egress allowlist a real boundary.
 *
 * A filtering proxy only filters clients that choose to honor HTTP(S)_PROXY.
 * On the default container network a room can open a raw socket straight to an
 * IP address and the allowlist never sees it — which is why allowlist mode was
 * classified "not enforced" and kept out of the product UI.
 *
 * Apple `container` can create a host-only network (`network create --internal`,
 * vmnet mode "hostOnly"). A room attached to it can reach the host and nothing
 * else: no other LAN machine, no Internet address, no external DNS. The only
 * way out is a listener on the host — and the only listener Bumper points the
 * room at is the filtering proxy. The allowlist becomes structural.
 *
 * Measured on this host (container 1.1.0, macOS 26.4.1) with the room attached
 * to a `--internal` network:
 *   - direct IP 1.1.1.1:443 / 140.82.121.4:443  → blocked
 *   - LAN router 10.16.0.1:80/443               → blocked
 *   - external DNS 8.8.8.8:53                   → blocked
 *   - host gateway (the proxy)                  → reachable
 * See docs/SECURITY_MODEL.md.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EgressProxy, type EgressEvent } from "./egress-proxy.js";
import type { Egress } from "./backend.js";

const exec = promisify(execFile);

/** The signed pkg installs the CLI here (installRoot=/usr/local). */
const CONTAINER_BIN = "/usr/local/bin/container";

/**
 * One shared network for every allowlist room. Rooms on it are isolated from
 * each other by the microVM boundary, not by the subnet, and each room gets its
 * own proxy on its own port, so a shared subnet grants no cross-room reach that
 * the host does not already mediate.
 */
export const EGRESS_NETWORK_NAME = "bumper-egress";

export interface EgressNetwork {
  name: string;
  /** Host address the room must use to reach this room's filtering proxy. */
  gateway: string;
}

interface Runner {
  (args: string[]): Promise<string>;
}

const runContainer: Runner = async (args) => {
  const { stdout } = await exec(CONTAINER_BIN, args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

/** Pull the IPv4 gateway out of `container network inspect` output. */
export function gatewayFromInspect(stdout: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error("Could not read the Bumper egress network."); }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    const status = (row as { status?: { ipv4Gateway?: unknown } })?.status;
    const gateway = String(status?.ipv4Gateway ?? "").trim();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(gateway)) return gateway;
  }
  throw new Error("The Bumper egress network has no IPv4 gateway yet.");
}

/**
 * Ensure the host-only egress network exists and return its gateway.
 *
 * Creation is idempotent: a concurrent launch that wins the race leaves the
 * network in place and inspect still answers. Never delete it here — another
 * room may be attached.
 */
export async function ensureEgressNetwork(
  run: Runner = runContainer,
  name = EGRESS_NETWORK_NAME,
): Promise<EgressNetwork> {
  try {
    return { name, gateway: gatewayFromInspect(await run(["network", "inspect", name])) };
  } catch { /* not created yet, or not ready */ }
  try {
    await run(["network", "create", "--internal", name]);
  } catch (error) {
    // A parallel launch may have created it between our inspect and create.
    const detail = error instanceof Error ? error.message : String(error);
    if (!/exist/i.test(detail)) {
      throw new Error(
        "Could not create the Bumper egress network. Allowlist rooms need a host-only "
        + "container network; run `container system start` and try again.",
      );
    }
  }
  return { name, gateway: gatewayFromInspect(await run(["network", "inspect", name])) };
}

export interface StartedEgress {
  proxy: EgressProxy;
  /** Egress for the RoomSpec, now carrying the host-only network name. */
  egress: Egress;
  /** HTTP(S)_PROXY variables pointing at this room's proxy on the gateway. */
  env: Record<string, string>;
}

/**
 * Prepare allowlist egress for one room: host-only network, filtering proxy,
 * and the proxy environment.
 *
 * Both launch paths must go through this. The GUI `SessionManager` and the CLI
 * `bumper <cli>` attach previously hand-assembled the proxy separately, and the
 * same drift already broke the Git broker once (see withGitBroker). The forced
 * gateway only holds if every path applies it, so there is exactly one place
 * that knows how.
 *
 * The proxy binds all interfaces because the guest dials the host by its
 * gateway address, but the room's only route to it is the host-only network.
 */
export async function startAllowlistEgress(
  hosts: string[],
  onEvent: (event: EgressEvent) => void,
  options: { project?: string } = {},
): Promise<StartedEgress> {
  const network = await ensureEgressNetwork();
  const proxy = new EgressProxy(hosts, onEvent, { project: options.project });
  const port = await proxy.listen();
  const proxyUrl = `http://${network.gateway}:${port}`;
  return {
    proxy,
    egress: { mode: "allowlist", hosts, network: network.name },
    env: {
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1",
    },
  };
}
