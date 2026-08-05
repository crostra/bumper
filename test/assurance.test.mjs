import { test } from "node:test";
import assert from "node:assert/strict";
import { roomAssurance, ASSURANCE_LEGEND } from "../dist/room/assurance.js";

function ctx(overrides = {}) {
  return {
    mode: "read-write",
    repos: [],
    readPaths: [],
    writePaths: [],
    denyReadPaths: [],
    denyWritePaths: [],
    commands: {},
    room: { enabled: true, image: "bumper/ai-room:latest", egress: "blocked", doors: [] },
    ...overrides,
  };
}

function byId(items, id) { return items.find((item) => item.id === id); }

test("blocked egress and workspace door are VM-enforced", () => {
  const items = roomAssurance(ctx());
  assert.equal(byId(items, "sealed-room").source, "vm");
  assert.equal(byId(items, "workspace-door").source, "vm");
  assert.equal(byId(items, "egress").source, "vm");
  assert.match(byId(items, "egress").label, /Off|no network/i);
  assert.match(byId(items, "egress").detail, /network none|loopback/i);
});

test("open egress is surfaced as unrestricted not-enforced", () => {
  const items = roomAssurance(ctx({ room: { enabled: true, image: "x", egress: "open", doors: [] } }));
  const egress = byId(items, "egress");
  assert.equal(egress.source, "not-enforced");
  assert.match(egress.label, /Open.*unrestricted/i);
  assert.match(egress.detail, /not a protected allowlist/i);
});

/*
 * Allowlist was "not-enforced" for as long as it was only a proxy a room could
 * decline to use. Sandboxs now run it on a host-only container network where the
 * host is the single reachable address, so the classification is "vm" — see
 * test/egress-network-vm.test.mjs for the measurement that earns it.
 */
test("allowlist egress is VM-enforced by the host-only network", () => {
  const items = roomAssurance(ctx({
    room: { enabled: true, image: "x", egress: "allowlist", egressTemplates: ["anthropic"], egressHosts: [], doors: [] },
  }));
  const egress = byId(items, "egress");
  assert.equal(egress.source, "vm");
  assert.match(egress.label, /Allowlist/i);
  assert.match(egress.detail, /host-only network/i);
  assert.match(egress.detail, /direct-IP|another machine|DNS/i);
});

test("any network still admits it can reach this Mac", () => {
  for (const egress of ["allowlist", "open"]) {
    const item = byId(roomAssurance(ctx({
      room: { enabled: true, image: "x", egress, egressTemplates: [], egressHosts: [], doors: [] },
    })), "host-services");
    assert.equal(item.source, "not-enforced", egress);
    assert.match(item.detail, /127\.0\.0\.1/);
  }
  const off = roomAssurance(ctx({ room: { enabled: true, image: "x", egress: "blocked", doors: [] } }))
    .find((item) => item.id === "host-services");
  assert.equal(off, undefined, "Network Off reaches nothing, so it claims nothing");
});

test("Git access keeps host identity absent and names provider-enforced token scope", () => {
  const none = byId(roomAssurance(ctx({ gitAccess: "none" })), "git-credentials");
  assert.match(none.label, /no host git identity/i);
  assert.match(none.detail, /does not receive a Git credential/i);
  const git = byId(roomAssurance(ctx({ gitAccess: "read", gitRepository: "acme/app" })), "git-credentials");
  assert.equal(git.source, "provider");
  assert.match(git.label, /no host git identity/i);
  assert.match(git.detail, /~\/\.ssh/);
  assert.match(git.label + git.detail, /GitHub.*short-lived.*read-only/i);
  assert.match(git.detail, /does not inspect git command contents/i);
});

test("subtree deny-lists are honestly marked not-enforced while whole workspace is mounted", () => {
  const items = roomAssurance(ctx({ denyReadPaths: ["/w/secret"] }));
  const hidden = byId(items, "hidden-subpaths");
  assert.ok(hidden);
  assert.equal(hidden.source, "not-enforced");
});

test("shell command rules are marked not-enforced in Sandbox", () => {
  const items = roomAssurance(ctx({ commands: { unknown: "block", shellWrite: "block" } }));
  const cmd = byId(items, "command-rules");
  assert.ok(cmd);
  assert.equal(cmd.source, "not-enforced");
});

test("extra shared folders appear as VM-enforced doors", () => {
  const items = roomAssurance(ctx({ readPaths: ["/docs"], writePaths: ["/out"] }));
  const shared = byId(items, "shared-folders");
  assert.equal(shared.source, "vm");
  assert.match(shared.label, /2 extra/);
});

test("selected sharing makes hidden subtrees honest (no not-enforced warning)", () => {
  const items = roomAssurance(ctx({
    denyReadPaths: ["/w/secret"],
    room: { enabled: true, image: "x", egress: "blocked", workspaceShare: "selected", shareSubpaths: ["src", "docs"], doors: [] },
  }));
  // The dishonest "hidden subpaths not enforced" warning must be gone.
  assert.equal(byId(items, "hidden-subpaths"), undefined);
  const door = byId(items, "workspace-door");
  assert.equal(door.source, "vm");
  assert.match(door.label, /2 workspace sub-folder/);
});

test("legend documents every enforcement source", () => {
  assert.ok(ASSURANCE_LEGEND.vm);
  assert.ok(ASSURANCE_LEGEND.broker);
  assert.ok(ASSURANCE_LEGEND.provider);
  assert.ok(ASSURANCE_LEGEND["not-enforced"]);
});
