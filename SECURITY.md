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
- Treat `python_run` as constrained, in-process editor scripting. Tier-3 host I/O
  is always refused before interpreter execution. The legacy `allow_unsafe`
  boolean and old persisted setting are accepted only for compatibility; both
  are deprecated and ineffective.

The Python script tool is classified by tier:

| Tier | Allowed                                                      | Default                    |
| ---- | ------------------------------------------------------------ | -------------------------- |
| 1    | `unreal.*` editor scripting only                             | Always                     |
| 2    | Tier 1 + read-only project FS                                | Always                     |
| 3    | Filesystem writes, subprocesses, sockets, and other host I/O | Always refused pre-execute |

Use typed brokered MCP tools for supported host operations (#412/#415). The
denylist and cooperative deadline reduce known risks, but embedded Python still
shares the Unreal Editor process: they do not prove arbitrary Python or native
extension calls safe and are not process isolation. That trust-boundary work is
tracked by #392/#414.

## Disclosure

Confirmed vulnerabilities are credited (with permission) in the [CHANGELOG](CHANGELOG.md). We don't currently maintain a separate security advisories feed; major issues will be announced via release notes.
