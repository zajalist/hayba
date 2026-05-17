# Getting Started

This page is a **pointer**. The authoritative setup guide is
[`../getting-started.md`](../getting-started.md) (add-on tiers), with the
quick start in [`../../README.md`](../../README.md). Don't duplicate them
here — the outline below only frames the prerequisites.

## Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Node.js | **≥ 22.5** | `@hayba/mcp` `engines` field; older Node crashes on `node:sqlite`-adjacent native deps (see [Troubleshooting](Troubleshooting.md)) |
| Unreal Engine | **5.7** | The `HaybaMCPToolkit` plugin targets UE 5.7.0 and depends on the `PCG` plugin |
| Visual Studio | **2022** | Required to rebuild the UE C++ plugin |

`@hayba/gaea-server` only needs **Node ≥ 20** and is optional.

## Shape of setup

1. **Tier 1 (core, required)** — install the UE plugin into your project's
   `Plugins/`, regenerate VS project files, rebuild; install and build the
   Node MCP server. Details:
   [`../getting-started.md`](../getting-started.md) §Tier 1 +
   [`../../mcp-tools/hayba-mcp/README.md`](../../mcp-tools/hayba-mcp/README.md).
2. **Tier 2 (visual intelligence, optional, GPU recommended)** — the Python
   visual sidecar. [`../getting-started.md`](../getting-started.md) §Tier 2.
3. **Tier 3 (workflow skills, optional)** — copy the `addons/workflows/*`
   `SKILL.md` guides into your Claude Code skills directory.

## The local gate

GitHub Actions is non-functional repo-wide; the authoritative gate is local
(see [Troubleshooting](Troubleshooting.md) and
[`../adr/0005-github-actions-nonfunctional-local-gate.md`](../adr/0005-github-actions-nonfunctional-local-gate.md)):
build the workspace deps, then `tsc --noEmit` + vitest in
`mcp-tools/hayba-mcp`.
