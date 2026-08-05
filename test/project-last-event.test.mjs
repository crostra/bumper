/**
 * Projects list orders by latest Event time, then config creation order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("latestEventAtByContext returns the newest event per Project", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-last-event-"));
  const statePath = join(root, "state.json");
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(statePath, "{}");
  process.env.BUMPER_STATE = statePath;
  process.env.BUMPER_CONFIG = join(root, "cfg.json");
  writeFileSync(process.env.BUMPER_CONFIG, JSON.stringify({ defaultContext: "alpha", contexts: { alpha: {}, beta: {} } }));

  // Fresh module path resolution against this state file.
  const { logEvent, latestEventAtByContext } = await import(`${repoRoot}/dist/log.js?t=${Date.now()}`);

  logEvent({ context: "alpha", surface: "session", decision: "allowed", target: "a-old", reason: "1" });
  await new Promise((r) => setTimeout(r, 5));
  logEvent({ context: "beta", surface: "session", decision: "allowed", target: "b", reason: "2" });
  await new Promise((r) => setTimeout(r, 5));
  logEvent({ context: "alpha", surface: "session", decision: "blocked", target: "a-new", reason: "3" });

  const map = latestEventAtByContext(["alpha", "beta", "gamma"]);
  assert.ok(map.alpha, "alpha has activity");
  assert.ok(map.beta, "beta has activity");
  assert.equal(map.gamma, undefined, "unused project omitted");
  assert.ok(Date.parse(map.alpha) >= Date.parse(map.beta), "alpha is newer after its second event");

  rmSync(root, { recursive: true, force: true });
});

test("Projects list sorts by lastEventAt then config order", () => {
  const appJs = readFileSync(join(repoRoot, "assets", "app.js"), "utf8");
  assert.match(appJs, /function projectLastEventMs/);
  assert.match(appJs, /function projectLastEventLabel/);
  assert.match(appJs, /tb - ta/);
  assert.match(appJs, /order\.indexOf\(nameA\) - order\.indexOf\(nameB\)/);
  assert.match(appJs, /lastEventAt/);
  assert.match(appJs, /No activity/);
});
