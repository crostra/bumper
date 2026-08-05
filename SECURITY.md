# Security policy

## Supported versions

Only the latest published release is supported with security fixes.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's **Report a vulnerability** control on this repository's [Security tab](https://github.com/crostra/bumper/security/advisories/new) — private reporting is enabled.

Include the affected version, reproduction steps, the expected and observed boundary, and any `bumper prove` output with secrets removed.

## Scope

Useful reports include Sandbox escape, incorrect folder mounts, egress bypass, credential exposure, token revocation failure, and an app/CLI inconsistency that weakens an enforced claim. Reports about an AI producing incorrect code are out of scope unless they demonstrate a Bumper boundary failure.
