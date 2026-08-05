/**
 * Forced-gateway egress: the host-only network that turns the allowlist from a
 * convention into a boundary.
 *
 * Unit tests here are pure. The real-microVM proof (direct-IP blocked, LAN
 * blocked, DNS blocked, proxy reachable) lives in test/egress-network-vm.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EGRESS_NETWORK_NAME,
  ensureEgressNetwork,
  gatewayFromInspect,
} from "../dist/room/egress-network.js";
import { buildRunArgs } from "../dist/room/apple-container.js";
import { roomAssurance } from "../dist/room/assurance.js";
import { ContextSchema } from "../dist/types.js";

const INSPECT = JSON.stringify([{
  configuration: { mode: "hostOnly", name: EGRESS_NETWORK_NAME },
  status: { ipv4Gateway: "192.168.128.1", ipv4Subnet: "192.168.128.0/24" },
}]);

test("gateway is read from container network inspect", () => {
  assert.equal(gatewayFromInspect(INSPECT), "192.168.128.1");
  assert.equal(gatewayFromInspect(JSON.stringify({ status: { ipv4Gateway: "10.9.0.1" } })), "10.9.0.1");
});

test("a network without an IPv4 gateway fails instead of guessing", () => {
  assert.throws(() => gatewayFromInspect("not json"), /Could not read/);
  assert.throws(() => gatewayFromInspect("[]"), /no IPv4 gateway/);
  assert.throws(
    () => gatewayFromInspect(JSON.stringify([{ status: { ipv4Gateway: "nonsense" } }])),
    /no IPv4 gateway/,
  );
});

test("an existing network is reused, never recreated", async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return INSPECT; };
  const network = await ensureEgressNetwork(run, EGRESS_NETWORK_NAME);
  assert.equal(network.gateway, "192.168.128.1");
  assert.equal(network.name, EGRESS_NETWORK_NAME);
  assert.deepEqual(calls, [["network", "inspect", EGRESS_NETWORK_NAME]]);
});

test("a missing network is created host-only, then inspected", async () => {
  const calls = [];
  let created = false;
  const run = async (args) => {
    calls.push(args);
    if (args[1] === "inspect") {
      if (!created) throw new Error("network not found");
      return INSPECT;
    }
    created = true;
    return "";
  };
  const network = await ensureEgressNetwork(run, EGRESS_NETWORK_NAME);
  assert.equal(network.gateway, "192.168.128.1");
  assert.deepEqual(calls[1], ["network", "create", "--internal", EGRESS_NETWORK_NAME]);
});

test("a network created by a parallel launch is not an error", async () => {
  let created = false;
  const run = async (args) => {
    if (args[1] === "inspect") {
      if (!created) throw new Error("network not found");
      return INSPECT;
    }
    created = true;
    throw new Error("network already exists");
  };
  const network = await ensureEgressNetwork(run, EGRESS_NETWORK_NAME);
  assert.equal(network.gateway, "192.168.128.1");
});

test("allowlist rooms attach the host-only network", () => {
  const args = buildRunArgs({
    image: "alpine:3.20",
    doors: [],
    egress: { mode: "allowlist", hosts: ["api.anthropic.com"], network: EGRESS_NETWORK_NAME },
  }, ["true"]);
  const at = args.indexOf("--network");
  assert.ok(at > -1, "expected --network");
  assert.equal(args[at + 1], EGRESS_NETWORK_NAME);
});

test("an allowlist spec without a network refuses rather than silently opening up", () => {
  assert.throws(
    () => buildRunArgs({
      image: "alpine:3.20",
      doors: [],
      egress: { mode: "allowlist", hosts: ["api.anthropic.com"] },
    }, ["true"]),
    /host-only egress network/,
  );
});

test("Off still means no network device at all", () => {
  const args = buildRunArgs({ image: "alpine:3.20", doors: [], egress: { mode: "blocked" } }, ["true"]);
  assert.ok(args.includes("--network"));
  assert.equal(args[args.indexOf("--network") + 1], "none");
});

test("allowlist assurance is VM-enforced and names its residual", () => {
  const context = ContextSchema.parse({
    room: { egress: "allowlist", egressTemplates: ["anthropic"], image: "alpine:3.20" },
  });
  const items = roomAssurance(context);
  const egress = items.find((item) => item.id === "egress");
  assert.equal(egress.source, "vm");
  assert.match(egress.label, /Allowlist/);
  assert.match(egress.detail, /host-only network/);

  // The honest residual: a network of any kind still reaches this Mac.
  const host = items.find((item) => item.id === "host-services");
  assert.equal(host.source, "not-enforced");
  assert.match(host.detail, /127\.0\.0\.1/);
});

test("Network Off claims nothing about host services", () => {
  const context = ContextSchema.parse({ room: { egress: "blocked", image: "alpine:3.20" } });
  const items = roomAssurance(context);
  assert.equal(items.find((item) => item.id === "egress").source, "vm");
  assert.equal(items.find((item) => item.id === "host-services"), undefined);
});
