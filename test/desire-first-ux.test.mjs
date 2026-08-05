/**
 * Desire-first UX contract (2026-07-25 overhaul).
 *
 * The product's value has to be legible before it is configured, so these tests
 * pin the surfaces that carry it: the boundary sentence + permission ledger, the
 * Prove-it run against the real room, the single honest limits list, and
 * auto-approve — the speed benefit that only a real boundary can offer.
 * Auto-approve flags are verified against the Sandbox image, never guessed, so the
 * mapping is a contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../dist/config.js";
import { startApp } from "../dist/app.js";
import { autoApproveArgsFor, composeRoomCommand, supportsAutoApprove } from "../dist/agents.js";
import { applyCreatedProject } from "../dist/project.js";
import { initialRoomImage, RECOMMENDED_ROOM_IMAGE, SAFE_BASE_ROOM_IMAGE } from "../dist/room/setup.js";
import { ContextSchema } from "../dist/types.js";

const html = () => readFileSync(join(process.cwd(), "assets", "app.html"), "utf8");
const js = () => readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
const css = () => readFileSync(join(process.cwd(), "assets", "app.css"), "utf8");

test("auto-approve flags exist only where verified against the Sandbox image", () => {
  assert.deepEqual(autoApproveArgsFor("claude"), ["--dangerously-skip-permissions"]);
  assert.deepEqual(autoApproveArgsFor("codex"), ["--dangerously-bypass-approvals-and-sandbox"]);
  assert.deepEqual(autoApproveArgsFor("antigravity"), ["--dangerously-skip-permissions"]);
  assert.deepEqual(autoApproveArgsFor("grok"), ["--always-approve"]);
  assert.deepEqual(autoApproveArgsFor("cursor"), ["--force"]);
  assert.equal(supportsAutoApprove("cursor"), true);
  assert.equal(supportsAutoApprove("claude"), true);
  // An unknown tool never gets a guessed flag.
  assert.equal(supportsAutoApprove("nope"), false);
  assert.deepEqual(autoApproveArgsFor("nope"), []);
});

test("composeRoomCommand applies flags only when asked and never fights the user", () => {
  assert.deepEqual(
    composeRoomCommand({ agentId: "claude", roomCommand: ["claude"], autoApprove: true }),
    ["claude", "--dangerously-skip-permissions"],
  );
  // Phase 9-1c: unauthenticated codex uses device auth only — never auto-approve flags.
  assert.deepEqual(
    composeRoomCommand({
      agentId: "codex",
      roomCommand: ["codex"],
      autoApprove: true,
      agentArgs: ["--resume"],
      forceDeviceAuthLogin: true,
    }),
    ["codex", "login", "--device-auth"],
  );
  assert.deepEqual(
    composeRoomCommand({
      agentId: "codex",
      roomCommand: ["codex"],
      autoApprove: true,
      forceDeviceAuthLogin: false,
    }),
    ["codex", "--dangerously-bypass-approvals-and-sandbox"],
  );
  assert.deepEqual(
    composeRoomCommand({ agentId: "claude", roomCommand: ["claude"], autoApprove: false }),
    ["claude"],
  );
  assert.deepEqual(
    composeRoomCommand({ agentId: "cursor", roomCommand: ["cursor-agent"], autoApprove: true }),
    ["cursor-agent", "--force"],
  );
  // A tool with no verified flag gets nothing injected, even when asked.
  assert.deepEqual(
    composeRoomCommand({ agentId: "nope", roomCommand: ["nope"], autoApprove: true }),
    ["nope"],
  );
  // User args are preserved and come last.
  assert.deepEqual(
    composeRoomCommand({ agentId: "claude", roomCommand: ["claude"], autoApprove: true, agentArgs: ["--resume"] }),
    ["claude", "--dangerously-skip-permissions", "--resume"],
  );
  // An explicit user permission choice wins — no duplicate/conflicting flag.
  assert.deepEqual(
    composeRoomCommand({ agentId: "claude", roomCommand: ["claude"], autoApprove: true, agentArgs: ["--permission-mode", "plan"] }),
    ["claude", "--permission-mode", "plan"],
  );
  assert.deepEqual(
    composeRoomCommand({ agentId: "claude", roomCommand: ["claude"], autoApprove: true, agentArgs: ["--dangerously-skip-permissions"] }),
    ["claude", "--dangerously-skip-permissions"],
  );
});

test("autoApprove is opt-in in the schema and on for folder-created Projects", () => {
  const parsed = ContextSchema.parse({});
  assert.equal(parsed.autoApprove, false);
  const config = { contexts: {}, authProfiles: ["default"] };
  const created = applyCreatedProject(config, { name: "acme", workspace: "/tmp/acme" });
  assert.equal(created.autoApprove, true);
});

test("a Project created from the CLI can actually run: image + network are not dead ends", () => {
  const config = { contexts: {}, authProfiles: ["default"] };
  const created = applyCreatedProject(config, { name: "acme", workspace: "/tmp/acme" });
  // An AI CLI with no network cannot reach its own API — same default as the
  // app's "Standard development" template, stated plainly on Overview.
  assert.equal(created.room.egress, "open");
  // Starts on whatever image is usable: the recommended one when the user has
  // already built it, the safe base otherwise. Never downloads or builds.
  assert.ok([RECOMMENDED_ROOM_IMAGE, SAFE_BASE_ROOM_IMAGE].includes(created.room.image));
  assert.equal(created.room.image, initialRoomImage());
});

test("Overview leads with the boundary sentence, permission ledger, and Prove it", () => {
  const appJs = js();
  assert.match(appJs, /function boundarySentence\(/);
  assert.match(appJs, /Nothing else on this Mac exists inside the room/);
  assert.match(appJs, /function renderPermissionLedger\(/);
  assert.match(appJs, /permission-ledger/);
  // The two-column host/room drawing cannot return by accident.
  assert.doesNotMatch(appJs, /function renderBoundaryDiagram\b/);
  assert.doesNotMatch(appJs, /function absentHostPaths\b/);
  assert.doesNotMatch(appJs, /boundary-diagram/);
  assert.doesNotMatch(css(), /\.boundary-diagram\{/);
  assert.doesNotMatch(appJs, /sandbox-control-grid/);
  assert.doesNotMatch(appJs, /boundary-status/);
  assert.match(appJs, /function runProveIt\(/);
  assert.match(appJs, /run-prove-it/);
  assert.match(appJs, /\/api\/room\/ai-proof/);
  assert.match(appJs, /Test the walls/);
  // The honest-limits entry point lives here too.
  assert.match(appJs, /open-limits/);
  assert.match(css(), /\.permission-ledger/);
  assert.match(css(), /\.trace\{/);
  assert.match(css(), /\.chk-head\{/);
  assert.match(appJs, /function proveItRows\(/);
  assert.match(appJs, /PROOF_ENFORCER_LABEL/);
  assert.match(appJs, /observed === "blocked"/);
});

test("Overview ledger rows navigate to every editable section", () => {
  const appJs = js();
  // Each axis carries a working openProjectPage route in the Overview ledger.
  for (const section of ["folders", "network", "ai", "git", "connections"]) {
    assert.match(
      appJs,
      new RegExp(`section:\\s*"${section}"`),
      `Overview ledger must include openProjectPage section "${section}"`,
    );
  }
  assert.doesNotMatch(appJs, /class="secondary ledger-goto"/);
  assert.match(appJs, /class="ledger-row"/);
  assert.match(appJs, /data-section="\$\{esc\(section\)\}"/);
  assert.match(appJs, /openProjectPage\(selectedProject, button\.dataset\.section/);
  // Enforcement chips (Isolated / Broker / Not enforced yet) stay out of the glance ledger.
  assert.doesNotMatch(
    appJs,
    /source === "vm" \? "Isolated"/,
    "Overview ledger must not paint Isolated/Broker level chips",
  );
  // Shared / not-shared structure + short honesty facts.
  assert.match(appJs, /ledger-allowed/);
  assert.match(appJs, /ledger-denied/);
  assert.match(appJs, /No other folder exists inside the room/);
  assert.match(appJs, /GitHub rejects pushes/);
  assert.match(appJs, /No authenticated remote access/);
});

test("renderer never hardcodes probe targets — idle plan is server-owned", () => {
  const appJs = js();
  // Same defect class as the deleted ~/.ssh diagram entries: a hand-copied
  // probe list in the UI starts lying the moment aiproof.ts changes.
  for (const literal of ["/workspace/.bumper-proof", "1.1.1.1", "/root/.ssh", "/Users", ".bumper/proof/canary"]) {
    assert.equal(appJs.includes(literal), false, `assets/app.js must not contain probe target literal ${literal}`);
  }
  assert.doesNotMatch(appJs, /function idleProofProbes\s*\(/);
  assert.match(appJs, /\/api\/room\/ai-proof\/plan/);
  assert.match(appJs, /function plannedProofProbes\s*\(/);
  // Completed "absent" checks must not borrow the not-run idle layer class.
  assert.match(appJs, /enforcer === "absent"\) return "vm"/);
  // Live verification must name the target and a plain outcome at a glance —
  // not only "stopped here" on an abstract rail.
  assert.match(appJs, /function proveGlance\s*\(/);
  assert.match(appJs, /function proofTargetOf\s*\(/);
  assert.match(appJs, /function proofResultComplete\s*\(/);
  assert.match(appJs, /can't reach/);
  assert.doesNotMatch(appJs, /stopped here/);
  // Incomplete title-only results must not paint as verified; results are session-only.
  assert.match(appJs, /removeItem\("bumper\.boundaryProofs\.v2"\)/);
  assert.doesNotMatch(appJs, /function rememberProof/);
  assert.match(appJs, /no target recorded/);
  assert.match(appJs, /Tried/);
  // Probe stdout (OUTCOME=) stays primary; identical container boot progress is secondary.
  assert.match(appJs, /function splitProbeOutput\s*\(/);
  assert.match(appJs, /Sandbox boot log/);
});

test("auto-approve is offered as a Project control", () => {
  const appJs = js();
  // Overview shows the boundary, not tool settings: the approval toggle lives on
  // AI tools only (owner feedback 2026-07-26). Two copies also drifted apart.
  assert.doesNotMatch(appJs, /overview-auto-approve/);
  assert.match(appJs, /ai-auto-approve/);
  assert.match(appJs, /function inRoomCommandPreview\(/);
  assert.match(appJs, /function autoApproveSupported\(/);
  assert.match(appJs, /project\.ai\.skip_approval/);
  assert.match(
    readFileSync(join(process.cwd(), "assets", "locales", "en.json"), "utf8"),
    /"project\.ai\.skip_approval": "Skip approval prompts"/,
  );
});

test("limits live in one place instead of per-page not-enforced badges", () => {
  const appHtml = html();
  const appJs = js();
  assert.match(appHtml, /id="limits-dialog"/);
  assert.match(appHtml, /data-i18n="ui.limits"|<h2[^>]*>Limits<\/h2>/);
  assert.match(appJs, /function limitsForProject\(/);
  assert.match(appJs, /function openLimitsDialog\(/);
  // Honest content survives the relocation.
  assert.match(appJs, /SSH git bypasses the credential broker/);
  assert.match(appJs, /Bumper contains, it does not correct/);
  assert.doesNotMatch(appJs, /A per-host allowlist is not offered/);
  // Project-specific gaps still come from the assurance model.
  assert.match(appJs, /source === "not-enforced"/);
  // A working control is no longer badged as unfinished.
  assert.match(appJs, /Unfiltered by choice/);
  assert.doesNotMatch(appJs, /assurance mixed"><i data-lucide="triangle-alert"><\/i>Not enforced yet/);
});

test("AI tools page is fact-only (CLI owns account; no Library bind actions)", () => {
  const appJs = js();
  // Phase 9-3: fact rows · terminal login; no Sign in / Change / Library CTA here.
  assert.match(appJs, /project\.ai\.desc_terminal/);
  assert.match(appJs, /ai-fact-row/);
  assert.match(appJs, /account_unbound|account_existing/);
  assert.doesNotMatch(appJs, /remove-ai-bind/);
  assert.doesNotMatch(appJs, /No AI login bound yet/);
  assert.doesNotMatch(appJs, /more-tools/);
});

test("create wizard template cards keep the radio from stretching", () => {
  assert.match(css(), /\.template-card input\[type=radio\]\{flex:none/);
});

test("create, folder, and network editors use factual previews — not a diagram", () => {
  const appHtml = html();
  const appJs = js();
  assert.match(appHtml, /id="create-boundary-preview"/);
  assert.match(appHtml, /Live preview/);
  assert.match(appJs, /function renderCreateBoundarySummary/);
  // Folders: the board itself is the SSOT (no separate boundary-preview / matrix).
  assert.match(appJs, /function renderFoldersTable/);
  assert.match(appJs, /folders-board/);
  assert.match(appJs, /Everything else in the project/);
  assert.doesNotMatch(appJs, /id="folders-boundary-preview"/);
  assert.doesNotMatch(appJs, /function updateFolderDraftPreview/);
  // Network: one-line fact + assurance badge (no leftover boundary-preview box).
  assert.doesNotMatch(appJs, /id="network-boundary-preview"/);
  assert.match(appJs, /id="network-note"/);
  assert.match(appJs, /networkModeNote\(/);
  assert.match(appJs, /networkAssuranceBadge\(/);
  assert.match(appJs, /No internet/);
  assert.match(appJs, /Full internet/);
  assert.doesNotMatch(appJs, /renderBoundaryDiagram/);
  assert.doesNotMatch(appJs, /absentHostPaths/);
});

test("first setup proves a disposable sandbox before asking for a Project", () => {
  const appJs = js();
  assert.match(appJs, /function sandboxDemoHtml/);
  assert.match(appJs, /function runSandboxDemo/);
  assert.match(appJs, /\/api\/room\/breakout/);
  assert.match(appJs, /20-second live demo/);
  assert.match(appJs, /never one of yours/);
  assert.match(appJs, /Use my folder/);
  assert.match(css(), /\.live-demo-card/);
});

test("Overview ledger reuses project.assurance layers and stacks verification", () => {
  const appJs = js();
  assert.match(appJs, /function projectBoundaryFingerprint/);
  assert.match(appJs, /function currentProof/);
  assert.match(appJs, /function assuranceById/);
  assert.doesNotMatch(appJs, /function assuranceLevelClass/);
  assert.match(appJs, /function renderPermissionLedger/);
  // Primary axes map to real assurance ids — not a parallel classification.
  assert.match(appJs, /"workspace-door"/);
  assert.match(appJs, /"egress"/);
  assert.match(appJs, /"git-credentials"/);
  assert.match(appJs, /"mcp-hub"/);
  assert.match(appJs, /"sealed-room"/);
  // Prove-it remains the verification surface; side-by-side grids are gone.
  assert.match(appJs, /sandbox-actions-stack/);
  assert.doesNotMatch(appJs, /function renderBoundaryStatus/);
  assert.doesNotMatch(css(), /\.boundary-status/);
  assert.doesNotMatch(css(), /\.sandbox-control-grid/);
});

test("copied terminal command is explicit and shell-quotes Project names", () => {
  const appJs = js();
  // The run command lives on AI tools next to the tool it launches, not on Overview.
  assert.match(appJs, /function aiLaunchCommand\(/);
  assert.match(appJs, /bumper -p \$\{quoted\} \$\{alias\}/);
  // Project names with spaces must stay quoted wherever the command is produced.
  assert.match(appJs, /\/\[\\s"'\]\/\.test\(name\)/);
  assert.match(appJs, /class="command-chip"/, "and it must look copyable");
});

test("Folders UI is a single board: list + Everything else, no templates", () => {
  const appJs = js();
  // SSOT board — no mode toggle, no templates, no duplicate status/matrix.
  assert.doesNotMatch(appJs, /id="folders-share"/);
  assert.doesNotMatch(appJs, /id="folders-whole-access"/);
  assert.doesNotMatch(appJs, /How much to share/);
  assert.doesNotMatch(appJs, /folders-expert/);
  assert.doesNotMatch(appJs, /folders-template/);
  assert.doesNotMatch(appJs, /id="folders-preview"/);
  assert.doesNotMatch(appJs, /folders-matrix-details/);
  assert.match(appJs, /function renderFoldersTable/);
  assert.match(appJs, /function restOfProjectMode/);
  assert.match(appJs, /function setRestOfProject/);
  assert.match(appJs, /Everything else in the project/);
  assert.match(appJs, /Not shared/);
  assert.match(appJs, /Can edit/);
  assert.match(appJs, /Look only/);
  assert.match(appJs, /Add folder/);
  assert.match(appJs, /id="folders-apply"/);
  assert.match(appJs, /id="folders-pick-share"/);
  assert.match(appJs, /function accessPills/);
  // Apply is only active when the draft differs from the saved project.
  assert.match(appJs, /function isFolderDraftDirty/);
  assert.match(appJs, /function folderDraftFingerprint/);
  assert.match(appJs, /No unsaved changes/);
  assert.match(appJs, /Unsaved changes/);
  assert.doesNotMatch(appJs, /Add mount/);
  assert.doesNotMatch(appJs, /What this means/);
  assert.match(css(), /\.folders-table/);
  assert.match(css(), /\.access-pills/);
  assert.match(css(), /\.folders-board/);
});

test("autoApprove round-trips through the API and survives partial saves", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bumper-autoapprove-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const configPath = join(root, "config.json");
  const statePath = join(root, "state.json");
  writeFileSync(configPath, JSON.stringify({
    webPort: 0, defaultContext: "Safe", backends: {},
    contexts: { Safe: { description: "test", mode: "read-write", workspace, backends: [], writePaths: [], readPaths: [], repos: [], allowedHosts: [] } },
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

  const readState = async () => (await (await fetch(`${handle.url}/api/state`)).json());
  assert.equal((await readState()).contexts.Safe.autoApprove, false);

  const save = (body) => fetch(`${handle.url}/api/contexts`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const base = { previous: "Safe", name: "Safe", workspace, mode: "read-write" };
  assert.equal((await save({ ...base, autoApprove: true })).status, 200);
  assert.equal((await readState()).contexts.Safe.autoApprove, true);

  // A save from another page (no autoApprove field) must not silently reset it.
  assert.equal((await save({ ...base })).status, 200);
  assert.equal((await readState()).contexts.Safe.autoApprove, true);

  assert.equal((await save({ ...base, autoApprove: false })).status, 200);
  assert.equal((await readState()).contexts.Safe.autoApprove, false);
});
