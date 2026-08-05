/**
 * Sandbox-side proof for the Git credential broker.
 *
 * The unit tests drive the broker directly. This one runs a real Apple container
 * Sandbox, lets **git itself** call the helper through the mounted door, and checks
 * what actually crosses the boundary. The token here is synthetic — no GitHub call
 * is made — so the proof is about the wiring, not about a live App.
 *
 * Run with: BUMPER_VM_TESTS=1 npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppleContainerBackend } from "../dist/room/apple-container.js";
import { RECOMMENDED_ROOM_IMAGE } from "../dist/room/setup.js";
import { projectGitBroker, withGitBroker, ROOM_GIT_MOUNT } from "../dist/git-broker.js";

const CONTAINER = "/usr/local/bin/container";
const GATE = process.env.BUMPER_VM_TESTS === "1";
const IMAGE = process.env.BUMPER_VM_IMAGE || RECOMMENDED_ROOM_IMAGE;
const TOKEN = "SYNTHETIC_ROOM_TOKEN";

async function containerReady() {
  if (!GATE) return { ok: false, reason: "BUMPER_VM_TESTS!=1" };
  if (process.platform !== "darwin") return { ok: false, reason: "not darwin" };
  if (!existsSync(CONTAINER)) return { ok: false, reason: "container CLI missing" };
  const backend = new AppleContainerBackend();
  const check = await backend.check();
  if (!check.usable) return { ok: false, reason: check.detail };
  return { ok: true, backend };
}

const INSTALLED = [{
  connectionId: "gh-acme",
  id: 1,
  repositories: [
    { id: 9, fullName: "acme/alpha" },
    { id: 10, fullName: "acme/infra" },
  ],
}];

/** A Project binding `acme/alpha` at `access`, plus any extra bindings. */
function brokerFor(dir, access, issued = [], extra = []) {
  const gitRepositories = [
    ...(access === "none" ? [] : [{
      fullName: "acme/alpha", connectionId: "gh-acme", installationId: 1, repositoryId: 9, capability: access,
    }]),
    ...extra,
  ];
  return projectGitBroker({
    dir,
    projectName: "P",
    context: { gitRepositories },
    installations: INSTALLED,
    github: {
      issue: async (connectionId, installationId, repos, capability) => {
        issued.push({ connectionId, installationId, repos: repos.map((r) => r.fullName), capability });
        return {
          // A distinct token per rung, so the Sandbox proof can tell them apart.
          token: `${TOKEN}_${repos[0].fullName.replace("/", "_")}_${capability}`,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          scope: capability === "read" ? "read" : "write",
          capability,
          connectionId,
        };
      },
      revoke: async () => {},
    },
    onEvent: () => {},
  });
}

/** Ask git — not our own code — to resolve a credential inside the Sandbox. */
async function askGit(backend, broker, repoPath) {
  const spec = withGitBroker({
    image: IMAGE, doors: [], egress: { mode: "blocked" },
    workdir: "/root", dropCapabilities: true, env: {},
  }, broker.setup().door);
  broker.start(60);
  try {
    const result = await backend.run(spec, ["/bin/sh", "-lc",
      `printf 'protocol=https\\nhost=github.com\\npath=${repoPath}\\n\\n' | git credential fill 2>/dev/null`]);
    return result.stdout || "";
  } finally {
    await broker.stop();
  }
}

test("VM: git in the Sandbox receives a token only for the Project's repository", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) { t.skip(`skipped: ${ready.reason}`); return; }
  const root = mkdtempSync(join(tmpdir(), "bumper-gitvm-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  try {
    // POSITIVE CONTROL — without this the refusals below prove nothing.
    const issued = [];
    const allowed = await askGit(ready.backend, brokerFor(join(root, "ok"), "read", issued), "acme/alpha");
    assert.match(allowed, new RegExp(TOKEN), "git must receive the token for the bound repository");
    assert.match(allowed, /username=x-access-token/, "credential protocol shape");
    assert.deepEqual(issued.map((i) => i.capability), ["read"], "the rung comes from Project config");
    assert.deepEqual(issued.map((i) => i.repos), [["acme/alpha"]]);

    // A different repository on the same host must not be served.
    const other = await askGit(ready.backend, brokerFor(join(root, "other"), "read"), "acme/other");
    assert.doesNotMatch(other, new RegExp(TOKEN), "unbound repository must not receive a token");

    // A Project binding nothing answers nothing at all.
    const none = await askGit(ready.backend, brokerFor(join(root, "none"), "none"), "acme/alpha");
    assert.doesNotMatch(none, new RegExp(TOKEN), "an unbound Project must not receive a token");
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("VM: the broker door carries no credential of its own", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) { t.skip(`skipped: ${ready.reason}`); return; }
  const root = mkdtempSync(join(tmpdir(), "bumper-gitvm2-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  try {
    const broker = brokerFor(join(root, "d"), "read");
    const spec = withGitBroker({
      image: IMAGE, doors: [], egress: { mode: "blocked" },
      workdir: "/root", dropCapabilities: true, env: {},
    }, broker.setup().door);
    try {
      // Before any git request the door holds only the helper and its queue —
      // no host git identity, no key material, no pre-seeded token.
      const listing = await ready.backend.run(spec, ["/bin/sh", "-lc",
        `ls -a ${ROOM_GIT_MOUNT}; echo ---; grep -rl 'PRIVATE KEY\\|ghs_\\|x-access-token' ${ROOM_GIT_MOUNT} 2>/dev/null || echo NO_CREDENTIAL_IN_DOOR`]);
      assert.match(listing.stdout, /git-credential-bumper/);
      assert.match(listing.stdout, /NO_CREDENTIAL_IN_DOOR/, "door must not ship a credential");
      // Host git identity stays absent regardless of Git access.
      const host = await ready.backend.run(spec, ["/bin/sh", "-lc",
        "test -e /root/.ssh && echo SSH_PRESENT || echo NO_SSH; test -e /root/.netrc && echo NETRC || echo NO_NETRC"]);
      assert.match(host.stdout, /NO_SSH/);
      assert.match(host.stdout, /NO_NETRC/);
    } finally {
      await broker.stop();
    }
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The multi-repository claim, proven where it matters: git itself, inside the
 * Sandbox, asking for two repositories the same Project binds at different rungs.
 *
 * An installation token carries one permission set, so a shared token would
 * hand the read-only repository the stronger scope. Each repository must come
 * back with its own token.
 */
test("VM: each repository in one Project gets its own token at its own rung", async (t) => {
  const ready = await containerReady();
  if (!ready.ok) { t.skip(`skipped: ${ready.reason}`); return; }
  const root = mkdtempSync(join(tmpdir(), "bumper-gitvm3-"));
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_STATE = join(root, "state.json");
  try {
    const infra = {
      fullName: "acme/infra", connectionId: "gh-acme", installationId: 1, repositoryId: 10, capability: "workflow",
    };
    const issued = [];
    const readSide = await askGit(
      ready.backend, brokerFor(join(root, "multi-a"), "read", issued, [infra]), "acme/alpha",
    );
    const writeSide = await askGit(
      ready.backend, brokerFor(join(root, "multi-b"), "read", issued, [infra]), "acme/infra",
    );

    assert.match(readSide, /SYNTHETIC_ROOM_TOKEN_acme_alpha_read/);
    assert.match(writeSide, /SYNTHETIC_ROOM_TOKEN_acme_infra_workflow/);
    // The decisive assertion: the read-only repository never saw the stronger token.
    assert.doesNotMatch(readSide, /workflow/, "a read binding must not receive the sibling's wider token");
    assert.deepEqual(
      issued.map((i) => [i.repos[0], i.capability]),
      [["acme/alpha", "read"], ["acme/infra", "workflow"]],
    );

    // A repository bound by neither entry stays unreachable.
    const unbound = await askGit(
      ready.backend, brokerFor(join(root, "multi-c"), "read", [], [infra]), "acme/secret",
    );
    assert.doesNotMatch(unbound, new RegExp(TOKEN));
  } finally {
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(root, { recursive: true, force: true });
  }
});
