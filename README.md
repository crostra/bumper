# Bumper

**Keep an AI coding CLI inside the Project boundary you choose.**

Bumper is a macOS Control Plane for Claude Code, Codex, Cursor Agent, Antigravity, and Grok Build. It runs the chosen CLI in an Apple container Sandbox, with only the folders, network access, GitHub repositories, and MCP Connections that the Project permits.

It is early software. It makes specific, testable containment claims; it does not make an AI's work correct or safe by itself. Read the [security model](docs/SECURITY_MODEL.md) before relying on it.

## Choose an installation path

| Path | Best for | Status |
|---|---|---|
| CLI package | Terminal-first users | Technical preview: published on npm under the `next` tag |
| Signed Mac app | Most Mac users | Not available yet — Developer ID signing and notarization are pending |
| Unsigned Mac app | Developers who understand and accept Gatekeeper's warning | Technical preview; only use a checksum-verified asset from a GitHub Release |
| Source build | Auditing or extending the code | Available — clone this repository |

The unsigned app is intentionally **not** represented as signed or notarized. It can be useful for an informed evaluation, but it is not the recommended path for most users. Details, including how to verify a release asset, are in [distribution](docs/DISTRIBUTION.md).

## Install the CLI technical preview

Requirements: Apple Silicon Mac, Node.js 20 or newer, and Apple's `container` runtime for protected launches.

```bash
npm install --global @crostra/bumper@next
bumper doctor
```

This is a pre-release CLI, intended for informed technical evaluation rather than as a broadly recommended stable release. The `next` tag is explicit so that a future `@crostra/bumper` install does not silently pick up a prerelease. The source that produced it is in this repository, under [Apache-2.0](LICENSE).

Create a Project, inspect its effective boundary, run a proof, and manage recovery. The AI runs in your current terminal:

```bash
npm exec bumper -- init
npm exec bumper -- doctor
npm exec bumper -- room-image build
npm exec bumper -- claude     # or codex, cursor, agy, grok
```

`bumper doctor` explains missing prerequisites and the next safe command. The app and CLI expose the same Project controls; the CLI does not require `node-pty` to be installed merely to check readiness.

## Prove the boundary

Do not take a security boundary on faith. Bumper runs the actual microVM checks:

```bash
bumper prove --sealed  # disposable Sandbox; touches none of your folders
bumper prove           # the selected Project's folders, network, and Git identity
```

The proof reports both expected and observed results. A mismatch blocks a new protected launch for that Project until it is checked again.

## What Bumper controls

- **Folders:** only declared Project folders are mounted; each can be read-only or read-write.
- **Network:** Off, Allowed only, or Open. Allowed only permits the filtering proxy, not a direct Internet route.
- **GitHub:** a GitHub App mints short-lived, repository-scoped tokens. App keys and host Git identity do not enter the Sandbox.
- **MCP:** Connections are brokered to the Sandbox; credentials stay on the Mac side.
- **Sessions:** live Git, Preview, and Docker access can be revoked per Session.
- **Audit and recovery:** local events can be exported or disabled; configuration backups and uninstall never remove a Project folder.

See [the security model](docs/SECURITY_MODEL.md), [architecture](docs/ARCHITECTURE.md), and [CLI reference](docs/CLI.md) for the exact guarantees and limits.

## Build from source

```bash
git clone https://github.com/crostra/bumper.git
cd bumper
npm install
npm test          # add BUMPER_VM_TESTS=1 for the microVM boundary proofs
npm run build
```

`npm run app:pack` produces the unsigned Apple Silicon app in `release/mac-arm64/`.

## Contributing

Issues, Discussions, and pull requests are open. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

This repository is the shipped free version: the source, its tests, and the documentation needed to use and audit it. Everything the released CLI and the app run is here, so every claim on this page can be checked against the code that makes it.

## License and marks

The source code is licensed under [Apache-2.0](LICENSE). The project name and visual marks are covered by [TRADEMARKS.md](TRADEMARKS.md); the license does not grant trademark rights.
