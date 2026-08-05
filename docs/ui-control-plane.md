# Mac Control Plane

The Mac app composes and explains a Bumper Project. It is not an IDE and does not replace the official AI CLI.

The primary surfaces are:

- **Projects:** create a Project from a folder; inspect its effective folders, network, AI login profile, Git, and MCP Connections.
- **Events:** inspect and export the local audit record.
- **Library:** manage reusable GitHub App and MCP Connection resources.
- **Settings:** manage local preferences, backups, recovery, and explicit update checks.

The app does not present a normal GUI launch button as the main path. After composing a Project, run the displayed `bumper <cli>` command in a terminal. The AI CLI then runs inside the Sandbox while the app remains the place to inspect or revoke Project controls.

Every permission shown as enforced maps to a tested implementation boundary. The app does not present unimplemented controls as active protection.
