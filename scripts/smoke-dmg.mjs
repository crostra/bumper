/**
 * DMG / .app smoke test — the release gate's "clean Mac" verification, scripted.
 *
 * Runs the checks a reviewer would run by hand on a freshly-downloaded build:
 * the signature is valid and deep, the app is accepted by Gatekeeper, the DMG
 * mounts and contains the app, and (for signed builds) the notarization ticket
 * is stapled. It prints a pass/fail table and exits non-zero if any hard check
 * fails, so it can gate a release in CI.
 *
 * On an ad-hoc (unsigned) local build the Gatekeeper / notarization checks are
 * expected to fail; the script marks those as "expected on unsigned" and does
 * not fail the run unless BUMPER_SIGN=1 (a real release) was requested.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const appPath = resolve(root, "release", "mac-arm64", "Bumper.app");
const dmgPath = resolve(root, "release", `Bumper-${version}-arm64.dmg`);
const signed = process.env.BUMPER_SIGN === "1";

const results = [];
function check(name, fn, { hard = true, expectedUnsignedFail = false } = {}) {
  let ok = false;
  let detail = "";
  try { const r = fn(); ok = r.ok; detail = r.detail ?? ""; }
  catch (error) { ok = false; detail = error.message; }
  const soft = expectedUnsignedFail && !signed;
  results.push({ name, ok, detail, hard: hard && !soft, soft });
}

function sh(command, args) {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

check("App bundle exists", () => ({ ok: existsSync(appPath), detail: appPath }));

check("codesign --verify --deep --strict", () => {
  const r = sh("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  return { ok: r.status === 0, detail: r.out.split("\n").slice(-1)[0] };
});

check("Gatekeeper spctl assess", () => {
  const r = sh("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
  return { ok: r.status === 0, detail: r.out.split("\n").slice(-1)[0] };
}, { expectedUnsignedFail: true });

check("Notarization ticket stapled", () => {
  const r = sh("/usr/bin/xcrun", ["stapler", "validate", appPath]);
  return { ok: r.status === 0, detail: r.out.split("\n").slice(-1)[0] };
}, { expectedUnsignedFail: true });

check("DMG present and mounts", () => {
  if (!existsSync(dmgPath)) return { ok: false, detail: `not found: ${dmgPath}` };
  const mountPoint = mkdtempSync(resolve(tmpdir(), "bumper-dmg-"));
  try {
    const attach = sh("/usr/bin/hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    if (attach.status !== 0) return { ok: false, detail: attach.out.split("\n").slice(-1)[0] };
    const hasApp = readdirSync(mountPoint).some((entry) => entry.endsWith(".app"));
    sh("/usr/bin/hdiutil", ["detach", mountPoint, "-force"]);
    return { ok: hasApp, detail: hasApp ? "contains .app" : "no .app inside DMG" };
  } finally {
    rmSync(mountPoint, { recursive: true, force: true });
  }
}, { hard: false });

const pad = Math.max(...results.map((r) => r.name.length));
console.log(`\nBumper ${version} — ${signed ? "signed release" : "unsigned local"} build smoke test\n`);
for (const r of results) {
  const mark = r.ok ? "PASS" : r.soft ? "n/a " : "FAIL";
  console.log(`  [${mark}] ${r.name.padEnd(pad)}  ${r.detail}`);
}
const hardFails = results.filter((r) => r.hard && !r.ok);
console.log("");
if (hardFails.length) {
  console.error(`${hardFails.length} required check(s) failed.`);
  process.exit(1);
}
console.log("All required checks passed.");
