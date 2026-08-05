import { execFileSync } from "node:child_process";
import { join } from "node:path";

const run = (command, args, env = process.env) => execFileSync(command, args, { stdio: "inherit", env });

run("npm", ["run", "build"]);
run(process.execPath, [join("scripts", "fix-node-pty.mjs")]);

const releaseSigning = process.env.BUMPER_SIGN === "1";
const builderEnv = releaseSigning
  ? process.env
  : { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
run(join("node_modules", ".bin", "electron-builder"), ["--mac", "dir", "--arm64"], builderEnv);

if (!releaseSigning) {
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "release/mac-arm64/Bumper.app"]);
}
