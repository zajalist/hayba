# UE Plugin

The UE5 C++ editor plugin is `HaybaMCPToolkit`. The authoritative doc is
its own README: [`../../unreal/HaybaMCPToolkit/README.md`](../../unreal/HaybaMCPToolkit/README.md).
This page is a pointer + the handler-domain table.

## Summary

- **Plugin:** `HaybaMCPToolkit` · Editor module · `LoadingPhase:
  PostEngineInit`
- **Engine:** UE 5.7.0, depends on the `PCG` plugin
- **Role:** runs `FHaybaMCPTcpServer` inside the editor (the UE adapter on
  the TCP seam) and executes commands dispatched by the Node MCP server.
  Length-prefixed JSON envelope on `:52342` (fallback `:52343–52350`); port
  published to `Saved/HaybaMCP/instances/<pid>.json`.
- **Plan Mode:** every destructive command is wrapped in
  `GEditor->BeginTransaction` so `Ctrl+Z` works.
- **Provenance:** snapshot-imported; treat the directory as canonical — see
  [`../adr/0004-ue-plugin-location.md`](../adr/0004-ue-plugin-location.md).

## Handler-domain table

One `*Handler.cpp` per domain in
`Source/HaybaMCPToolkit/Private/handlers/`, each implementing
`IHaybaMCPHandler` (`GetCommands()` / `Handle()`):

| | | | |
|---|---|---|---|
| Actor | Animation | Asset | Audio |
| BehaviorTree | Blueprint | Build | DataAsset |
| Docs | Editor | Foliage | GAS |
| ISM | Input | Legacy | Level |
| Material | MetaSound | Network | Niagara |
| PIE | Perf | Physics | Project |
| Python | SceneGraph | Sequencer | Spline |
| StaticMesh | Test | Texture | UI |
| WorldPartition | | | |

33 concrete handler files; the repo's docs consistently frame this as
**"34 command-handler domains"** (see [MCP-Tool-Reference](MCP-Tool-Reference.md)
for the note on this count).

## Source layout

```
Source/HaybaMCPToolkit/
  Public/   IHaybaMCPHandler.h · HaybaMCPCommandHandler.h · HaybaMCPModule.h
  Private/  module, TCP server, settings, Slate panels
  Private/handlers/  one *Handler.cpp per domain above
Resources/  icons, PCGEx registry DB, embedded cognitive-map HTML
```

Build artifacts (`Binaries/`, `Intermediate/`, `Saved/`, `.vs/`) are not
tracked — UBT regenerates them. See
[Troubleshooting](Troubleshooting.md) for multi-instance port behaviour and
[Architecture](Architecture.md) for the seam.
