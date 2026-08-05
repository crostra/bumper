/**
 * Phase 1: resolveProject + Access roots for cwd matching.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyCreatedProject,
  matchProjectsByCwd,
  normalizeHostPath,
  pathCovers,
  projectAccessRoots,
  resolveProject,
} from "../dist/project.js";

function blankContext(overrides = {}) {
  return {
    description: "",
    backends: [],
    mode: "read-write",
    inheritMode: true,
    policies: {},
    native: { allow: [], deny: [] },
    commands: {},
    writePaths: [],
    readPaths: [],
    denyReadPaths: [],
    denyWritePaths: [],
    gitIgnored: "visible",
    repos: [],
    allowedHosts: [],
    room: {
      enabled: true,
      image: "docker.io/library/alpine:3.20",
      egress: "blocked",
      egressTemplates: [],
      egressHosts: [],
      doors: [],
      workspaceShare: "whole",
      shareSubpaths: [],
    },
    ...overrides,
  };
}

function makeConfig(contexts) {
  return {
    webPort: 0,
    backends: {},
    globalPolicy: {
      mode: "read-write",
      native: { allow: [], deny: [] },
      commands: {
        gitRead: "allow", gitLocalWrite: "allow", gitRemoteRead: "allow",
        gitRemoteWrite: "block", shellRead: "allow", shellWrite: "allow", unknown: "block",
      },
      readPaths: [], writePaths: [], denyReadPaths: [], denyWritePaths: [],
    },
    contexts,
    defaultContext: Object.keys(contexts)[0],
  };
}

test("projectAccessRoots includes workspace, read/write paths, and room doors", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-access-"));
  try {
    const ws = join(root, "ws");
    const extra = join(root, "extra");
    const door = join(root, "door");
    mkdirSync(ws); mkdirSync(extra); mkdirSync(door);
    const ctx = blankContext({
      workspace: ws,
      readPaths: [extra],
      writePaths: [],
      room: {
        ...blankContext().room,
        doors: [{ hostPath: door, roomPath: "/shared/door", access: "read-only" }],
      },
    });
    const roots = projectAccessRoots(ctx);
    assert.equal(roots.length, 3);
    assert.ok(roots.some((r) => r.role === "workspace" && pathCovers(r.path, ws)));
    assert.ok(roots.some((r) => r.role === "read"));
    assert.ok(roots.some((r) => r.role === "door"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matchProjectsByCwd: unique Access match; nested cwd under workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-cwd-"));
  try {
    const a = join(root, "alpha");
    const b = join(root, "beta");
    const nested = join(a, "src");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    mkdirSync(nested, { recursive: true });
    const config = makeConfig({
      Alpha: blankContext({ workspace: a }),
      Beta: blankContext({ workspace: b }),
    });
    assert.deepEqual(matchProjectsByCwd(config, a), ["Alpha"]);
    assert.deepEqual(matchProjectsByCwd(config, nested), ["Alpha"]);
    assert.deepEqual(matchProjectsByCwd(config, b), ["Beta"]);
    assert.deepEqual(matchProjectsByCwd(config, root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matchProjectsByCwd: extra Access dir (readPaths) matches", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-extra-"));
  try {
    const ws = join(root, "ws");
    const shared = join(root, "shared-lib");
    mkdirSync(ws); mkdirSync(shared);
    const config = makeConfig({
      WithExtra: blankContext({ workspace: ws, readPaths: [shared] }),
    });
    assert.deepEqual(matchProjectsByCwd(config, shared), ["WithExtra"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProject: -p / flag wins over cwd", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-flag-"));
  try {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a); mkdirSync(b);
    const config = makeConfig({
      Alpha: blankContext({ workspace: a }),
      Beta: blankContext({ workspace: b }),
    });
    const result = await resolveProject({
      config,
      cwd: a,
      flag: "Beta",
      interactive: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, "Beta");
    assert.equal(result.source, "flag");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProject: unknown flag is hard error", async () => {
  const config = makeConfig({ Only: blankContext({ workspace: "/tmp" }) });
  const result = await resolveProject({
    config,
    cwd: "/tmp",
    flag: "Missing",
    interactive: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown-flag");
  assert.match(result.message, /Unknown project "Missing"/);
  assert.match(result.message, /-p/);
});

test("resolveProject: unique cwd auto-selects", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-unique-"));
  try {
    const a = join(root, "only");
    mkdirSync(a);
    const config = makeConfig({
      Solo: blankContext({ workspace: a }),
      Other: blankContext({ workspace: join(root, "other-missing") }),
    });
    const result = await resolveProject({
      config,
      cwd: a,
      interactive: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, "Solo");
    assert.equal(result.source, "cwd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProject: zero matches non-interactive hard error (never silent create)", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-none-"));
  try {
    const a = join(root, "proj");
    const stray = join(root, "stray");
    mkdirSync(a); mkdirSync(stray);
    const config = makeConfig({
      Proj: blankContext({ workspace: a }),
    });
    const result = await resolveProject({
      config,
      cwd: stray,
      interactive: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "none");
    assert.match(result.message, /never creates a project silently/i);
    assert.match(result.message, /bumper access set/i);
    assert.match(result.message, /-p/);
    assert.equal(Object.keys(config.contexts).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProject: many matches non-interactive hard error", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-many-"));
  try {
    const shared = join(root, "shared");
    mkdirSync(shared);
    const config = makeConfig({
      One: blankContext({ workspace: shared }),
      Two: blankContext({ readPaths: [shared] }),
    });
    const result = await resolveProject({
      config,
      cwd: shared,
      interactive: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "ambiguous");
    assert.deepEqual(result.matches.sort(), ["One", "Two"]);
    assert.match(result.message, /Multiple projects/);
    assert.match(result.message, /-p/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProject: interactive select among matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-isel-"));
  try {
    const shared = join(root, "shared");
    mkdirSync(shared);
    const config = makeConfig({
      One: blankContext({ workspace: shared }),
      Two: blankContext({ workspace: shared }),
    });
    const result = await resolveProject({
      config,
      cwd: shared,
      interactive: true,
      ask: async (req) => {
        assert.equal(req.type, "select");
        assert.ok(req.choices.includes("One"));
        return { action: "select", name: "Two" };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, "Two");
    assert.equal(result.source, "interactive-select");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProject: interactive create only when user chooses create", async () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-icreate-"));
  try {
    const stray = join(root, "fresh");
    mkdirSync(stray);
    const config = makeConfig({
      Existing: blankContext({ workspace: join(root, "elsewhere") }),
    });
    let created = null;
    const result = await resolveProject({
      config,
      cwd: stray,
      interactive: true,
      ask: async (req) => {
        if (req.type === "select") return { action: "create", name: "FreshApp" };
        return { action: "cancel" };
      },
      createProject: async (input) => {
        created = input;
        applyCreatedProject(config, input);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.name, "FreshApp");
    assert.equal(result.source, "interactive-create");
    assert.equal(result.created, true);
    assert.ok(created);
    assert.equal(normalizeHostPath(created.workspace), normalizeHostPath(stray));
    assert.ok(config.contexts.FreshApp);
    assert.equal(
      normalizeHostPath(config.contexts.FreshApp.workspace),
      normalizeHostPath(stray),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveProject: interactive cancel does not create", async () => {
  const config = makeConfig({
    Only: blankContext({ workspace: "/var/empty-unlikely" }),
  });
  const before = Object.keys(config.contexts);
  const result = await resolveProject({
    config,
    cwd: tmpdir(),
    interactive: true,
    ask: async () => ({ action: "cancel" }),
    createProject: () => {
      throw new Error("must not create on cancel");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cancelled");
  assert.deepEqual(Object.keys(config.contexts), before);
});

test("pathCovers: exact and descendant; rejects sibling", () => {
  const root = mkdtempSync(join(tmpdir(), "bumper-cover-"));
  try {
    const base = join(root, "base");
    const child = join(base, "child");
    const sib = join(root, "sib");
    mkdirSync(child, { recursive: true });
    mkdirSync(sib);
    assert.equal(pathCovers(base, base), true);
    assert.equal(pathCovers(base, child), true);
    assert.equal(pathCovers(base, sib), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
