import { chmodSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
rmSync(resolve(root, "dist"), { recursive: true, force: true });
const result = spawnSync(process.execPath, [resolve(root, "node_modules", "typescript", "bin", "tsc")], {
  cwd: root, stdio: "inherit", env: process.env,
});
if (result.error) throw result.error;
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
// package.json bin points at dist/cli.js; keep +x so npm link / nodenv shims work after rebuild.
chmodSync(resolve(root, "dist", "cli.js"), 0o755);
process.exit(0);
