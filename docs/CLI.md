# CLI reference

Run `bumper --help` for the complete, version-specific command list.

| Command | Purpose |
|---|---|
| `bumper quickstart [cli]` | Create or select the current folder's Project, prepare its image, prove a disposable room, and print the launch command. Add `--plan` to preview without writes. |
| `bumper status [--verbose\|--json]` | Show the current Project, boundary, runtime, live Sessions, and next action without starting a Session. |
| `bumper init` | Create a Sandbox Project for the current folder. |
| `bumper doctor` | Check Node, Apple container, image, and Project readiness. |
| `bumper [-p project] claude` | Start an official AI CLI in the resolved Project Sandbox. Replace `claude` with `codex`, `cursor`, `agy`, or `grok`. |
| `bumper prove [--sealed] [--json]` | Check the actual Sandbox boundary and optionally print machine-readable evidence. |
| `bumper support` | Print redacted local diagnostics as JSON. It does not upload or open anything. |
| `bumper project`, `folders`, `network` | Compose a Project's effective boundary. |
| `bumper github`, `git` | Connect a GitHub App, bind repositories, and control live Session access. |
| `bumper mcp` | Inspect and bind MCP Connections. |
| `bumper setup`, `dev`, `login`, `prefs` | Reuse boundaries, manage Preview/Docker Sessions, inspect logins, and set local preferences. |
| `bumper log`, `backup`, `uninstall` | Export local events, recover configuration, and remove Bumper-owned state. |

Use `bumper help <topic>` for focused help and `bumper help all` for the complete command catalog. `bumper status` is intentionally a fast configuration view; use `bumper doctor` when image and executable checks are required.

Creating a GitHub App requires a browser because GitHub's manifest flow is a browser-submitted form. `bumper github connect` starts a local page and prints its URL; it does not ask the CLI to handle the form itself.
