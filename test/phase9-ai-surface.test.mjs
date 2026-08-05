/**
 * Project → AI tools: detection is the teaching surface.
 *
 * Signed-in tools are the main content; the rest collapse into ONE row so five
 * "not signed in" lines never read as "four things are broken"
 * (desire-first-surface §4, and A8: never a catalog-sized list of chores).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectAiFactRows } from "../dist/room/ai-facts.js";

const appJs = () => readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
const body = (name) => {
  const src = appJs();
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name} must exist`);
  const next = src.indexOf("\n  function ", start + 1);
  return src.slice(start, next === -1 ? src.length : next);
};

const CATALOG = [
  { id: "claude", shortName: "Claude", roomCommand: ["claude"] },
  { id: "codex", shortName: "Codex", roomCommand: ["codex"] },
  { id: "cursor", shortName: "Cursor", roomCommand: ["cursor-agent"] },
  { id: "grok", shortName: "Grok", roomCommand: ["grok"] },
  { id: "antigravity", shortName: "Antigravity", roomCommand: ["agy"] },
];

test("not-signed-in tools collapse into one details row, never N rows", () => {
  const src = body("renderProjectAi");
  assert.match(src, /notSignedIn/, "must compute the not-signed-in set");
  // The pending group is one <details>; individual tools live inside it.
  const detailsOpens = src.match(/<details/g) || [];
  assert.ok(detailsOpens.length >= 2, "pending group + host note are collapsed");
  assert.match(src, /project\.ai\.pending_summary/, "one summary line carries the count");
  // Signed-in rows and pending rows must be built from different sets.
  assert.match(src, /inUse\.map\(/);
  assert.match(src, /notSignedIn\.map\(/);
});

test("login guidance states the URL→browser→paste flow (the Sandbox has no browser)", () => {
  const en = JSON.parse(readFileSync(join(process.cwd(), "assets", "locales", "en.json"), "utf8"));
  const ja = JSON.parse(readFileSync(join(process.cwd(), "assets", "locales", "ja.json"), "utf8"));
  for (const key of [
    "project.ai.login_flow", "project.ai.pending_summary", "project.ai.host_summary",
    "project.ai.host_detail", "project.ai.docs", "project.ai.desc_terminal",
  ]) {
    assert.ok(en[key], `en.json missing ${key}`);
    assert.ok(ja[key], `ja.json missing ${key}`);
    assert.notEqual(en[key], ja[key], `${key} not translated`);
  }
  assert.match(en["project.ai.login_flow"], /URL/);
  assert.match(en["project.ai.login_flow"], /paste/i);
  assert.match(en["project.ai.login_flow"], /no browser inside the Sandbox/i);
  // The docs link is the vendor's guide, not Bumper's steps — name the vendor.
  assert.match(en["project.ai.docs"], /\{vendor\}/);
  assert.match(en["project.ai.docs"], /official/i);
});

test("host-installed tools are named as outside the boundary, without a lecture", () => {
  const en = JSON.parse(readFileSync(join(process.cwd(), "assets", "locales", "en.json"), "utf8"));
  const detail = en["project.ai.host_detail"];
  assert.match(detail, /outside Bumper/i, "must say it is outside the boundary");
  assert.match(detail, /bumper <tool>/, "must name the in-boundary path");
  // Honesty gate: state the fact, do not tell the user to uninstall things.
  assert.doesNotMatch(detail, /uninstall/i);
});

test("docs links are only for vendors whose URL was verified", () => {
  const src = appJs();
  const table = src.slice(src.indexOf("const AI_LOGIN_DOCS"), src.indexOf("/** `bumper -p <project>"));
  for (const [id, host] of [
    ["claude", "docs.anthropic.com"],
    ["codex", "developers.openai.com"],
    ["cursor", "cursor.com"],
    ["grok", "docs.x.ai"],
  ]) {
    assert.match(table, new RegExp(`${id}:\\s*"https://${host.replace(".", "\\.")}`), `${id} docs link`);
  }
  // antigravity was not verified — must not be guessed.
  assert.doesNotMatch(table, /antigravity:/);
});

test("account switching offers only accounts that are already signed in", () => {
  const src = body("renderProjectAi");
  assert.match(src, /accountsFor\(agent\.id\)\.filter\(\(l\) => l\.persisted\)/,
    "the picker source must be signed-in accounts only");
  // The command must look copyable, not be a hidden click target.
  assert.match(src, /class="command-chip"/, "commands render as an explicit copy affordance");
  assert.match(src, /options\.length > 1/, "no picker when there is nothing to choose");
  // No create / login affordances on this page.
  assert.doesNotMatch(src, /Sign in|New login|Choose from Library/);
});

test("row selection still matches projectAiFactRows (no catalog expansion)", () => {
  const agents = CATALOG.map((a) => ({ ...a, signedIn: a.id === "claude" || a.id === "grok" }));
  const rows = projectAiFactRows({ loginProfiles: {} }, agents);
  assert.deepEqual(rows.map((r) => r.agentId), ["claude", "grok"]);
  assert.notEqual(rows.length, CATALOG.length);
});

/**
 * Cross-project correctness. Section bodies live in the DOM and outlive the selection,
 * and `agents` is fetched per selected Project — so both were sources of showing
 * Project A the facts of Project B. Wrong is worse than slow: the stamp makes a
 * mismatch render nothing, and per-Project login state is derived from
 * `state.aiLogins` (project-independent) rather than the cached agents list.
 */
test("Project sections are stamped and blanked when the Project changes", () => {
  const src = appJs();
  assert.match(src, /function setProjectSection\(/, "one writer stamps every section body");
  assert.match(src, /function clearProjectSections\(/);
  assert.match(src, /if \(selectedProject !== name\) clearProjectSections\(\);/,
    "changing Project must drop stale bodies");
  const sync = src.slice(src.indexOf("function syncProjectSubnav("), src.indexOf("function renderProjectPage("));
  assert.match(sync, /node\.dataset\.project !== \(selectedProject \|\| ""\)/,
    "a section belonging to another Project must never be shown");
  assert.match(sync, /node\.innerHTML = ""/);
});

test("per-Project login state never comes from the cached agents list", () => {
  const src = appJs();
  assert.match(src, /function toolSignedInForProject\(/);
  // No surface may read agent.signedIn directly: that value belongs to whichever
  // Project was selected when /api/agents was last fetched.
  const withoutComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(withoutComments, /agent\.signedIn/, "use toolSignedInForProject(project, id)");
  assert.doesNotMatch(withoutComments, /\ba\.signedIn\b/);
});
