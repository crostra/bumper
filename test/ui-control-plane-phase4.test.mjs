/**
 * Network honesty: Off / Allowed-only / Open, and what each one may claim.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";
import { roomAssurance } from "../dist/room/assurance.js";

const appJs = () => readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
const appHtml = () => readFileSync(join(process.cwd(), "assets", "app.html"), "utf8");

test("Network offers Off, Allowed-only and Open, each with its own honest note", () => {
  const js = appJs();
  const html = appHtml();
  assert.match(js, /function renderProjectNetwork/);
  assert.match(js, /data-value="open"[^>]*>Open</);
  assert.match(js, /data-value="allowlist"[^>]*>Allowed only</);
  assert.match(js, /No internet/);
  assert.match(js, /Full internet/);
  assert.match(js, /Unfiltered by choice/);
  assert.match(js, /Open · unfiltered/);
  assert.match(js, /networkAssuranceBadge/);
  assert.match(js, /function networkModeNote/);
  // The allowlist control must ship with the picker that fills it, and the
  // groups must come from the host so the UI and the proxy cannot drift.
  assert.match(js, /state\.egressTemplates/);
  assert.match(js, /network-extra-hosts/);
  // Saving any other tab must not quietly clear the Project's allowed sites.
  assert.match(js, /egressTemplates: \[\.\.\.\(project\.room\?\.egressTemplates \|\| \[\]\)\]/);
  assert.doesNotMatch(html, /id="project-room-egress"|id="egress-hosts"|Allowed destinations/);
});

test("Assurance: Open unrestricted; Off VM; allowlist VM via host-only network", () => {
  const open = roomAssurance({
    mode: "read-write",
    repos: [],
    readPaths: [],
    writePaths: [],
    denyReadPaths: [],
    denyWritePaths: [],
    commands: {},
    room: { enabled: true, image: "x", egress: "open", doors: [] },
  }).find((item) => item.id === "egress");
  assert.equal(open.source, "not-enforced");
  assert.match(open.label, /unrestricted/i);

  const off = roomAssurance({
    mode: "read-write",
    repos: [],
    readPaths: [],
    writePaths: [],
    denyReadPaths: [],
    denyWritePaths: [],
    commands: {},
    room: { enabled: true, image: "x", egress: "blocked", doors: [] },
  }).find((item) => item.id === "egress");
  assert.equal(off.source, "vm");
  assert.match(off.label, /Off/i);

  const allow = roomAssurance({
    mode: "read-write",
    repos: [],
    readPaths: [],
    writePaths: [],
    denyReadPaths: [],
    denyWritePaths: [],
    commands: {},
    room: { enabled: true, image: "x", egress: "allowlist", egressTemplates: ["anthropic"], egressHosts: [], doors: [] },
  }).find((item) => item.id === "egress");
  assert.equal(allow.source, "vm");
  assert.match(allow.detail, /host-only network/i);
});

test("Phase 4A API: Network save path coerces product egress to Off/Open and clears hosts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-phase4-api-"));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  const cfg = join(root, "bumper.config.json");
  const statePath = join(root, "state.json");
  writeFileSync(cfg, JSON.stringify({
    webPort: 0,
    defaultContext: "demo",
    contexts: {
      demo: {
        mode: "read-write",
        workspace,
        inheritMode: false,
        backends: [],
        room: {
          enabled: true,
          image: "docker.io/library/alpine:3.20",
          egress: "allowlist",
          egressTemplates: ["anthropic"],
          egressHosts: ["api.example.com"],
          doors: [],
        },
      },
    },
  }));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = cfg;
  process.env.BUMPER_STATE = statePath;
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(process.cwd(), "dist", "cli.js"));
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  const put = await fetch(`${handle.url}/api/contexts`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      previous: "demo",
      name: "demo",
      description: "",
      workspace,
      mode: "read-write",
      inheritMode: true,
      gitIgnored: "visible",
      readPaths: [],
      writePaths: [],
      denyReadPaths: [],
      denyWritePaths: [],
      commands: {},
      native: { allow: [], deny: [] },
      loginProfiles: {},
      repos: [],
      allowedHosts: [],
      backends: [],
      room: {
        enabled: true,
        image: "docker.io/library/alpine:3.20",
        egress: "blocked",
        egressTemplates: [],
        egressHosts: [],
        doors: [],
      },
    }),
  });
  assert.equal(put.status, 200, await put.text());
  const after = loadConfig().config;
  assert.equal(after.contexts.demo.room.egress, "blocked");
  assert.deepEqual(after.contexts.demo.room.egressTemplates, []);
  assert.deepEqual(after.contexts.demo.room.egressHosts, []);
});

test("Phase 1–3 regression: shell + folders + profiles markers remain", () => {
  const js = appJs();
  const html = appHtml();
  assert.match(html, /data-route="projects"/);
  assert.match(html, /data-project-section="network"/);
  assert.match(js, /function renderProjectFolders/);
  // Phase 9-6 F5: Library AI UI deleted; storage is Settings → Privacy.
  assert.doesNotMatch(js, /function renderLibraryAiProfiles/);
  assert.match(js, /settings\.privacy\.ai_title|ai-storage-row/);
  // Network honesty + MCP Hub markers remain.
  assert.match(js, /Unfiltered by choice|No internet/);
  /*
   * Allowlist was withheld from the product UI while it was only a proxy
   * convention a room could ignore. It is offered now because the room runs on
   * a host-only network and the bypass is gone — proven in
   * test/egress-network-vm.test.mjs. The guard therefore inverts: the option
   * must be present, and it must be paired with the picker that decides which
   * hosts the proxy admits, so it can never ship as an empty promise.
   */
  assert.match(js, /data-value="allowlist"/);
  assert.match(js, /function renderEgressGroups/);
  assert.match(js, /network-extra-hosts/);
});
