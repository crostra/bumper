# CLI reference

Run `bumper --help` for the complete, version-specific command list.

| Command | Purpose |
|---|---|
| `bumper init` | Create a Sandbox Project for the current folder. |
| `bumper doctor` | Check Node, Apple container, image, and Project readiness. |
| `bumper [-p project] claude` | Start an official AI CLI in the resolved Project Sandbox. Replace `claude` with `codex`, `cursor`, `agy`, or `grok`. |
| `bumper prove [--sealed]` | Check the actual Sandbox boundary. |
| `bumper project`, `folders`, `network` | Compose a Project's effective boundary. |
| `bumper github`, `git` | Connect a GitHub App, bind repositories, and control live Session access. |
| `bumper mcp` | Inspect and bind MCP Connections. |
| `bumper setup`, `dev`, `login`, `prefs` | Reuse boundaries, manage Preview/Docker Sessions, inspect logins, and set local preferences. |
| `bumper log`, `backup`, `uninstall` | Export local events, recover configuration, and remove Bumper-owned state. |

Creating a GitHub App requires a browser because GitHub's manifest flow is a browser-submitted form. `bumper github connect` starts a local page and prints its URL; it does not ask the CLI to handle the form itself.
