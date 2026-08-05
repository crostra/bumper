/**
 * Which renderer `window.open` calls reach the user's browser.
 *
 * Regression (2026-07-26): the handler forwarded only `https://` URLs. The GitHub
 * App hand-off page Bumper serves on its own loopback origin therefore opened
 * nowhere at all, while the UI showed "GitHub opened in your browser". A silent
 * no-op is the worst failure shape here, so this is asserted directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { windowOpenAction } from "../dist/electron-links.js";

const ORIGIN = "http://127.0.0.1:7777";

test("Bumper's own loopback pages open in the user's browser", () => {
  assert.deepEqual(
    windowOpenAction(`${ORIGIN}/github/manifest/start?state=abc`, ORIGIN),
    { kind: "external" },
    "the GitHub hand-off must reach the browser — only it carries the POST and the GitHub session",
  );
});

test("terminal windows stay inside the app", () => {
  assert.deepEqual(
    windowOpenAction(`${ORIGIN}/terminal.html?session=s1`, ORIGIN),
    { kind: "terminal", sessionId: "s1" },
  );
  assert.deepEqual(windowOpenAction(`${ORIGIN}/terminal.html`, ORIGIN), { kind: "deny" },
    "a terminal window with no session id is not a window to open");
});

test("external https opens; anything else off-origin is denied", () => {
  assert.deepEqual(windowOpenAction("https://github.com/settings/apps/new", ORIGIN), { kind: "external" });
  // Another process on loopback is not Bumper: a different port is a different origin.
  assert.deepEqual(windowOpenAction("http://127.0.0.1:9999/anything", ORIGIN), { kind: "deny" });
  assert.deepEqual(windowOpenAction("http://evil.example/x", ORIGIN), { kind: "deny" });
  assert.deepEqual(windowOpenAction("file:///etc/passwd", ORIGIN), { kind: "deny" });
  assert.deepEqual(windowOpenAction("javascript:alert(1)", ORIGIN), { kind: "deny" });
  assert.deepEqual(windowOpenAction("not a url", ORIGIN), { kind: "deny" });
});

test("with no app origin yet, only https is forwarded", () => {
  // `handle` is null before boot finishes; an empty origin must not match everything.
  assert.deepEqual(windowOpenAction(`${ORIGIN}/github/manifest/start`, ""), { kind: "deny" });
  assert.deepEqual(windowOpenAction("https://github.com/x", ""), { kind: "external" });
});
