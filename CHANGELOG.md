# Changelog

All notable public releases are documented here.

## 0.6.0-rc.2

- `bumper quickstart` takes a new installation from an empty state to a proven Sandbox and a launch command, and refuses rather than widening an existing Project's boundaries.
- `bumper status` leads with a verdict and the next action; `--verbose` keeps the full inventory and `--json` makes it machine-readable.
- `bumper support` writes a local diagnostic with secrets and personal paths removed; `bumper prove --json` emits machine-readable boundary evidence.
- `bumper doctor` reports the macOS 26+ and Apple Silicon requirement accurately.
- Fixed: CLI preflight failed on Allowed-only images that were, in fact, usable.
- Help is layered so the common path is visible without reading every command.

## 0.6.0-rc.1

- `SECURITY.md` points at GitHub private vulnerability reporting, which is enabled.
- No functional change to the CLI or the app.

## 0.6.0-rc.0 — CLI technical preview

- Sandbox Project Control Plane for the Mac app and terminal-first CLI.
- Folder, network, GitHub App, MCP, Session, audit, backup, and uninstall controls.
- Real Sandbox proof commands and interface-parity regression tests.
- First npm CLI preview, published under the `next` tag so that installing `@crostra/bumper` without a tag does not silently resolve to a prerelease.
- Apple Silicon technical-preview packaging; signed and notarized DMG distribution remains pending.
