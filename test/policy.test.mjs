import { test } from "node:test";
import assert from "node:assert/strict";
import { decideTool, exposedName, parseExposedName } from "../dist/policy.js";

const ctx = (over = {}) => ({
  backends: ["b"],
  mode: "read-only",
  policies: {},
  ...over,
});

test("read verbs are allowed in read-only", () => {
  for (const name of ["get_thing", "list_items", "search_files", "read_file", "fetch_data"]) {
    const d = decideTool(ctx(), "b", name, undefined);
    assert.equal(d.access, "read", `${name} should be read`);
    assert.equal(d.allowed, true, `${name} should be allowed`);
  }
});

test("write verbs are blocked in read-only", () => {
  for (const name of ["write_file", "delete_item", "create_repo", "update_row", "move_file", "run_sql"]) {
    const d = decideTool(ctx(), "b", name, undefined);
    assert.equal(d.access, "write", `${name} should be write`);
    assert.equal(d.allowed, false, `${name} should be blocked`);
  }
});

test("unknown tools are treated as write and blocked in read-only", () => {
  const d = decideTool(ctx(), "b", "frobnicate", undefined);
  assert.equal(d.access, "write");
  assert.equal(d.allowed, false);
  assert.match(d.reason, /unrecognized/);
});

test("readOnlyHint downgrades only the unknown case, never a write verb", () => {
  const unknown = decideTool(ctx(), "b", "frobnicate", true);
  assert.equal(unknown.allowed, true, "unknown + readOnlyHint → read");

  const write = decideTool(ctx(), "b", "delete_note", true);
  assert.equal(write.allowed, false, "write verb must stay write even with readOnlyHint");
});

test("read-write mode allows write tools", () => {
  const d = decideTool(ctx({ mode: "read-write" }), "b", "write_file", undefined);
  assert.equal(d.allowed, true);
});

test("deny list blocks even in read-write", () => {
  const c = ctx({ mode: "read-write", policies: { b: { allow: [], deny: ["run_sql"] } } });
  const d = decideTool(c, "b", "run_sql", undefined);
  assert.equal(d.allowed, false);
  assert.match(d.reason, /deny list/);
});

test("allow list permits a write tool in read-only", () => {
  const c = ctx({ policies: { b: { allow: ["run_report"], deny: [] } } });
  const d = decideTool(c, "b", "run_report", undefined);
  assert.equal(d.allowed, true);
  assert.match(d.reason, /allow list/);
});

test("per-backend mode override wins over context mode", () => {
  const c = ctx({ mode: "read-write", policies: { b: { mode: "read-only", allow: [], deny: [] } } });
  const d = decideTool(c, "b", "write_file", undefined);
  assert.equal(d.allowed, false);
});

test("exposedName / parseExposedName round-trip", () => {
  const e = exposedName("github", "search_issues");
  assert.equal(e, "github__search_issues");
  assert.deepEqual(parseExposedName(e), { backend: "github", toolName: "search_issues" });
});
