/**
 * Dogfood install: pack unsigned Bumper.app and replace /Applications/Bumper.app.
 *
 * Same steps every time for local verification — not the signed release path.
 *   npm run app:install-local
 *
 * Env:
 *   BUMPER_INSTALL_PATH  default /Applications/Bumper.app
 *   BUMPER_NO_OPEN=1     skip launching after install
 *   BUMPER_NO_QUIT=1     do not attempt to quit a running Bumper
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const src = join(root, "release", "mac-arm64", "Bumper.app");
const dst = resolve(process.env.BUMPER_INSTALL_PATH || "/Applications/Bumper.app");
const openAfter = process.env.BUMPER_NO_OPEN !== "1";
const quitFirst = process.env.BUMPER_NO_QUIT !== "1";

const run = (command, args, opts = {}) => {
  execFileSync(command, args, { stdio: "inherit", ...opts });
};

const tryQuit = () => {
  if (!quitFirst) return;
  spawnSync("osascript", ["-e", 'tell application "Bumper" to quit'], { stdio: "ignore" });
  spawnSync("pkill", ["-f", `${dst}/Contents/MacOS/Bumper`], { stdio: "ignore" });
  spawnSync("pkill", ["-f", "release/mac-arm64/Bumper.app/Contents/MacOS/Bumper"], { stdio: "ignore" });
  // Brief wait so file locks clear before replace.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
};

console.log("install-local-app: packing…");
run(process.execPath, [join(root, "scripts", "build-app.mjs")]);

if (!existsSync(src)) {
  console.error(`install-local-app: missing pack output: ${src}`);
  process.exit(1);
}

console.log(`install-local-app: installing → ${dst}`);
tryQuit();

const staging = join(tmpdir(), `Bumper.app.installing.${process.pid}`);
rmSync(staging, { recursive: true, force: true });
run("/usr/bin/ditto", [src, staging]);
rmSync(dst, { recursive: true, force: true });
run("/usr/bin/ditto", [staging, dst]);
rmSync(staging, { recursive: true, force: true });

const verify = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", dst], {
  encoding: "utf8",
});
if (verify.status !== 0) {
  // Ad-hoc local packs often still launch; report but do not fail dogfood install.
  console.warn("install-local-app: codesign --verify reported issues (unsigned/ad-hoc is expected for local packs).");
  if (verify.stderr) process.stderr.write(verify.stderr);
}

if (openAfter) {
  console.log("install-local-app: opening Bumper…");
  run("/usr/bin/open", ["-a", "Bumper"]);
}

console.log(`install-local-app: done → ${dst}`);
