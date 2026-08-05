import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema } from "../dist/types.js";
import { effectiveContext } from "../dist/effective.js";

function config(project = {}) {
  return ConfigSchema.parse({
    globalPolicy: {
      mode: "read-only",
      native: { allow: [], deny: ["Bash:git push"] },
      commands: { gitRemoteWrite: "block" },
      readPaths: ["/global-read"], denyReadPaths: ["/always-hidden"],
    },
    contexts: {
      Project: { backends: [], inheritMode: true, native: { allow: [], deny: [] }, ...project },
    },
  });
}

test("effective policy inherits global mode and locked filesystem rules", () => {
  const effective = effectiveContext(config({ readPaths: ["/project-read"] }), "Project");
  assert.equal(effective.mode, "read-only");
  assert.deepEqual(effective.readPaths, ["/global-read", "/project-read"]);
  assert.deepEqual(effective.denyReadPaths, ["/always-hidden"]);
  assert.equal(effective.commands.gitRemoteWrite, "block");
});

test("a project can explicitly override a global command rule", () => {
  const effective = effectiveContext(config({
    mode: "read-write", inheritMode: false,
    commands: { gitRemoteWrite: "allow" },
    native: { allow: ["Bash:git push"], deny: [] },
  }), "Project");
  assert.equal(effective.mode, "read-write");
  assert.equal(effective.commands.gitRemoteWrite, "allow");
  assert.ok(effective.native.allow.includes("Bash:git push"));
  assert.ok(!effective.native.deny.includes("Bash:git push"));
});
