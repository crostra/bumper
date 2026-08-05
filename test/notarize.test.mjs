import test from "node:test";
import assert from "node:assert/strict";
import notarize from "../scripts/notarize.mjs";

test("a requested signed release refuses to silently skip notarization credentials", async () => {
  const previous = {
    BUMPER_SIGN: process.env.BUMPER_SIGN,
    APPLE_ID: process.env.APPLE_ID,
    APPLE_APP_SPECIFIC_PASSWORD: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
  };
  process.env.BUMPER_SIGN = "1";
  delete process.env.APPLE_ID;
  delete process.env.APPLE_APP_SPECIFIC_PASSWORD;
  delete process.env.APPLE_TEAM_ID;
  try {
    await assert.rejects(
      () => notarize({ electronPlatformName: "darwin", appOutDir: "/nonexistent", packager: { appInfo: { productFilename: "Bumper" } } }),
      /requires APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID/,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
