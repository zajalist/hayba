# mcp-tools/pcgex — PCGEx debug-overlay tooling (parked)

Supporting MCP tooling for instrumenting [PCGEx](https://pcgex.org/)
(`PCGExtendedToolkit`) graphs inside Unreal Engine with debug-visualisation
subgraphs. **This workspace is parked**: it is not a wired npm package (no
`package.json`), the dispatched tools reference a `tcp-client` /`types`
module that is not co-located here, and the bundled dashboard is a legacy
standalone UI. The authoritative PCGEx surface ships from
[`../hayba-mcp`](../hayba-mcp) (the PCGEx node registry + `query-pcgex-docs`
and related tools).

## What's here

| Path | What |
|---|---|
| [`src/tools/inject-debug-nodes.ts`](src/tools/inject-debug-nodes.ts) | Inject a PCGEx debug subgraph onto explicit edges of a `PCGGraph` asset. |
| [`src/tools/auto-wire-debug-overlay.ts`](src/tools/auto-wire-debug-overlay.ts) | Auto-inject a debug subgraph across all (or filtered) edges; supports `dryRun`. |
| `Plugins/Hayba_PcgEx_MCP/ThirdParty/mcp_server/dashboard/` | Legacy standalone dashboard (HTML/CSS/JS). |
| `dashboard/` | Legacy dashboard assets (CSS/JS). |

Both tool modules expect a `PCGGraph` asset path and one of the PCGEx debug
subgraphs (`DebugEdges`, `DebugPaths`, `DebugBounds`, `DebugFilters`,
`DebugHeuristics`, `DebugSphere`) from `/PCGExtendedToolkit/Subgraphs/`. They
dispatch over the same TCP seam as the main server.

## Status

Reference material / not currently built or wired into `@hayba/mcp`. If this
capability is revived, it should be folded into `@hayba/mcp`'s tool surface
and the legacy `Hayba_PcgEx_MCP` plugin tree retired (the resource resolver
in `mcp-tools/hayba-mcp/src/config.ts` already keeps legacy
`Hayba_PcgEx_MCP` installs working). See [`../../CONTEXT.md`](../../CONTEXT.md)
for the PCG/PCGEx glossary entry.
