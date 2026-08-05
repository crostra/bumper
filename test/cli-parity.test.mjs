/**
 * GUI/CLI parity, enforced rather than asserted in prose.
 *
 * The gap this closes was found by hand: I listed the commands that exist,
 * called the surface complete, and only a route-by-route re-read showed ~20
 * API routes with no terminal equivalent — including "Prove it", which the
 * README leads with, and repository binding, without which Git could be read
 * but never granted.
 *
 * A hand audit will drift again. This test reads the routes out of app.ts and
 * fails when one has neither a CLI command nor a written-down reason to lack
 * one, so the next gap shows up as a red test instead of a claim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP = readFileSync(join(process.cwd(), "src", "app.ts"), "utf8");
const CLI = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");

function apiRoutes() {
  const found = APP.match(/url\.pathname === "\/api\/[a-zA-Z0-9/_.-]*"/g) ?? [];
  return [...new Set(found.map((line) => line.replace(/.*"(.*)"/, "$1")))].sort();
}

/**
 * Every route maps to the CLI command that covers it, or to the reason it has
 * no terminal equivalent. "Not applicable" is a claim that must be defensible —
 * a GUI affordance (a Finder panel), not a capability.
 */
const COVERAGE = {
  "/api/access/workspace": "bumper access set",
  "/api/agents": "bumper status",
  "/api/ai-logins": "bumper login remove",
  "/api/allow": "bumper allow / bumper deny",
  "/api/auth-profiles": "bumper login remove",
  "/api/auth-profiles/reset": "bumper login remove",
  "/api/auth-profiles/verify": "bumper status (tool readiness)",
  "/api/backends": "bumper contexts (legacy host backends)",
  "/api/config/backups": "bumper backup list",
  "/api/config/restore": "bumper backup restore",
  "/api/contexts": "bumper project create|remove",
  "/api/development/open-preview": null, // opens a browser at a port the CLI already prints
  "/api/development/session-control": "bumper dev preview|docker",
  "/api/diagnostics/report": "bumper log --export",
  "/api/events": "bumper log",
  "/api/events/export": "bumper log --export",
  "/api/folders/apply": "bumper folders add|remove",
  "/api/folders/preview": "bumper folders list",
  "/api/git-connections": "bumper github list|disconnect",
  "/api/git/workspace": "bumper git status",
  "/api/github/connect": "bumper github connect",
  "/api/github/disconnect": "bumper github disconnect",
  "/api/github/installations/refresh": "bumper github refresh",
  "/api/github/repository-intent": "bumper git repo add",
  "/api/github/session-access": "bumper git off|read|write",
  "/api/github/write-window": "bumper git write",
  "/api/global-policy": "bumper allow / bumper deny (legacy host policy)",
  "/api/mcp-connections": "bumper mcp list|bind|unbind",
  "/api/mcp-connections/secret": null, // a secret must not transit argv or a shell history
  "/api/mcp-import/apply": "bumper mcp client-config --apply",
  "/api/mcp-import/preview": "bumper mcp client-config",
  "/api/mcp-import/probes": "bumper mcp list",
  "/api/mcp-integrations": "bumper mcp list",
  "/api/path-test": "bumper prove",
  "/api/permission-setups": "bumper setup save|remove",
  "/api/permission-setups/apply": "bumper setup apply",
  "/api/pick-folder": null, // a Finder panel; the CLI takes the path as an argument
  "/api/prefs": "bumper prefs",
  "/api/project/mcp-preview": "bumper mcp show",
  "/api/protection-test": "bumper prove",
  "/api/protection/clear": "bumper prove",
  "/api/protection/status": "bumper doctor",
  "/api/recovery/clear": "bumper backup restore",
  "/api/reveal-location": null, // reveals in Finder; the CLI prints the path
  "/api/room/agent-sessions": "bumper <cli>",
  "/api/room/ai-proof": "bumper prove",
  "/api/room/ai-proof/plan": "bumper prove",
  "/api/room/breakout": "bumper prove --sealed",
  "/api/room/preflight": "bumper doctor",
  "/api/room/sessions": "bumper <cli>",
  "/api/room/setup": "bumper room-image build",
  "/api/room/setup/log": "bumper room-image build (streams)",
  "/api/sessions": null, // a WebSocket attach to a GUI terminal; the CLI is the terminal
  "/api/state": "bumper status",
  "/api/terminal-window": null, // opens a GUI terminal window; the CLI is already in one
  "/api/uninstall/execute": "bumper uninstall --yes",
  "/api/uninstall/plan": "bumper uninstall",
  "/api/use": "bumper use",
};

test("every API route is either reachable from the CLI or explained", () => {
  const missing = apiRoutes().filter((route) => !(route in COVERAGE));
  assert.deepEqual(
    missing,
    [],
    `new API route(s) with no CLI decision recorded: ${missing.join(", ")}\n`
    + "Add a command, or record why a terminal cannot have one, in test/cli-parity.test.mjs.",
  );
});

test("the commands claimed as coverage actually exist", () => {
  // Guards against a route being marked covered by a command that was renamed
  // or never written — which is exactly how `exportEvents` sat unwired.
  const dispatched = new Set(
    (CLI.match(/^ {4}case "[a-z-]+"/gm) ?? []).map((line) => line.replace(/.*"(.*)"/, "$1")),
  );
  const claimed = new Set();
  for (const value of Object.values(COVERAGE)) {
    if (!value) continue;
    for (const part of value.split("/")) {
      const match = part.trim().match(/^bumper ([a-z-]+)/);
      if (match) claimed.add(match[1]);
    }
  }
  claimed.delete("<cli>");
  const absent = [...claimed].filter((command) => !dispatched.has(command));
  assert.deepEqual(absent, [], `coverage names commands the CLI does not dispatch: ${absent.join(", ")}`);
});

test("every dispatched command appears in --help", () => {
  const help = CLI.slice(CLI.indexOf("const HELP ="), CLI.indexOf("function fail("));
  const dispatched = (CLI.match(/^ {4}case "[a-z-]+"/gm) ?? [])
    .map((line) => line.replace(/.*"(.*)"/, "$1"))
    .filter((command) => !["help", "-h", "--help", "hook"].includes(command));
  const undocumented = dispatched.filter((command) => !help.includes(`bumper ${command}`));
  assert.deepEqual(undocumented, [], `commands missing from --help: ${undocumented.join(", ")}`);
});

test("no operation is written but left unreachable", () => {
  // exportEvents existed for a whole session without a caller. Exported
  // operations are product surface; an unused one is a feature nobody can use.
  const dir = join(process.cwd(), "src", "operations");
  const sources = readdirSync(dir).filter((name) => name.endsWith(".ts") && name !== "error.ts");
  const callers = [CLI, APP, ...sources.map((name) => readFileSync(join(dir, name), "utf8"))].join("\n");

  const unreachable = [];
  for (const name of sources) {
    const text = readFileSync(join(dir, name), "utf8");
    for (const match of text.matchAll(/^export (?:async )?function ([a-zA-Z0-9_]+)/gm)) {
      const fn = match[1];
      // Count references outside its own declaration line.
      const uses = (callers.match(new RegExp(`\\b${fn}\\b`, "g")) ?? []).length;
      if (uses <= 1) unreachable.push(`${name}:${fn}`);
    }
  }
  assert.deepEqual(unreachable, [], `operations with no caller: ${unreachable.join(", ")}`);
});
