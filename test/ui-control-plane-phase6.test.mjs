/**
 * Phase 6 — Events filters/grouping, atomic config + backups, diagnostics gate,
 * Settings categories, semantic i18n parity (locales), uninstall assistant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { mutateRawConfig, listConfigBackups, MAX_CONFIG_BACKUPS, describeUninstall, executeUninstallCleanup } from "../dist/config-store.js";
import { logEvent, readEvents, groupEvents, pruneEvents } from "../dist/log.js";
import { evaluateAiProof } from "../dist/room/aiproof.js";
import { setProtectionMismatch, blocksProtectedLaunch, clearProtectionMismatch } from "../dist/protection-status.js";
import { writePrefs, readPrefs } from "../dist/prefs.js";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appJs = () => readFileSync(join(repoRoot, "assets", "app.js"), "utf8");
const appHtml = () => readFileSync(join(repoRoot, "assets", "app.html"), "utf8");
const localeEn = () => JSON.parse(readFileSync(join(repoRoot, "assets", "locales", "en.json"), "utf8"));
const localeJa = () => JSON.parse(readFileSync(join(repoRoot, "assets", "locales", "ja.json"), "utf8"));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase6-"));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  const cfg = join(root, "bumper.config.json");
  const statePath = join(root, "state.json");
  writeFileSync(cfg, JSON.stringify({
    webPort: 0,
    defaultContext: "demo",
    contexts: {
      demo: {
        workspace,
        mode: "read-only",
        backends: [],
        room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked" },
      },
    },
  }));
  writeFileSync(statePath, JSON.stringify({ activeContext: "demo" }));
  process.env.BUMPER_CONFIG = cfg;
  process.env.BUMPER_STATE = statePath;
  return { root, cfg, statePath, workspace };
}

test("UI: Events filters + Settings six categories + diagnostics present", () => {
  const html = appHtml();
  const js = appJs();
  assert.match(html, /id="events-source"/);
  assert.match(html, /id="events-type"/);
  assert.match(html, /id="events-time"/);
  assert.match(html, /value="1h"[^>]*selected|selected[^>]*value="1h"/);
  assert.match(js, /timeWindow === "1h"|=== "1h"/);
  assert.match(js, /abortEventsRender|eventsRenderGen/);
  assert.match(html, /id="settings-nav"/);
  assert.match(html, /page-subnav/);
  assert.match(js, /function pageSubnav|pageSubnav\(/);
  assert.match(js, /function backLink|backLink\(/);
  assert.match(js, /SETTINGS_CATEGORIES/);
  assert.match(js, /settings\.cat\.system/);
  assert.match(js, /settings\.cat\.privacy/);
  assert.match(js, /settings\.cat\.language/);
  assert.match(js, /settings\.cat\.updates/);
  assert.match(js, /settings\.cat\.data/);
  assert.match(js, /runSecurityDiagnostics|\/api\/room\/ai-proof/);
  assert.match(js, /grouped:\s*"1"|grouped=1/);
  assert.match(js, /eventRetention/);
  assert.match(js, /uninstall/);
  assert.doesNotMatch(js, /Security diagnostics move here in Phase 6/);
  assert.doesNotMatch(html, /Full six-category Settings arrive in Phase 6/);
  // Selected network UI remains hidden; honesty copy may mention the STOP.
  assert.doesNotMatch(html, /id="project-room-egress-hosts"|data-value="allowlist"/);
});

test("i18n: EN/JA semantic locale key parity", () => {
  const en = localeEn();
  const ja = localeJa();
  const enKeys = Object.keys(en).sort();
  const jaKeys = Object.keys(ja).sort();
  assert.deepEqual(jaKeys, enKeys, `JA missing/extra keys vs EN:\nJA-EN=${jaKeys.filter((k) => !en[k])}\nEN-JA=${enKeys.filter((k) => !ja[k])}`);
  for (const key of enKeys) {
    assert.equal(typeof en[key], "string");
    assert.equal(typeof ja[key], "string");
    assert.ok(ja[key].length > 0, `empty JA for ${key}`);
  }
  assert.match(appJs(), /function t\(/);
  assert.match(appHtml(), /data-i18n="events\.title"/);
  assert.match(readFileSync(join(repoRoot, "assets", "i18n.js"), "utf8"), /__BUMPER_LOCALES__/);
});

test("config-store: atomic mutate rotates up to 5 backups", () => {
  const { root, cfg } = fixture();
  try {
    for (let i = 0; i < 7; i++) {
      mutateRawConfig((raw) => {
        raw.webPort = 4300 + i;
      });
    }
    const backups = listConfigBackups();
    assert.ok(backups.length <= MAX_CONFIG_BACKUPS);
    assert.ok(backups.length >= 1);
    const live = JSON.parse(readFileSync(cfg, "utf8"));
    assert.equal(live.webPort, 4306);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("events: group + retention + source/type filters via API", async () => {
  const { root } = fixture();
  writePrefs({ eventRetention: "7d" });
  logEvent({
    context: "demo", surface: "sandbox", decision: "blocked",
    target: "/etc/passwd", reason: "outside Access",
  });
  logEvent({
    context: "demo", surface: "sandbox", decision: "blocked",
    target: "/etc/passwd", reason: "outside Access again",
  });
  logEvent({
    context: "demo", surface: "mcp", decision: "allowed",
    target: "stub__ping", reason: "tool allowed",
  });
  const grouped = groupEvents(readEvents({ context: "demo", limit: 50 }));
  assert.ok(grouped.some((g) => g.count >= 2 && g.target === "/etc/passwd"));

  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(repoRoot, "dist", "cli.js"));
  try {
    const res = await fetch(`${handle.url}/api/events?grouped=1&type=files&context=demo`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.grouped, true);
    assert.ok(Array.isArray(body.groups));
    assert.ok(body.groups.every((g) => g.type === "files"));

    const exp = await fetch(`${handle.url}/api/events/export?type=mcp&context=demo`);
    const exported = await exp.json();
    assert.ok(exported.every((e) => e.type === "mcp"));
    assert.ok(!JSON.stringify(exported).includes("password"));

    writePrefs({ eventRetention: "off" });
    pruneEvents("off");
    assert.deepEqual(readEvents({ limit: 10 }), []);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostics Expected/Observed Match unit + mismatch launch gate", async () => {
  const probe = {
    id: "host-fs-escape",
    title: "Cannot reach the host filesystem",
    description: "x",
    command: ["/bin/true"],
    expect: "blocked",
  };
  const pass = evaluateAiProof(probe, "OUTCOME=blocked\n");
  assert.equal(pass.pass, true);
  assert.equal(pass.expect, "blocked");
  assert.equal(pass.observed, "blocked");
  const fail = evaluateAiProof(probe, "OUTCOME=allowed\n");
  assert.equal(fail.pass, false);
  assert.equal(fail.observed, "allowed");

  const { root, workspace } = fixture();
  try {
    setProtectionMismatch("demo", ["host-fs-escape"], "test mismatch");
    assert.equal(blocksProtectedLaunch("demo"), true);
    const { config } = loadConfig();
    const handle = await startApp(config, () => loadConfig().config, join(repoRoot, "dist", "cli.js"));
    try {
      const blocked = await fetch(`${handle.url}/api/room/agent-sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ context: "demo", workspace, agentId: "claude" }),
      });
      assert.equal(blocked.status, 409);
      const err = await blocked.json();
      assert.equal(err.launchBlocked, true);

      const report = await fetch(`${handle.url}/api/diagnostics/report`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({
          action: "preview",
          context: "demo",
          results: [{ id: "x", title: "t", expect: "blocked", observed: "allowed", pass: false, evidence: "e" }],
        }),
      });
      assert.equal(report.status, 200);
      const preview = await report.json();
      assert.equal(preview.report.kind, "bumper-security-diagnostics");
      assert.equal(preview.report.results[0].match, false);

      clearProtectionMismatch("demo");
      assert.equal(blocksProtectedLaunch("demo"), false);
    } finally {
      await handle.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uninstall assistant never targets workspace paths", () => {
  const { root, workspace } = fixture();
  try {
    const plan = describeUninstall({ includeLocalData: true });
    assert.ok(plan.neverDeletes.some((line) => /workspace/i.test(line)));
    assert.ok(!plan.localDataPaths.includes(workspace));
    const result = executeUninstallCleanup({ includeLocalData: false });
    assert.ok(existsSync(workspace));
    assert.ok(result.skipped.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prefs retention round-trip via API", async () => {
  const { root } = fixture();
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(repoRoot, "dist", "cli.js"));
  try {
    const put = await fetch(`${handle.url}/api/prefs`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
      body: JSON.stringify({ eventRetention: "30d" }),
    });
    assert.equal(put.status, 200);
    const prefs = await put.json();
    assert.equal(prefs.eventRetention, "30d");
    assert.equal(readPrefs().eventRetention, "30d");
    const state = await (await fetch(`${handle.url}/api/state`)).json();
    assert.equal(state.prefs.eventRetention, "30d");
    assert.ok(Array.isArray(state.configBackups));
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
