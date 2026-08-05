/**
 * Real-microVM proof that the allowlist is a boundary, not a convention.
 *
 * Run with: BUMPER_VM_TESTS=1 npm test -- test/egress-network-vm.test.mjs
 * Skips cleanly when container is unavailable or the gate env is unset.
 *
 * This is the evidence behind classifying allowlist egress as "vm" in
 * src/room/assurance.ts. Without a host-only network the same room reaches any
 * IP directly and the proxy never sees it — the control asserts both halves.
 *
 * The container must be run asynchronously: execFileSync would block Node's
 * event loop and the proxy could never accept the guest's connection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EgressProxy } from "../dist/room/egress-proxy.js";
import { ensureEgressNetwork } from "../dist/room/egress-network.js";

const exec = promisify(execFile);
const CONTAINER = "/usr/local/bin/container";
const GATE = process.env.BUMPER_VM_TESTS === "1";
const IMAGE = process.env.BUMPER_VM_IMAGE || "docker.io/library/alpine:3.20";
const NETWORK = "bumper-egress-test";

async function ready() {
  if (!GATE) return "BUMPER_VM_TESTS!=1";
  if (process.platform !== "darwin") return "not darwin";
  if (!existsSync(CONTAINER)) return "container CLI missing";
  try { await exec(CONTAINER, ["--version"]); } catch { return "container not usable"; }
  return undefined;
}

/** Run a shell script in a room attached to `network`, return its stdout. */
async function inRoom(network, env, script) {
  const args = ["run", "--rm", "--network", network];
  for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
  const { stdout } = await exec(CONTAINER, [...args, IMAGE, "sh", "-c", script], {
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

test("host-only network: the room reaches the proxy and nothing else", async (t) => {
  const skip = await ready();
  if (skip) return t.skip(skip);

  const network = await ensureEgressNetwork(
    async (args) => (await exec(CONTAINER, args)).stdout,
    NETWORK,
  );
  const seen = [];
  const proxy = new EgressProxy(["example.com"], (event) => seen.push(event), { project: "vm-proof" });
  const port = await proxy.listen();
  const proxyUrl = `http://${network.gateway}:${port}`;

  try {
    const out = await inRoom(network.name, {
      http_proxy: proxyUrl, https_proxy: proxyUrl,
      HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl,
    }, `
      wget -q -T10 -O /dev/null http://example.com/ && echo allowed=OK || echo allowed=FAIL
      wget -q -T10 -O /dev/null http://api.openai.com/ && echo blocked=REACHED || echo blocked=REFUSED
      nc -z -w5 140.82.121.4 443 && echo directip=BYPASSED || echo directip=BLOCKED
      nc -z -w5 1.1.1.1 443 && echo directip2=BYPASSED || echo directip2=BLOCKED
      nc -z -w5 8.8.8.8 53 && echo dns=REACHED || echo dns=BLOCKED
    `);

    // The allowlisted host works — the room is not simply cut off.
    assert.match(out, /allowed=OK/, "allowlisted host must succeed through the proxy");
    // The proxy refuses everything else it is asked for.
    assert.match(out, /blocked=REFUSED/);
    // And the bypass the proxy alone could never stop is gone.
    assert.match(out, /directip=BLOCKED/, "direct IP to GitHub must be unreachable");
    assert.match(out, /directip2=BLOCKED/, "direct IP to 1.1.1.1 must be unreachable");
    assert.match(out, /dns=BLOCKED/, "external DNS must be unreachable");

    assert.ok(
      seen.some((event) => event.allowed && event.host === "example.com"),
      "the proxy must be the path the allowed request took",
    );
    assert.ok(
      seen.some((event) => !event.allowed && event.host === "api.openai.com"),
      "the proxy must be what refused the disallowed host",
    );
  } finally {
    proxy.stop();
  }
});

test("without the host-only network the same room bypasses the allowlist", async (t) => {
  const skip = await ready();
  if (skip) return t.skip(skip);

  // Default network — this is what allowlist mode used to do, and why it was
  // classified "not enforced". Asserting the bypass keeps the reason on record.
  const { stdout } = await exec(CONTAINER, [
    "run", "--rm", IMAGE, "sh", "-c",
    "nc -z -w5 1.1.1.1 443 && echo directip=REACHED || echo directip=BLOCKED",
  ], { maxBuffer: 1024 * 1024 });
  assert.match(stdout, /directip=REACHED/);
});

test.after(async () => {
  if (await ready()) return;
  await exec(CONTAINER, ["network", "delete", NETWORK]).catch(() => {});
});
