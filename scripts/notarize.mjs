/**
 * electron-builder afterSign hook: notarize and staple the signed .app.
 *
 * Runs only for real release builds (BUMPER_SIGN=1) with Apple credentials in
 * the environment — otherwise it is a no-op, so local `dir`/ad-hoc builds keep
 * working with no Apple account. Uses `xcrun notarytool` directly so there is no
 * extra npm dependency to install or audit.
 *
 * Required env for a real run:
 *   APPLE_ID                       Apple Developer account email
 *   APPLE_APP_SPECIFIC_PASSWORD    app-specific password for notarytool
 *   APPLE_TEAM_ID                  Developer Team ID
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const APP_BUNDLE_ID = "com.crostra.bumper";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status}`);
}

export default async function notarize(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  if (process.env.BUMPER_SIGN !== "1") {
    console.log("notarize: skipped (BUMPER_SIGN != 1 — local/unsigned build).");
    return;
  }

  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !password || !teamId) {
    throw new Error(
      "notarize: BUMPER_SIGN=1 requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID; refusing to produce a falsely signed release.",
    );
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = join(appOutDir, `${appName}.app`);
  const work = mkdtempSync(join(tmpdir(), "bumper-notarize-"));
  const zipPath = join(work, `${appName}.zip`);
  try {
    console.log(`notarize: zipping ${appPath}`);
    run("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, zipPath]);
    console.log("notarize: submitting to Apple (this can take several minutes)…");
    run("/usr/bin/xcrun", [
      "notarytool", "submit", zipPath,
      "--apple-id", appleId, "--password", password, "--team-id", teamId,
      "--wait",
    ]);
    console.log("notarize: stapling ticket to the app");
    run("/usr/bin/xcrun", ["stapler", "staple", appPath]);
    console.log(`notarize: done (${APP_BUNDLE_ID}).`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
