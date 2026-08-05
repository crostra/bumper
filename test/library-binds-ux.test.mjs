/**
 * Simple Library bind UI — Project picks; Library owns create.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const js = () => readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
const css = () => readFileSync(join(process.cwd(), "assets", "app.css"), "utf8");

test("Project Git uses provider connection while MCP uses Library; AI is CLI fact-only", () => {
  const appJs = js();
  assert.match(appJs, /function openLibraryToBind/);
  assert.match(appJs, /function emptyBindPanel/);
  // Superseded by the shared connection row (connection-model decision).
  assert.match(appJs, /function connectionRow/);
  assert.doesNotMatch(appJs, /function boundResourceRow/);
  // Phase 9-3: AI no longer uses Library chooser on Project page.
  assert.match(appJs, /ai-fact-row/);
  assert.doesNotMatch(appJs, /No AI login bound yet/);
  assert.match(appJs, /No connections bound yet/);
  assert.match(appJs, /Bumper passes the token allowed here|project\.git\.fact/);
  assert.match(appJs, /git-repository|git-access/);
  // No dual MCP select form on Project
  assert.doesNotMatch(appJs, /id="mcp-add-integration"/);
  assert.doesNotMatch(appJs, /id="save-ai"/);
});

test("Library lists support chooser banner, Create first, and Use (Git/MCP)", () => {
  const appJs = js();
  assert.match(appJs, /function libraryChooserBannerHtml/);
  assert.match(appJs, /Choosing for Project/);
  assert.match(appJs, /Create first/);
  // Phase 9-6 F5: AI Library chooser/Use removed — only Git/MCP remain.
  assert.doesNotMatch(appJs, /use-ai-profile/);
  assert.match(appJs, /use-git-connection|useLibraryItemForChooser\("git"/);
  assert.match(appJs, /use-mcp-connection|useLibraryItemForChooser\("mcp"/);
  assert.match(appJs, /function useLibraryItemForChooser/);
  assert.match(css(), /\.empty-bind/);
  assert.match(css(), /\.bound-row/);
  assert.match(css(), /\.library-chooser-banner/);
});
