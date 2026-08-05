/**
 * Performance budget — local, part of `npm test`. No CI service involved.
 *
 * Why this exists: on 2026-07-25 `/api/state` took **5.6 seconds** per request and
 * every functional test was green. The control plane polls that endpoint, so the whole
 * app felt like it was hanging, and nothing caught it. `detectAgents()` shelled out for
 * `--version` per agent (execFileSync, 1.5 s timeout each) and `stateJson` called it
 * three times. Performance regresses like any other behaviour, so it gets a guard.
 *
 * The budgets below are deliberately loose — roughly 10× the measured warm numbers —
 * so a busy laptop does not fail the suite, while a return to seconds-per-request does.
 * If a change makes these fail, the fix is the change, not the budget.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { detectAgents, invalidateAgentDetection } from "../dist/agents.js";

/** Measured warm figures after the 2026-07-25 fix, for context in failures. */
const BASELINE = { state: 37, agents: 3, detect: 26 };
const BUDGET = { state: 400, agents: 150, detect: 400 };

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function timeGet(url, runs) {
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    const res = await fetch(url);
    await res.arrayBuffer();
    samples.push(performance.now() - started);
  }
  return samples;
}

function withProject() {
  const dir = mkdtempSync(join(tmpdir(), "bumper-perf-"));
  const workspace = join(dir, "ws");
  mkdirSync(workspace, { recursive: true });
  const configPath = join(dir, "bumper.config.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    contexts: {
      Perf: {
        description: "", workspace, mode: "read-write", loginProfiles: {},
        room: {
          enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked",
          workspaceShare: "whole", shareSubpaths: [], shareEntries: [], doors: [],
        },
      },
    },
    defaultContext: "Perf",
    authProfiles: ["default"],
  }));
  return { dir, configPath, statePath: join(dir, "state.json") };
}

test("detectAgents() does not shell out per call", () => {
  invalidateAgentDetection();
  const cold = performance.now();
  detectAgents();
  const coldMs = performance.now() - cold;

  const warm = performance.now();
  for (let i = 0; i < 50; i += 1) detectAgents();
  const warmMs = (performance.now() - warm) / 50;

  assert.ok(
    coldMs < BUDGET.detect,
    `detectAgents() cold took ${Math.round(coldMs)} ms (budget ${BUDGET.detect} ms, ` +
      `baseline ${BASELINE.detect} ms). Something on this path is spawning processes ` +
      "or doing sync I/O again — check readVersion-style probes.",
  );
  assert.ok(
    warmMs < 5,
    `detectAgents() warm averaged ${warmMs.toFixed(2)} ms — the cache is not being hit.`,
  );
});

test("/api/state and /api/agents stay far below a second", async (t) => {
  const { dir, configPath, statePath } = withProject();
  const prevConfig = process.env.BUMPER_CONFIG;
  const prevState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = statePath;
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(process.cwd(), "dist", "cli.js"));
  t.after(async () => {
    await handle.close();
    if (prevConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = prevConfig;
    if (prevState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  });

  // First call may pay one-off detection; the UI polls, so judge the warm median.
  const state = await timeGet(`${handle.url}/api/state`, 6);
  const stateWarm = median(state.slice(1));
  assert.ok(
    stateWarm < BUDGET.state,
    `/api/state warm median ${Math.round(stateWarm)} ms (budget ${BUDGET.state} ms, ` +
      `baseline ${BASELINE.state} ms). The control plane polls this — seconds here means ` +
      "the whole app feels stuck. Look for sync child processes or directory walks per request.",
  );

  const agents = await timeGet(`${handle.url}/api/agents`, 5);
  const agentsWarm = median(agents.slice(1));
  assert.ok(
    agentsWarm < BUDGET.agents,
    `/api/agents warm median ${Math.round(agentsWarm)} ms (budget ${BUDGET.agents} ms, ` +
      `baseline ${BASELINE.agents} ms).`,
  );
});

test("stateJson detects agents once per request, not once per field", () => {
  const src = readFileSync(join(process.cwd(), "src", "app.ts"), "utf8");
  const start = src.indexOf("function stateJson(");
  assert.ok(start > 0);
  const end = src.indexOf("\nfunction ", start + 1);
  const bodyText = src.slice(start, end === -1 ? src.length : end);
  const calls = (bodyText.match(/detectAgents\(\)/g) || []).length;
  assert.ok(
    calls <= 1,
    `stateJson calls detectAgents() ${calls} times. Even cached, fan-out here is how the ` +
      "5.6 s regression happened — resolve it once and pass the value down.",
  );
});
