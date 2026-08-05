import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "node_modules", "node-pty");
const helpers = [
  join(root, "prebuilds", "darwin-arm64", "spawn-helper"),
  join(root, "prebuilds", "darwin-x64", "spawn-helper"),
  join(root, "build", "Release", "spawn-helper"),
];

for (const helper of helpers) {
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
