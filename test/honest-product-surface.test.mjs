/**
 * G4 honest-product-surface regressions (control-plane IA).
 * Asserts MCP Hub honesty (MCP-only external path; no Coming soon), Network honesty,
 * Allow applicability, and that legacy Launch/Home/command-category surfaces are gone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";
import { applyRule, inferSpecFromEvent, inferSpecFromString } from "../dist/rules.js";

const html = () => readFileSync(join(process.cwd(), "assets", "app.html"), "utf8");
const js = () => readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
const css = () => readFileSync(join(process.cwd(), "assets", "app.css"), "utf8");
const rulesSrc = () => readFileSync(join(process.cwd(), "src", "rules.ts"), "utf8");

test("MCP Hub is Library/Project Connections with MCP-only external honesty", () => {
  const appHtml = html();
  const appJs = js();
  assert.doesNotMatch(appHtml, /id="mcp-advanced"/);
  assert.doesNotMatch(appHtml, /id="backend-list"/);
  assert.doesNotMatch(appHtml, /data-route="connections"/);
  assert.match(appHtml, /data-project-section="connections"/);
  assert.match(appJs, /MCP integrations/);
  assert.match(appJs, /function renderProjectConnections/);
  assert.match(appJs, /MCP-only/);
  assert.doesNotMatch(appJs, /Coming soon/i);

  /*
   * The Connections screen must state the two things bindings alone cannot:
   * what the AI will actually be able to call, and that a bound tool acts
   * outside the room. It must no longer claim MCP is absent from the Sandbox.
   */
  assert.match(appJs, /function wireMcpPreview/);
  assert.match(appJs, /api\/project\/mcp-preview/);
  assert.match(appJs, /function mcpDeliveryPanelHtml/);
  assert.match(appJs, /roomMcpDelivery/);
  assert.match(appJs, /acts <b>outside<\/b> the (room|Sandbox)/);
  assert.doesNotMatch(appJs, /not injected into Sandbox/i);
  assert.doesNotMatch(appJs, /MCP set/i);
  // MCP Connections show Mac-side checking in plain language (threat-model still
  // says Broker enforced; product UI does not use that term on normal surfaces).
  assert.match(js(), /Checked on this Mac/);
  assert.doesNotMatch(js(), /Broker enforced/);
  // Git credential dialog is gone — room holds no token; push is host-side.
  assert.doesNotMatch(appHtml, /id="token-dialog"/);
  assert.doesNotMatch(appHtml, /Sandbox Git credential/);
});

test("Project Network UI offers Off, Allowed only, and Open with honest facts", () => {
  const appJs = js();
  assert.match(appJs, /function renderProjectNetwork/);
  assert.match(appJs, /function networkModeNote/);
  // Fact surface: short labels; long caveats live in Limits.
  assert.match(appJs, /data-value="open"[^>]*>Open</);
  assert.match(appJs, /data-value="allowlist"[^>]*>Allowed only</);
  assert.match(appJs, /No internet/);
  assert.match(appJs, /Full internet/);
  assert.match(appJs, /Unfiltered by choice/);
  assert.match(appJs, /Open · unfiltered/);
  assert.match(appJs, /networkAssuranceBadge/);
  assert.match(appJs, /state\.egressTemplates/);
  assert.match(appJs, /network-extra-hosts/);
  assert.doesNotMatch(appJs, /network-boundary-preview|network-preview-note/);
  assert.doesNotMatch(html(), /data-dialog-pane="commands"/);
  assert.doesNotMatch(html(), /id="global-commands"/);
  assert.doesNotMatch(html(), /Exact command rules/);
  assert.doesNotMatch(html(), /id="project-room-egress"|id="egress-hosts"|Allowed destinations/);
});

test("Allow action surfaces applicability labels for native vs git (no Allow on network)", () => {
  const appJs = js();
  assert.match(appJs, /function allowApplicability\(/);
  assert.doesNotMatch(appJs, /function gitNetworkRepoFromTarget\(/);
  assert.match(appJs, /function isGitNetworkTarget\(/);
  assert.match(appJs, /Allow as intent \(new sessions\)/);
  assert.doesNotMatch(appJs, /Allow repo scope \(new sessions\)/);
  assert.match(appJs, /Choose the repository and token scope in Project → Git/);
  assert.match(appJs, /GitHub enforces the upper bound/);
  assert.match(appJs, /Not enforced in Sandbox/);
  assert.match(appJs, /allow-applicability/);
  assert.match(appJs, /mode: "egress-guidance"/);
  assert.match(appJs, /Sandbox network\/egress block/);
  assert.match(appJs, /Allow cannot open the current Sandbox boundary/);
  assert.match(appJs, /Project → Network/);
  assert.match(appJs, /open-room-egress/);
  assert.match(appJs, /section: "network"|section: fix\?\.section/);
  assert.doesNotMatch(appJs, />Allow in this project</);
  assert.match(appJs, /allowApplicability\(event\.surface, event\.target, event\)/);
  assert.match(appJs, /isGitNetworkTarget\(target\)/);
  assert.match(appJs, /open-project-settings/);
  assert.match(appJs, /boundaryFixForEvent/);
});

test("inferSpecFromEvent: network/git never convert to a rule", () => {
  // Git-prefixed and generic egress both refuse — no repo Spec kind exists.
  assert.equal(inferSpecFromEvent("network", "git github.com/acme/app"), undefined);
  assert.equal(inferSpecFromEvent("network", "git github.com/acme"), undefined);
  assert.equal(inferSpecFromEvent("network", "GET example.com"), undefined);
  assert.equal(inferSpecFromEvent("network", "CONNECT registry.npmjs.org"), undefined);
  assert.equal(inferSpecFromEvent("network", "POST api.github.com"), undefined);
  assert.equal(inferSpecFromEvent("network", "example.com"), undefined);
  assert.equal(inferSpecFromEvent("network", "github.com/acme"), undefined);
  assert.equal(inferSpecFromEvent("network", "dns example.com"), undefined);
  assert.equal(inferSpecFromEvent("network", "git"), undefined);
  assert.equal(inferSpecFromEvent("network", "git "), undefined);

  assert.equal(inferSpecFromEvent("native", "Bash · rm -rf /")?.kind, "native-command");
});

test("inferSpecFromString refuses host/path as a git allow rule", () => {
  assert.throws(
    () => inferSpecFromString("github.com/acme"),
    /cannot become a local Allow rule|GitHub token scope/i,
  );
  assert.throws(
    () => inferSpecFromString("github.com/acme/app"),
    /cannot become a local Allow rule|GitHub token scope/i,
  );
  const native = inferSpecFromString("Bash:git push");
  assert.equal(native.kind, "native-command");
  assert.equal(native.value, "Bash:git push");
});

test("no code path writes context.repos via applyRule", () => {
  const src = rulesSrc();
  assert.doesNotMatch(src, /kind:\s*"repo"/);
  assert.doesNotMatch(src, /spec\.kind\s*===\s*"repo"/);
  assert.doesNotMatch(src, /ensureArray\(\s*ctx\s*,\s*["']repos["']\s*\)/);
  assert.doesNotMatch(src, /ctx\.repos\s*=/);
  assert.doesNotMatch(src, /repos\.push/);
  assert.doesNotMatch(src, /gitNetworkRepoFromTarget/);
});

test("applyRule messages state Sandbox applicability honestly (native only)", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-rules-honest-"));
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    defaultContext: "Safe",
    backends: {},
    contexts: {
      Safe: {
        description: "test",
        mode: "read-write",
        backends: [],
        native: { allow: [], deny: [] },
        repos: ["github.com/legacy"],
        writePaths: [],
        readPaths: [],
      },
    },
  }));
  const previous = process.env.BUMPER_CONFIG;
  process.env.BUMPER_CONFIG = configPath;
  try {
    const native = applyRule("allow", { kind: "native-command", value: "Bash:rm -rf", label: 'Bash commands starting "rm -rf"' }, "Safe");
    assert.match(native.message, /Not enforced inside Sandbox/i);
    assert.match(native.message, /new sessions/i);
    assert.match(native.message, /does not open the current Sandbox/i);

    // Legacy repos field untouched by native allow.
    assert.deepEqual(loadConfig().config.contexts.Safe.repos, ["github.com/legacy"]);
  } finally {
    if (previous === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("served app HTML/JS keep control-plane honesty and refuse git/network Allow", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-honest-app-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0, defaultContext: "Safe", backends: {},
    contexts: { Safe: { description: "test", mode: "read-write", backends: [], writePaths: [], readPaths: [], repos: ["github.com/acme"], allowedHosts: [] } },
  }));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = statePath;
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(process.cwd(), "dist", "cli.js"));
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG; else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE; else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  const appHtml = await (await fetch(handle.url)).text();
  const appJs = await (await fetch(`${handle.url}/app.js`)).text();
  const appCss = await (await fetch(`${handle.url}/app.css`)).text();

  assert.doesNotMatch(appHtml, /id="mcp-advanced"/);
  assert.doesNotMatch(appHtml, /id="seatbelt-advanced"/);
  assert.doesNotMatch(appHtml, /id="launch-button"/);
  assert.doesNotMatch(appHtml, /id="route-home"/);
  assert.match(appHtml, /data-route="projects"/);
  assert.match(appHtml, /data-project-section="overview"/);

  assert.match(appJs, /allowApplicability/);
  assert.match(appJs, /Checked on this Mac|Controlled per Session/);
  assert.match(appCss, /overview-layout/);
  assert.match(appCss, /allow-applicability/);

  const allow = await fetch(`${handle.url}/api/allow`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: "Safe", surface: "native", target: "Bash · rm -rf /" }),
  });
  assert.equal(allow.status, 200);
  const body = await allow.json();
  assert.match(body.message, /Not enforced inside Sandbox/i);
  assert.match(body.message, /new sessions/i);

  // Git network event: refuse with explanation — never silently record repos.
  const allowGit = await fetch(`${handle.url}/api/allow`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: "Safe", surface: "network", target: "git github.com/new-org/repo" }),
  });
  assert.equal(allowGit.status, 400);
  const gitBody = await allowGit.json();
  assert.match(gitBody.error, /cannot become a local Allow rule|GitHub enforces the upper bound/i);
  assert.deepEqual(loadConfig().config.contexts.Safe.repos, ["github.com/acme"]);

  for (const target of ["GET example.com", "CONNECT registry.npmjs.org", "example.com", "github.com/nope", "git github.com/x"]) {
    const refused = await fetch(`${handle.url}/api/allow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ context: "Safe", surface: "network", target }),
    });
    assert.equal(refused.status, 400, `expected 400 for target ${target}`);
    const err = await refused.json();
    assert.match(err.error, /cannot become a local Allow rule|GitHub enforces the upper bound|cannot be converted|Network/i);
    // No silent write into repos for any network allow attempt.
    assert.deepEqual(loadConfig().config.contexts.Safe.repos, ["github.com/acme"]);
  }
});

test("path-test API assurance is explicit legacy-seatbelt (not Sandbox-like macOS enforced)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-path-assurance-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0, defaultContext: "Safe", backends: {},
    contexts: { Safe: { description: "test", mode: "read-write", backends: [], writePaths: [], readPaths: [], repos: [], allowedHosts: [] } },
  }));
  const previousConfig = process.env.BUMPER_CONFIG;
  const previousState = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = statePath;
  const { config } = loadConfig();
  const handle = await startApp(config, () => loadConfig().config, join(process.cwd(), "dist", "cli.js"));
  t.after(async () => {
    await handle.close();
    if (previousConfig === undefined) delete process.env.BUMPER_CONFIG; else process.env.BUMPER_CONFIG = previousConfig;
    if (previousState === undefined) delete process.env.BUMPER_STATE; else process.env.BUMPER_STATE = previousState;
    rmSync(root, { recursive: true, force: true });
  });

  const pathTest = await fetch(`${handle.url}/api/path-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ context: "Safe", workspace, path: workspace }),
  });
  assert.equal(pathTest.status, 200);
  const result = await pathTest.json();
  assert.equal(result.assurance, "legacy-seatbelt");
  assert.notEqual(result.assurance, "macOS enforced");
  assert.doesNotMatch(result.assurance, /Room|VM|sealed/i);
});

test("CSS supports overview shell and allow applicability without Home launch chrome", () => {
  const appCss = css();
  assert.match(appCss, /\.stack/);
  assert.match(appCss, /\.page-subnav/);
  assert.match(appCss, /\.back-link/);
  assert.match(appCss, /\.content-panel/);
  // Migration aliases (keep until callers drop dual classes)
  assert.match(appCss, /\.overview-layout/);
  assert.match(appCss, /\.project-subnav/);
  assert.match(appCss, /\.allow-applicability/);
  assert.match(appCss, /\.assurance\.hook/);
});
