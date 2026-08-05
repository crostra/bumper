# Security model

Bumper is a local boundary layer for AI coding tools. It aims to constrain where an AI CLI runs and what that running process can reach. It is not a correctness guarantee for generated code or an antivirus product.

## Enforced boundaries

Protected launches run inside an Apple container Sandbox. A Project explicitly composes:

- **Doors:** host folders mounted into the Sandbox, with read-only or read-write access.
- **Egress:** Off, Allowed only, or Open network mode.
- **Provider access:** short-lived, repository-scoped GitHub App tokens for bound repositories.
- **Brokered integrations:** MCP Connections whose credentials stay outside the Sandbox.

`bumper prove` runs a real Sandbox and tests the observed boundary. A Project proof evaluates the Project's declared folders, network, and Git identity; `bumper prove --sealed` uses a disposable Sandbox with no user folders. Add `--json` to produce machine-readable evidence.

## Important limits

- Bumper cannot prevent a user from deliberately running an AI CLI outside Bumper.
- Open network mode is unrestricted by design.
- Network Allowed only is a boundary around direct Internet egress; the Sandbox can reach the Mac-hosted filtering proxy needed for allowed destinations.
- GitHub enforces repository and contents permissions. Bumper requests the scope and revokes the Session token; it does not inspect Git commands.
- External MCP is MCP-only. It is not a claim that an external client has Bumper-protected files, shell, or network.
- The Mac app is currently unsigned until a signed release says otherwise. Code-signing identity and Bumper's runtime boundary are different assurances.

## Data handling

Bumper stores its local configuration and event record on the user's Mac. It does not send telemetry without an explicit user action. Event retention can be changed or disabled with `bumper prefs`; `bumper log --export` exports the current local record. `bumper support` generates redacted diagnostics locally and prints them to standard output; it does not upload them.

For a deeper implementation overview, see [ARCHITECTURE.md](ARCHITECTURE.md). To report a vulnerability privately, follow the project-level [security policy](../SECURITY.md).
