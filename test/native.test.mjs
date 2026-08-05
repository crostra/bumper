import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBash, classifyNative, decideNative } from "../dist/native.js";

const ro = (over = {}) => ({ backends: [], mode: "read-only", policies: {}, native: { allow: [], deny: [] }, ...over });
const rw = (over = {}) => ({ backends: [], mode: "read-write", policies: {}, native: { allow: [], deny: [] }, ...over });

test("client write tools classify as write", () => {
  for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
    assert.equal(classifyNative(t, {}), "write", t);
  }
});

test("client read tools classify as read", () => {
  for (const t of ["Read", "Grep", "Glob", "LS"]) {
    assert.equal(classifyNative(t, {}), "read", t);
  }
});

test("unknown client tool defaults to write", () => {
  assert.equal(classifyNative("SomeNewTool", {}), "write");
});

test("bash classification", () => {
  assert.equal(classifyBash("git status"), "read");
  assert.equal(classifyBash("git log --oneline"), "read");
  assert.equal(classifyBash("ls -la | grep foo"), "read");
  assert.equal(classifyBash("cat a && head b"), "read");
  assert.equal(classifyBash("git push origin main"), "write");
  assert.equal(classifyBash("rm -rf build"), "write");
  assert.equal(classifyBash("echo hi > out.txt"), "write");
  assert.equal(classifyBash("cat a && rm b"), "write", "any write segment poisons the chain");
  assert.equal(classifyBash("npm install"), "write");
  assert.equal(classifyBash("somethingweird --flag"), "write", "unknown → safe default");
});

test("read-only denies writes, defers reads", () => {
  assert.equal(decideNative(ro(), "Write", {}).decision, "deny");
  assert.equal(decideNative(ro(), "Bash", { command: "git push" }).decision, "deny");
  assert.equal(decideNative(ro(), "Read", {}).decision, "defer");
  assert.equal(decideNative(ro(), "Bash", { command: "git status" }).decision, "defer");
});

test("read-write defers everything (client decides)", () => {
  assert.equal(decideNative(rw(), "Write", {}).decision, "defer");
  assert.equal(decideNative(rw(), "Bash", { command: "git push" }).decision, "defer");
});

test("native deny list blocks even in read-write", () => {
  const c = rw({ native: { allow: [], deny: ["Bash:git push"] } });
  assert.equal(decideNative(c, "Bash", { command: "git push origin main" }).decision, "deny");
  assert.equal(decideNative(c, "Bash", { command: "git status" }).decision, "defer");
});

test("native allow list permits a write in read-only", () => {
  const c = ro({ native: { allow: ["Bash:npm test"], deny: [] } });
  assert.equal(decideNative(c, "Bash", { command: "npm test" }).decision, "defer");
  assert.equal(decideNative(c, "Bash", { command: "npm publish" }).decision, "deny");
});

test("structured command policy blocks Git push in a read-write project", () => {
  const context = rw({ commands: { gitRemoteWrite: "block" } });
  assert.equal(decideNative(context, "Bash", { command: "git push origin main" }).decision, "deny");
  assert.equal(decideNative(context, "Bash", { command: "git status" }).decision, "defer");
});

test("unknown command policy fails closed when configured", () => {
  const context = rw({ commands: { unknown: "block" } });
  assert.equal(decideNative(context, "Bash", { command: "mystery-tool --do-it" }).decision, "deny");
});
