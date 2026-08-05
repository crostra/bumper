/**
 * Architecture guard for src/operations.
 *
 * The point of the layer is that `bumper network off` and the GUI's Network
 * control run the *same* function. That only holds while operations stay free
 * of transport and presentation — the moment one reaches for `res` or
 * `console.log`, the other entry point needs its own copy, and the maintenance
 * cost doubles again.
 *
 * A convention in a README does not survive a year. A failing test does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "src", "operations");

function operationSources() {
  return readdirSync(DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => ({ name, text: readFileSync(join(DIR, name), "utf8") }));
}

/** Strip comments so prose about `console.log` does not trip the checks. */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("operations import no transport", () => {
  const forbidden = [
    { pattern: /from ["']node:http["']/, why: "node:http — operations must not know they are served over HTTP" },
    { pattern: /from ["']node:https["']/, why: "node:https" },
    { pattern: /from ["']ws["']/, why: "ws — WebSocket is an adapter concern" },
    { pattern: /from ["']\.\.\/app\.js["']/, why: "app.js — the HTTP adapter depends on operations, never the reverse" },
    { pattern: /from ["']\.\.\/cli\.js["']/, why: "cli.js — same, for the TTY adapter" },
  ];
  for (const { name, text } of operationSources()) {
    const body = code(text);
    for (const { pattern, why } of forbidden) {
      assert.ok(!pattern.test(body), `src/operations/${name} imports ${why}`);
    }
  }
});

test("operations do not print or exit", () => {
  for (const { name, text } of operationSources()) {
    const body = code(text);
    assert.ok(
      !/\bconsole\s*\./.test(body),
      `src/operations/${name} calls console.* — return data and let the adapter format it`,
    );
    assert.ok(
      !/\bprocess\.exit\s*\(/.test(body),
      `src/operations/${name} calls process.exit — throw OperationError instead`,
    );
  }
});

test("operations fail with OperationError, not bare Error", () => {
  for (const { name, text } of operationSources()) {
    if (name === "error.ts") continue;
    const body = code(text);
    const bare = body.match(/throw new Error\(/g);
    assert.equal(
      bare,
      null,
      `src/operations/${name} throws a bare Error — use OperationError so both adapters can map it`,
    );
  }
});

test("container autostart can be refused globally", async () => {
  // A test run, or CI, must be able to assert on CLI output without starting
  // launchd services on the host it happens to be on.
  const { ensureContainerSystem } = await import("../dist/operations/container-system.js");
  const previous = process.env.BUMPER_NO_CONTAINER_AUTOSTART;
  process.env.BUMPER_NO_CONTAINER_AUTOSTART = "1";
  try {
    const result = ensureContainerSystem();
    // Either the services were already up, or we refused to start them —
    // never "started: true" while the refusal is in effect.
    assert.equal(result.started, false, "BUMPER_NO_CONTAINER_AUTOSTART=1 must prevent a start");
  } finally {
    if (previous === undefined) delete process.env.BUMPER_NO_CONTAINER_AUTOSTART;
    else process.env.BUMPER_NO_CONTAINER_AUTOSTART = previous;
  }
});

test("the layer is not empty (the guard would pass vacuously)", () => {
  const sources = operationSources();
  assert.ok(sources.length >= 2, "expected src/operations to hold error.ts plus at least one operation");
  assert.ok(sources.some((s) => s.name !== "error.ts"), "expected at least one real operation");
});
