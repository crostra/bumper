/**
 * What this repository must not contain.
 *
 * Everything Bumper ships is here, so a mistake here is a published mistake. A
 * personal path, a real mailbox, a credential-shaped value, or a build artifact
 * reaches every clone the moment it is pushed, and deleting it afterwards does
 * not remove it from anyone's copy. A contributor — or a reviewer confident the
 * work is clean — is exactly who stops checking.
 *
 * Everything below is checked against `git ls-files`, so it describes precisely
 * what a push would publish.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** This file necessarily contains the shapes it forbids. */
const SELF = "test/repository-hygiene.test.mjs";

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((path) => path !== SELF);
}

function isText(path) {
  if (/\.(png|jpg|jpeg|gif|ico|icns|woff2?|ttf|zip|gz|node)$/i.test(path)) return false;
  try {
    return statSync(path).size < 2_000_000;
  } catch {
    return false;
  }
}

function textFiles() {
  return trackedFiles().filter(isText);
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

test("no personal mailbox is published in file contents", () => {
  // The history carries a GitHub noreply address, which is deliberate and
  // reveals nothing. A personal mailbox inside a file is a different thing,
  // and it cannot be taken back.
  const re = /[A-Za-z0-9._%+-]+@(gmail|icloud|outlook|yahoo|hotmail)\.[a-z.]+/i;
  const hits = [];
  for (const path of textFiles()) {
    read(path).split("\n").forEach((line, index) => {
      if (re.test(line)) hits.push(`${path}:${index + 1} ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, [], `personal mailbox in published files:\n${hits.join("\n")}`);
});

test("home paths are placeholders, never a real account", () => {
  // `/Users/<name>` in an example or a test names the machine it was written
  // on. Placeholders say the same thing without doing that.
  const ALLOWED = ["me", "my", "example", "you", "user", "someone"];
  const hits = [];
  for (const path of textFiles()) {
    read(path).split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/\/Users\/([A-Za-z0-9._-]+)/g)) {
        if (ALLOWED.includes(match[1])) continue;
        hits.push(`${path}:${index + 1} /Users/${match[1]}`);
      }
    });
  }
  assert.deepEqual(
    hits,
    [],
    `real home paths found — use one of ${ALLOWED.map((a) => `/Users/${a}`).join(", ")}:\n${hits.join("\n")}`,
  );
});

test("no credential material outside obvious placeholders", () => {
  // Real leaks look like the placeholders, so the check is on shape and the
  // exemption is on a placeholder marker being present in the same line.
  const PLACEHOLDER = /(example|sample|placeholder|your|here|marker|truncated|fake|dummy|test|redact|xxx|\.\.\.)/i;
  const SHAPES = [
    { name: "private-key", re: /-----BEGIN (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY-----/ },
    { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{16,}/ },
    { name: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
    { name: "openai-key", re: /\bsk-[A-Za-z0-9]{32,}/ },
    { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
    { name: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}/ },
  ];
  const hits = [];
  for (const path of textFiles()) {
    read(path).split("\n").forEach((line, index) => {
      for (const { name, re } of SHAPES) {
        if (!re.test(line) || PLACEHOLDER.test(line)) continue;
        hits.push(`${path}:${index + 1} [${name}] ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `credential-shaped values without a placeholder marker:\n${hits.join("\n")}`);
});

test("build outputs and local state are not tracked", () => {
  const FORBIDDEN = [
    /(^|\/)release\//,
    /(^|\/)dist\//,
    /(^|\/)node_modules\//,
    /(^|\/)\.env($|\.)/,
    /(^|\/)\.DS_Store$/,
    /^bumper\.config\.json$/, // a real local config at the root; examples/ holds the samples
    /(^|\/)\.bumper\//,
  ];
  const leaked = trackedFiles().filter((path) => FORBIDDEN.some((re) => re.test(path)));
  assert.deepEqual(leaked, [], `build output or local state tracked:\n${leaked.join("\n")}`);
});

test("documents do not link to files this repository does not contain", () => {
  // A link that resolves to nothing tells a reader an explanation exists and
  // they do not have it — worse than not mentioning it.
  const tracked = new Set(trackedFiles());
  const hits = [];
  for (const path of textFiles().filter((p) => p.endsWith(".md"))) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    for (const match of read(path).matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
      const link = match[1];
      if (/^https?:/.test(link)) continue;
      const target = join(dir, link).replace(/^\.\//, "");
      if (!tracked.has(target)) hits.push(`${path} → ${link}`);
    }
  }
  assert.deepEqual(hits, [], `links to files not present here:\n${hits.join("\n")}`);
});
