# Security policy

## Supported versions

Hayba MCP Toolkit is pre-1.0. Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security findings.

- Email the maintainers (or DM the GitHub maintainer account) with the reproducer.
- Include the affected version, the impact (e.g., arbitrary code execution, credential disclosure), and steps to reproduce.
- Allow up to 7 days for an initial response.

## Threat model

The MCP server runs inside the Unreal Editor process and exposes a TCP listener on `127.0.0.1:52342-52350`. By default it accepts unauthenticated localhost-only connections. For multi-user / shared workstations:

- Set a **Capability Token** in Settings; it must accompany every TCP command.
- Keep the **Execution journal** enabled (`Saved/hayba-execution.log`).
- Do **not** enable **Allow Tier 3 Python** unless you trust every client that can reach the listener — Tier 3 gives full filesystem / subprocess access.

The Python script tool is sandboxed by tier:

| Tier | Allowed | Default |
|---|---|---|
| 1 | `unreal.*` editor scripting only | Always |
| 2 | Tier 1 + read-only project FS | Always |
| 3 | Tier 1+2 + arbitrary I/O, subprocess, sockets | Opt-in |

## Disclosure

Confirmed vulnerabilities are credited (with permission) in the [CHANGELOG](CHANGELOG.md). We don't currently maintain a separate security advisories feed; major issues will be announced via release notes.
