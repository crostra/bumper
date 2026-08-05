import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfile, gitIgnoredPaths } from "../dist/sandbox.js";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

test("profile denies all writes then re-allows the context's folder", () => {
  const p = buildProfile({ backends: [], mode: "read-only", policies: {}, native: { allow: [], deny: [] }, writePaths: ["/Users/me/work/acme"], repos: [] });
  assert.match(p, /\(deny file-write\*\)/, "denies writes by default");
  assert.match(p, /\(allow file-write\* \(subpath "\/Users\/me\/work\/acme"\)\)/, "re-allows the context folder");
});

test("profile allows reads (allow default) and does not allow arbitrary writes", () => {
  const p = buildProfile({ backends: [], mode: "read-only", policies: {}, native: { allow: [], deny: [] }, writePaths: [], repos: [] });
  assert.match(p, /\(allow default\)/);
  // a random unrelated path must not appear as a write-allow
  assert.doesNotMatch(p, /subpath "\/Users\/me\/work\/globex"/);
});

test("profile denies home reads and re-allows explicit read paths", () => {
  const p = buildProfile({ backends: [], mode: "read-only", policies: {}, native: { allow: [], deny: [] }, writePaths: [], readPaths: ["/Users/me/reference"], repos: [], allowedHosts: [] });
  assert.match(p, /\(deny file-read\* \(subpath "/);
  assert.match(p, /\(allow file-read\* \(subpath "\/Users\/me\/reference"\)\)/);
});

test("profile allows vendor keychain state without exposing Bumper state", () => {
  const p = buildProfile({ backends: [], mode: "read-write", policies: {}, native: { allow: [], deny: [] }, writePaths: [], readPaths: [], repos: [] });
  assert.match(p, /Keychains/);
  assert.match(p, /com\\\.apple\\\.security/);
  assert.doesNotMatch(p, /file-read\* file-write\*.*\\.bumper/);
  assert.doesNotMatch(p, /file-write\* \(subpath ".*\/\.bumper/);
});

test("read-only workspace is not re-allowed for writes", () => {
  const p = buildProfile({ backends: [], mode: "read-only", policies: {}, native: { allow: [], deny: [] }, writePaths: [], readPaths: [], repos: [] }, { workspace: "/Users/me/work/acme" });
  assert.match(p, /allow file-read\* \(subpath "\/Users\/me\/work\/acme"\)/);
  assert.doesNotMatch(p, /allow file-write\* \(subpath "\/Users\/me\/work\/acme"\)/);
});

test("nested deny exceptions win in the actual macOS sandbox", { skip: process.platform !== "darwin" }, () => {
  const workspace = mkdtempSync(join(homedir(), ".bumper-seatbelt-test-"));
  const secret = join(workspace, "secret");
  mkdirSync(secret);
  writeFileSync(join(secret, "value.txt"), "private\n");
  const context = { backends: [], mode: "read-write", policies: {}, native: { allow: [], deny: [] }, commands: {}, writePaths: [], readPaths: [], denyReadPaths: [secret], denyWritePaths: [secret], gitIgnored: "visible", repos: [], allowedHosts: [] };
  const profile = buildProfile(context, { workspace });
  const read = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/cat", join(secret, "value.txt")]);
  const writePath = join(secret, "created.txt");
  const write = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/touch", writePath]);
  assert.notEqual(read.status, 0);
  assert.notEqual(write.status, 0);
  assert.equal(existsSync(writePath), false);
  rmSync(workspace, { recursive: true, force: true });
});

test("current gitignored directories are resolved inside the workspace", () => {
  const workspace = mkdtempSync(join(homedir(), ".bumper-gitignore-test-"));
  execFileSync("/usr/bin/git", ["-C", workspace, "init", "-q"]);
  writeFileSync(join(workspace, ".gitignore"), "secrets/\n");
  mkdirSync(join(workspace, "secrets"));
  writeFileSync(join(workspace, "secrets", "token.txt"), "secret\n");
  assert.ok(gitIgnoredPaths(workspace).some((path) => path === join(workspace, "secrets")));
  rmSync(workspace, { recursive: true, force: true });
});
