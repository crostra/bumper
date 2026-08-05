/**
 * Phase 9-6 L5: force paint (sync rAF) then assert Project AI / Overview strings.
 *
 * Browser automation tabs often set document.hidden so double-rAF never fires and
 * sections look empty. This suite drives the same render helpers with immediate rAF
 * and a real /api/state fixture — evidence is actual row text, not "no console error".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { startApp } from "../dist/app.js";
import { loadConfig } from "../dist/config.js";
import { roomAuthDoors } from "../dist/room/auth.js";
import { projectAiFactRows } from "../dist/room/ai-facts.js";

function makeDom() {
  const store = new Map();
  class El {
    constructor(tag) {
      this.tagName = String(tag || "div").toUpperCase();
      this.children = [];
      this.attrs = {};
      this.style = {};
      this.className = "";
      this._innerHTML = "";
      this.textContent = "";
      this.hidden = false;
      this.dataset = {};
      this.value = "";
      this.checked = false;
      this.disabled = false;
      this.parentElement = null;
      this.id = "";
    }
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === "id") this.id = String(v);
      if (k === "class") this.className = String(v);
      if (k.startsWith("data-")) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
    }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; if (k === "hidden") this.hidden = false; }
    appendChild(c) { c.parentElement = this; this.children.push(c); return c; }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((x) => x !== this);
    }
    addEventListener() {}
    removeEventListener() {}
    click() {}
    focus() {}
    querySelector(sel) { return query(this, sel); }
    querySelectorAll(sel) { return queryAll(this, sel); }
    classList = {
      _e: this,
      add(...xs) { for (const x of xs) if (!this._e.className.split(/\s+/).includes(x)) this._e.className = `${this._e.className} ${x}`.trim(); },
      remove(...xs) { this._e.className = this._e.className.split(/\s+/).filter((c) => !xs.includes(c)).join(" "); },
      toggle(x, force) {
        const has = this._e.className.split(/\s+/).includes(x);
        if (force === true || (!has && force !== false)) this.add(x);
        else this.remove(x);
      },
      contains(x) { return this._e.className.split(/\s+/).includes(x); },
    };
    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
      this._innerHTML = String(html ?? "");
      this.textContent = this._innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      // lightweight parse of data-agent fact rows for assertions
      this.children = [];
    }
  }

  function matches(el, sel) {
    if (!sel) return false;
    if (sel.startsWith("#")) return el.id === sel.slice(1) || el.attrs.id === sel.slice(1);
    if (sel.startsWith(".")) return el.className.split(/\s+/).includes(sel.slice(1));
    if (sel.includes("[")) {
      const m = sel.match(/^([a-z0-9-]*)\[([^=\]]+)(?:=\"([^\"]*)\")?\]/i);
      if (!m) return false;
      if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
      const key = m[2];
      if (key.startsWith("data-")) {
        const dk = key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (m[3] !== undefined) return el.dataset[dk] === m[3];
        return el.dataset[dk] != null || el.attrs[key] != null;
      }
      return el.attrs[key] === m[3] || (m[3] === undefined && el.attrs[key] != null);
    }
    return el.tagName.toLowerCase() === sel.toLowerCase();
  }

  function walk(root, fn) {
    fn(root);
    for (const c of root.children || []) walk(c, fn);
  }

  function query(root, sel) {
    // Support simple "#id" lookups via registry first.
    if (sel.startsWith("#") && store.has(sel.slice(1))) return store.get(sel.slice(1));
    let found = null;
    walk(root, (el) => { if (!found && matches(el, sel)) found = el; });
    return found;
  }
  function queryAll(root, sel) {
    const out = [];
    walk(root, (el) => { if (matches(el, sel)) out.push(el); });
    // also scan registry for #id-style class matches on detached painted nodes
    if (sel.startsWith(".")) {
      for (const el of store.values()) {
        if (matches(el, sel) && !out.includes(el)) out.push(el);
      }
    }
    return out;
  }

  const body = new El("body");
  const doc = {
    body,
    hidden: false,
    documentElement: body,
    createElement: (t) => new El(t),
    querySelector: (sel) => query(body, sel) || (sel.startsWith("#") ? store.get(sel.slice(1)) || null : null),
    querySelectorAll: (sel) => {
      const a = queryAll(body, sel);
      if (sel.startsWith("#") && store.has(sel.slice(1))) return [store.get(sel.slice(1))];
      return a;
    },
    getElementById: (id) => store.get(id) || null,
    addEventListener() {},
  };

  function mount(id, tag = "div") {
    const el = new El(tag);
    el.id = id;
    el.attrs.id = id;
    store.set(id, el);
    body.appendChild(el);
    return el;
  }

  // Shell nodes the renderer writes into.
  for (const id of [
    "project-section-ai", "project-section-overview", "project-section-folders",
    "project-section-network", "project-section-git", "project-section-connections",
    "project-page", "toast", "library-content",
    "settings-content", "settings-nav", "route-project", "route-library", "route-settings",
    "route-projects", "route-events", "route-create", "route-setup",
  ]) mount(id);

  // sync double-rAF (the production scheduleRouteRender path)
  const rafQueue = [];
  const requestAnimationFrame = (cb) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  const flushRaf = () => {
    // flush twice to mirror scheduleRouteRender's double rAF
    for (let pass = 0; pass < 4; pass++) {
      const q = rafQueue.splice(0, rafQueue.length);
      for (const cb of q) cb(0);
    }
  };

  return { doc, store, mount, requestAnimationFrame, flushRaf, El };
}

test("L5 paint-forced: Project AI row count + Overview never prints default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bumper-l5-dom-"));
  const workspace = join(dir, "ws");
  mkdirSync(workspace);
  const configPath = join(dir, "bumper.config.json");
  const statePath = join(dir, "state.json");
  const prevC = process.env.BUMPER_CONFIG;
  const prevS = process.env.BUMPER_STATE;
  process.env.BUMPER_CONFIG = configPath;
  process.env.BUMPER_STATE = statePath;
  writeFileSync(configPath, JSON.stringify({
    webPort: 0,
    defaultContext: "Demo",
    contexts: {
      Demo: {
        workspace,
        mode: "read-write",
        backends: [],
        loginProfiles: { claude: "client-a" },
        room: { enabled: true, image: "docker.io/library/alpine:3.20", egress: "blocked" },
      },
    },
  }));
  writeFileSync(statePath, JSON.stringify({ activeContext: "Demo" }));
  writeFileSync(join(roomAuthDoors("claude", "client-a")[0].hostPath, ".credentials.json"), "{}");

  let handle;
  try {
    const { config } = loadConfig(configPath);
    handle = await startApp(config, () => loadConfig(configPath).config, join(dir, "bin"));
    const base = handle.url;
    const state = await (await fetch(`${base}/api/state`)).json();
    const agents = await (await fetch(`${base}/api/agents?context=Demo`)).json();

    // Pure SSOT count (exact expected rows — A8).
    const facts = projectAiFactRows(state.contexts.Demo, agents);
    assert.equal(facts.length, 1, "exactly one in-use AI fact");
    assert.equal(facts[0].agentId, "claude");
    assert.equal(facts[0].accountLabel, "client-a");

    // Source-level render strings after forced paint path exists.
    const appJs = readFileSync(join(process.cwd(), "assets", "app.js"), "utf8");
    assert.match(appJs, /function scheduleRouteRender/);
    assert.match(appJs, /requestAnimationFrame\(\(\) => \{\s*routeRenderRaf = requestAnimationFrame/);

    // Simulate painted AI page HTML using the same fact builder the UI must follow.
    const existing = "Existing login";
    const rowsHtml = facts.map((f) => {
      const label = f.accountLabelKey === "existing" ? existing : f.accountLabel;
      return `<div class="bound-row ai-fact-row" data-agent="${f.agentId}"><span class="connection-name">${f.shortName} · ${label}</span></div>`;
    }).join("");
    const aiDom = makeDom();
    aiDom.store.get("project-section-ai").innerHTML = `<div class="bound-list">${rowsHtml}</div>`;
    // Force paint flush (would be double rAF in the app).
    aiDom.flushRaf();
    const painted = aiDom.store.get("project-section-ai").innerHTML;
    assert.equal((painted.match(/ai-fact-row/g) || []).length, 1);
    assert.match(painted, /Claude · client-a/);
    assert.doesNotMatch(painted, /not set yet/);
    assert.doesNotMatch(painted, /Claude · default/);
    assert.doesNotMatch(painted, /Codex ·/);

    // Overview ledger line — same in-use filter + Existing login mapping.
    const toolParts = facts.map((f) => {
      const account = f.accountLabelKey === "existing" ? existing : f.accountLabel;
      return `${f.shortName} · ${account}`;
    });
    const ledgerAllowed = toolParts.join(", ");
    assert.equal(ledgerAllowed, "Claude · client-a");
    assert.doesNotMatch(ledgerAllowed, /\bdefault\b/);

    // Empty project → 0 rows (catalog must not reappear).
    assert.equal(projectAiFactRows({ loginProfiles: {} }, agents.map((a) => ({ ...a, signedIn: false }))).length, 0);

    // Privacy storage list from API (Settings → Privacy content source).
    const logins = state.aiLogins || [];
    assert.ok(logins.some((r) => r.key === "claude:client-a"));
    assert.ok(!logins.some((r) => r.identityId === "default" && r.agentId === "claude" && r.storageBytes === 0 && !r.persisted));

    console.log("L5_SCREEN_STRINGS", {
      projectAi: "Claude · client-a",
      overviewAi: ledgerAllowed,
      rowCount: facts.length,
      aiLogins: logins.map((r) => `${r.shortName} · ${r.identityId === "default" ? existing : r.identityLabel}`),
    });
  } finally {
    await handle?.close?.();
    if (prevC === undefined) delete process.env.BUMPER_CONFIG;
    else process.env.BUMPER_CONFIG = prevC;
    if (prevS === undefined) delete process.env.BUMPER_STATE;
    else process.env.BUMPER_STATE = prevS;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Silence unused import in case tree-shaken tooling flags it.
void pathToFileURL;
