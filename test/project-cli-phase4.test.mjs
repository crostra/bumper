/**
 * Phase 4: boundary denial → AI error copy + GUI Blocked deep links.
 * Optional Door/read-only filesystem event classification is out of scope
 * (kernel/container failures lack a host observer without Sandbox-side instrumentation).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request } from "node:http";
import {
  formatBoundaryAiMessage,
  formatGitBrokerDenial,
  formatEgressDenial,
  newSessionEffectNote,
} from "../dist/boundary-denial.js";
import { EgressProxy } from "../dist/room/egress-proxy.js";

const html = () => readFileSync(join(process.cwd(), "assets", "app.html"), "utf8");
const js = () => readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");

// --- Pure denial copy ---

test("formatBoundaryAiMessage attributes Bumper, states what/why/fix, new sessions only", () => {
  const msg = formatBoundaryAiMessage({
    what: "write /host/secret",
    why: "the path is outside the shared workspace",
    fix: "Choose the folder in Project → Folders",
  });
  assert.match(msg, /^bumper: security boundary refusal/m);
  assert.match(msg, /What: write \/host\/secret/);
  assert.match(msg, /Why: the path is outside the shared workspace/);
  assert.match(msg, /Fix: Choose the folder/);
  assert.match(msg, /new sessions only/i);
  assert.match(msg, /current session is unchanged/i);
  // Errors only — not a conversation hijack or chat prompt.
  assert.doesNotMatch(msg, /how can I help/i);
  assert.doesNotMatch(msg, /would you like me to/i);
});

test("git broker denial points at Project → Git provider scope", () => {
  const d = formatGitBrokerDenial({
    project: "client-a",
    host: "github.com",
    path: "evil/secret.git",
  });
  assert.equal(d.kind, "git-broker");
  assert.equal(d.fixTab, "connections");
  assert.match(d.fixLabel, /Project → Git/i);
  assert.match(d.target, /^git github\.com\/evil\/secret/);
  assert.match(d.reason, /client-a/);
  assert.match(d.reason, /did not issue a GitHub token/i);
  assert.match(d.aiMessage, /bumper: security boundary refusal/);
  assert.match(d.aiMessage, /github\.com\/evil\/secret/);
  assert.match(d.aiMessage, /No access \/ Read \/ Read and write/i);
  assert.match(d.aiMessage, /new sessions only/i);
});

test("egress denial points at Sandbox egress settings", () => {
  const d = formatEgressDenial({
    project: "client-a",
    host: "evil.example.com",
    method: "CONNECT",
  });
  assert.equal(d.kind, "egress-proxy");
  assert.equal(d.fixTab, "room");
  assert.match(d.fixLabel, /Sandbox egress/i);
  assert.equal(d.target, "CONNECT evil.example.com");
  assert.match(d.reason, /client-a/);
  assert.match(d.reason, /egress allowlist/i);
  assert.match(d.aiMessage, /bumper: security boundary refusal/);
  assert.match(d.aiMessage, /CONNECT to evil\.example\.com/);
  assert.match(d.aiMessage, /Sandbox → Network egress/);
  assert.match(d.aiMessage, /new sessions only/i);
});

test("newSessionEffectNote is stable honesty copy for GUI", () => {
  assert.match(newSessionEffectNote(), /new sessions only/i);
  assert.match(newSessionEffectNote(), /bumper <cli>/i);
});

// --- Proxy integration (Sandbox git broker is removed) ---

test("egress proxy 403 body is standardized Bumper denial with project context", async (t) => {
  const events = [];
  const proxy = new EgressProxy(["api.allowed.test"], (e) => events.push(e), { project: "ship-proj" });
  const port = await proxy.listen("127.0.0.1");
  t.after(() => proxy.stop());

  const blocked = await new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "http://evil.blocked.test/",
      headers: { host: "evil.blocked.test" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(blocked.status, 403);
  assert.match(blocked.body, /bumper: security boundary refusal/);
  assert.match(blocked.body, /ship-proj/);
  assert.match(blocked.body, /evil\.blocked\.test/);
  assert.match(blocked.body, /Sandbox → Network egress/);
  assert.ok(events.some((e) => !e.allowed && e.denial?.fixTab === "room"));
});

// --- GUI Blocked deep links ---

test("Events page is the list host (filters + export; no storage-policy lecture)", () => {
  const appHtml = html();
  assert.match(appHtml, /id="events-list"/);
  assert.match(appHtml, /data-route="events"/);
  assert.match(appHtml, /data-i18n="events\.title"|Events/);
  assert.match(appHtml, /id="export-events"/);
  // Storage / never-stored / new-session lectures belong in Limits or toast, not the Events header.
  assert.doesNotMatch(appHtml, /never stored|payloads are never/i);
});

test("app.js wires Events deep links via open-project-settings to Project sections", () => {
  const appJs = js();
  assert.match(appJs, /function boundaryFixForEvent/);
  assert.match(appJs, /function openProjectSettingsFromEvent/);
  assert.match(appJs, /open-project-settings/);
  assert.match(appJs, /NEW_SESSION_EFFECT/);
  assert.match(appJs, /Takes effect on new sessions only/);
  // Git → Project Git, egress → Project Network
  assert.match(appJs, /Open Project → Git/);
  assert.match(appJs, /Open Project → Network/);
  assert.doesNotMatch(appJs, /Git scopes/);
  // Uses event.fixTab from log when present
  assert.match(appJs, /event\.fixTab/);
  assert.match(appJs, /event\.fixLabel/);
  assert.match(appJs, /openProjectPage\(name, section\)/);
  assert.doesNotMatch(appJs, /how can I help you with this block/i);
});

test("app.js routes git network blocks to provider-scope guidance, never Allow", () => {
  const appJs = js();
  assert.doesNotMatch(appJs, /Allow repo scope \(new sessions\)/);
  assert.match(appJs, /Choose the repository and token scope in Project → Git/);
  assert.match(appJs, /GitHub enforces the upper bound/);
  assert.match(appJs, /open-project-settings/);
  // Network (git and generic) is guidance-only — no Allow button path.
  assert.match(appJs, /egress-guidance/);
  assert.match(appJs, /Allow cannot open the current Sandbox boundary/);
  assert.doesNotMatch(appJs, /function gitNetworkRepoFromTarget/);
});
