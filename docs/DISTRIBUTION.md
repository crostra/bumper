# Distribution

## Release channels

Bumper has two independent deliverables:

- The CLI package, published as `@crostra/bumper` on npm.
- An Apple Silicon Mac app, distributed from GitHub Releases as a DMG.

They can be released together, but the CLI does not require macOS code signing. A release notes page identifies exactly which assets are available for that version.

The CLI is a technical preview published with npm's `next` tag, so installing `@crostra/bumper` without a tag does not silently resolve to a prerelease. Install it explicitly with `npm install --global @crostra/bumper@next`. Do not treat a prerelease as the broadly recommended stable channel.

## Signed releases

The normal Mac app path is a DMG signed with a Developer ID Application certificate and notarized by Apple. A signed release is verified before publication with:

```bash
BUMPER_SIGN=1 npm run app:dmg
npm run app:smoke
```

The smoke check verifies the app signature, Gatekeeper assessment, notarization staple, and DMG mount. A release is not described as signed or notarized until those checks pass.

## Unsigned technical previews

Before Developer ID signing is available, maintainers may attach an **unsigned technical preview** DMG to a GitHub Release. This is for people who deliberately want to evaluate the app and understand macOS Gatekeeper's warning.

Only use an unsigned preview when all of the following are true:

1. You downloaded it from this project's GitHub Releases page, not a mirror or a link in a message.
2. The release includes a SHA-256 checksum and your downloaded file matches it.
3. You understand that macOS cannot identify the developer or confirm Apple notarization for this build.
4. You are comfortable using a technical preview on a non-critical machine or account.

To verify a downloaded DMG on macOS:

```bash
shasum -a 256 Bumper-<version>-arm64.dmg
```

Compare the result with the checksum in the matching GitHub Release. If it differs, delete the file and do not open it.

Gatekeeper may block the first launch. Do not bypass that warning for a file whose release and checksum you did not verify. A signed release removes this technical-preview limitation; it does not change Bumper's own stated security model.

## Build from source

For the current source tree:

```bash
npm install
npm test
npm run app:pack
```

The unsigned app is written to `release/mac-arm64/Bumper.app`. `npm run app:install-local` is the repeatable local install command: it builds, replaces `/Applications/Bumper.app`, and opens it.
