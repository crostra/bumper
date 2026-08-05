# Architecture

## Project → Sandbox → official AI CLI

A Bumper Project is configuration: its accessible folders, network mode, AI login profile, GitHub repository bindings, and MCP Connections. A protected launch resolves the Project, checks readiness, and attaches the official AI CLI to the caller's terminal inside an Apple container Sandbox.

```text
Project configuration
  ├─ folders (Doors)
  ├─ network (Egress)
  ├─ GitHub App repository bindings
  └─ MCP Connections
          │
          ▼
Apple container Sandbox ── current terminal ── official AI CLI
```

The Mac app is the Control Plane for composing and inspecting a Project. The CLI provides the same operations for terminal-first workflows. The implementation keeps user intents in `src/operations/`; both entry points adapt into those operations so validation, revocation, and audit behavior do not differ by interface.

## Git and MCP

GitHub App private keys remain in the macOS Keychain. At Session start, Bumper requests a short-lived token scoped to the repositories and capability selected by the Project. Turning live Git access off revokes tokens for the Session.

MCP Connections run through a local broker. The AI receives the connection as an MCP tool, not the underlying credential. Availability differs by client; `bumper mcp show <connection>` reports the supported delivery path.

## Verification

The test suite includes unit tests, interface-parity checks, and macOS VM-backed checks where the Apple container runtime is available. Run:

```bash
npm test
BUMPER_VM_TESTS=1 npm test  # on a compatible Mac, for VM-backed checks
```
