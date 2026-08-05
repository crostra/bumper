import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aiProofProbes,
  evaluateAiProof,
  ensureProofCanary,
  proofCanaryHostPath,
  PROOF_CANARY_MARKER,
  runAiProof,
} from "../dist/room/aiproof.js";
import { readFileSync } from "node:fs";

function ctx(overrides = {}) {
  return {
    mode: "read-write", repos: [], readPaths: [], writePaths: [], denyReadPaths: [], denyWritePaths: [],
    commands: {}, room: { enabled: true, image: "x", egress: "blocked", doors: [] },
    ...overrides,
  };
}

test("probes expect workspace writes to succeed in read-write mode", () => {
  const probes = aiProofProbes(ctx({ mode: "read-write" }));
  assert.equal(probes.find((p) => p.id === "workspace-write").expect, "allowed");
});

test("probes expect workspace writes to fail in read-only mode", () => {
  const probes = aiProofProbes(ctx({ mode: "read-only" }));
  assert.equal(probes.find((p) => p.id === "workspace-write").expect, "blocked");
});

test("host filesystem escape targets the real host canary path", () => {
  const canary = proofCanaryHostPath();
  const probe = aiProofProbes(ctx()).find((p) => p.id === "host-fs-escape");
  assert.equal(probe.expect, "blocked");
  assert.equal(probe.attempt.target, canary);
  assert.equal(probe.attempt.targetHost, canary);
  assert.ok(probe.command.join(" ").includes(canary), "command must name the absolute canary path");
  assert.match(probe.description, /\.bumper\/proof\/canary/);
  // Planting the canary is what makes "file not found" a real boundary result.
  const planted = ensureProofCanary();
  assert.equal(planted, canary);
  assert.equal(readFileSync(canary, "utf8"), PROOF_CANARY_MARKER);
});

test("egress probe expectation follows the egress policy", () => {
  assert.equal(aiProofProbes(ctx({ room: { egress: "blocked", doors: [] } })).find((p) => p.id === "network-egress").expect, "blocked");
  assert.equal(aiProofProbes(ctx({ room: { egress: "open", doors: [] } })).find((p) => p.id === "network-egress").expect, "allowed");
});

test("a read-only door adds an immutability probe", () => {
  const doors = [
    { hostPath: "/w", roomPath: "/workspace", access: "read-write" },
    { hostPath: "/docs", roomPath: "/manuals", access: "read-only" },
  ];
  const probes = aiProofProbes(ctx(), doors);
  const probe = probes.find((p) => p.id === "readonly-door-write");
  assert.ok(probe);
  assert.equal(probe.expect, "blocked");
  assert.ok(probe.command.join(" ").includes("/manuals"));
});

test("evaluate scores observed against expected and keeps the raw evidence", () => {
  const probe = { id: "x", title: "t", description: "d", command: ["/bin/sh", "-c", "true"], expect: "blocked", attempt: { targetKind: "network", target: "1.1.1.1", enforcer: "microvm" } };
  assert.equal(evaluateAiProof(probe, "OUTCOME=blocked\n").pass, true);
  assert.equal(evaluateAiProof(probe, "OUTCOME=allowed\n").pass, false);
  assert.equal(evaluateAiProof(probe, "garbage").observed, "unknown");
  assert.equal(evaluateAiProof(probe, "garbage").pass, false);
  // The command and its raw output travel with the result: a check the UI
  // cannot show the workings of is indistinguishable from a fake one.
  const run = evaluateAiProof(probe, { stdout: "OUTCOME=blocked\n", stderr: "wget: bad address", exitCode: 0, durationMs: 42 });
  assert.deepEqual(run.command, probe.command);
  assert.equal(run.description, "d");
  assert.equal(run.stdout, "OUTCOME=blocked");
  assert.equal(run.stderr, "wget: bad address");
  assert.equal(run.durationMs, 42);
  assert.deepEqual(run.attempt, probe.attempt);
});

test("git is not a boundary check at all", () => {
  // Removed on purpose: a token handed to the room can be copied and reused, so
  // "unlisted repos are refused" was only ever true of the first request.
  const ids = aiProofProbes(ctx({ repos: ["github.com/acme/app"] })).map((p) => p.id);
  assert.ok(!ids.some((id) => id.startsWith("git-")));
});

test("the room is probed for host git identity it must not have", () => {
  const probe = aiProofProbes(ctx()).find((p) => p.id === "host-credentials-absent");
  assert.equal(probe.expect, "blocked");
  const script = probe.command.join(" ");
  for (const path of ["/root/.ssh", "/root/.netrc", "/root/.git-credentials", "/bumper"]) {
    assert.ok(script.includes(path), `probe must look for ${path}`);
  }
});

test("every probe names a target that literally appears in its command", () => {
  // The UI draws its trace from `attempt`; anything not present in the executed
  // command would be an illustration, which is what this product must not ship.
  const doors = [
    { hostPath: "/w", roomPath: "/workspace", access: "read-write" },
    { hostPath: "/docs", roomPath: "/manuals", access: "read-only" },
  ];
  for (const probe of aiProofProbes(ctx(), doors)) {
    const script = probe.command.join(" ");
    const target = probe.attempt.target.split(" · ")[0];
    assert.ok(script.includes(target), `${probe.id}: ${target} is not in its command`);
    assert.ok(["microvm", "readonly-mount", "absent"].includes(probe.attempt.enforcer));
  }
});

test("runAiProof drives a backend and scores every probe", async () => {
  // Fake backend: workspace write succeeds, host escape fails, network fails.
  const backend = {
    id: "fake", label: "fake",
    async check() { return { usable: true, detail: "" }; },
    async run(_spec, command) {
      const script = command.join(" ");
      let succeeds = false;
      if (script.includes("/workspace/.bumper-proof")) succeeds = true; // rw workspace
      // host escape + network fail
      return { exitCode: 0, stdout: `OUTCOME=${succeeds ? "allowed" : "blocked"}\n`, stderr: "" };
    },
  };
  const spec = { image: "x", doors: [{ hostPath: "/w", roomPath: "/workspace", access: "read-write" }], egress: { mode: "blocked" } };
  const results = await runAiProof(backend, spec, ctx({ mode: "read-write" }));
  assert.ok(results.every((r) => r.pass), JSON.stringify(results));
});
