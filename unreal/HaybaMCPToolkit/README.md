# Hayba MCP Toolkit — Unreal Engine 5 plugin

The **UE5 C++ editor plugin** half of Hayba. It runs a TCP server inside the
editor and executes commands dispatched by the Node MCP server in
[`mcp-tools/hayba-mcp`](../../mcp-tools/hayba-mcp). Together they form one
protocol across two language boundaries — see [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)
and [`CONTEXT.md`](../../CONTEXT.md).

- **Plugin:** `HaybaMCPToolkit` · Editor module · `LoadingPhase: PostEngineInit`
- **Engine:** UE 5.7.0 · depends on the `PCG` plugin
- **Version:** see `HaybaMCPToolkit.uplugin`

## Install

Copy this folder into your UE project's `Plugins/` directory, regenerate
Visual Studio project files, and rebuild (UE 5.7+, Visual Studio 2022).
Build artifacts (`Binaries/`, `Intermediate/`, `Saved/`, `DerivedDataCache/`,
`.vs/`) are intentionally **not** tracked — UBT regenerates them.

## The TCP seam

`FHaybaMCPTcpServer` listens on `:52342` (auto-fallback `:52343-52350`) and
speaks a length-prefixed JSON envelope (`{ cmd, id, params, auth? }`). The
Node side (`mcp-tools/hayba-mcp/src/tcp-client.ts`) is the other adapter on
this seam; the two must agree on the envelope. Port discovery is published
to `Saved/HaybaMCP/instances/<pid>.json` for multi-editor setups.

Every destructive command is wrapped in `GEditor->BeginTransaction` (Plan
Mode) so `Ctrl+Z` works.

## Command-handler domains (33)

Each domain implements `IHaybaMCPHandler` (`GetCommands()` / `Handle()`),
registered in `HaybaMCPModule`:

`Actor` · `Animation` · `Asset` · `Audio` · `BehaviorTree` · `Blueprint` ·
`Build` · `DataAsset` · `Docs` · `Editor` · `Foliage` · `GAS` · `ISM` ·
`Input` · `Legacy` · `Level` · `Material` · `MetaSound` · `Network` ·
`Niagara` · `PIE` · `Perf` · `Physics` · `Project` · `Python` ·
`SceneGraph` · `Sequencer` · `Spline` · `StaticMesh` · `Test` · `Texture` ·
`UI` · `WorldPartition`

## Source layout

```
Source/HaybaMCPToolkit/
  Public/   IHaybaMCPHandler.h · HaybaMCPCommandHandler.h · HaybaMCPModule.h
  Private/  module, TCP server, settings, Slate panels
  Private/handlers/  one *Handler.cpp per domain above
Resources/  icons, PCGEx registry DB, embedded cognitive-map HTML
```

## Provenance

Snapshot-imported from the standalone geoforge project tree (its local git
history is not authoritative). Treat this directory as the canonical
source. See ADR [`docs/adr/0004-ue-plugin-location.md`](../../docs/adr/0004-ue-plugin-location.md).
