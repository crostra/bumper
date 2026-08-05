import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const appPath = resolve(root, "release", "mac-arm64", "Bumper.app");
const dmgPath = resolve(root, "release", `Bumper-${packageJson.version}-arm64.dmg`);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.env.BUMPER_SIGN === "1") {
  // Real release: electron-builder signs with the Developer ID, the afterSign
  // hook (scripts/notarize.mjs) notarizes + staples, and it builds the DMG in
  // one pass so the DMG carries a stapled, Gatekeeper-passing app.
  run("npm", ["run", "build"]);
  run(process.execPath, [join("scripts", "fix-node-pty.mjs")]);
  run(join("node_modules", ".bin", "electron-builder"), ["--mac", "dmg", "--arm64"]);
  console.log("Signed + notarized DMG built in release/. Run 'npm run app:smoke' to verify.");
} else {
  // Local verification: ad-hoc signed app, DMG assembled with hdiutil (no Apple
  // account needed). Not distributable — Gatekeeper will warn on other Macs.
  run("npm", ["run", "app:pack"]);
  run("/usr/bin/hdiutil", ["create", "-volname", `Bumper ${packageJson.version}`, "-srcfolder", appPath, "-ov", "-format", "UDZO", dmgPath]);
  console.log(`Unsigned DMG built at ${dmgPath} (local verification only).`);
}
