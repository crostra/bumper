import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { nextCommandsForAction } from "../dist/cli-room.js";
import { roomPreflightFailureDetail } from "../dist/room/preflight.js";
import { RECOMMENDED_ROOM_RECIPE } from "../dist/room/setup.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");

test("help lists room-image build/verify for materialize_path_bin rebuild", () => {
  const help = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /room-image build/);
  assert.match(help.stdout, /room-image verify/);
  assert.match(help.stdout, /materialize_path_bin|auth mounts/i);
});

test("build-image next commands point at bumper room-image build --force", () => {
  const cmds = nextCommandsForAction("build-image", "grok").join("\n");
  assert.match(cmds, /bumper room-image build --force/);
  assert.match(cmds, new RegExp(RECOMMENDED_ROOM_RECIPE));
});

test("preflight failure on recommended image hints room-image build --force", () => {
  const detail = roomPreflightFailureDetail("Grok", ["grok"], "bumper/ai-room:latest", {
    exitCode: 1,
    stdout: "",
    stderr: "",
  });
  assert.match(detail, /materialize_path_bin/);
  assert.match(detail, /bumper room-image build --force/);
});

test("CLI room-image without subcommand fails with usage", () => {
  const result = spawnSync(process.execPath, [cli, "room-image"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /room-image build/);
});
