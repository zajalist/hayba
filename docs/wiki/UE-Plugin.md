# UE Plugin

The UE5 C++ editor plugin is `HaybaMCPToolkit`. The authoritative doc is
its own README: [`../../unreal/HaybaMCPToolkit/README.md`](../../unreal/HaybaMCPToolkit/README.md).
This page is a pointer + the handler-domain table.

## Summary

- **Plugin:** `HaybaMCPToolkit` · Editor module · `LoadingPhase:
  PostEngineInit`
- **Engine:** UE 5.7+, depends on the `PCG` plugin
- **Install:** create `<YourProject>\Plugins` if it doesn't exist, then
  `mklink /D "<YourProject>\Plugins\HaybaMCPToolkit" "<repo>\unreal\HaybaMCPToolkit"`
  from an administrator prompt (or with Windows Developer Mode on);
  regenerate VS project files and rebuild (you need Visual Studio with the C++
  toolchain your Unreal Engine version requires). Copying instead
  needs `SidecarEntryPath`; see the plugin README.
- **Role:** runs `FHaybaMCPTcpServer` inside the editor (the UE adapter on
  the TCP seam) and executes commands dispatched by the Node MCP server.
  Length-prefixed JSON envelope on `:52342` (fallback `:52343–52350`); port
  published to `Saved/HaybaMCP/instances/<pid>.json`.
- **Plan Mode:** with Plan Mode on (the default), destructive commands wait
  until the user approves the plan. They run inside
  `GEditor->BeginTransaction`, so most editor edits land on Unreal's normal
  undo stack and Ctrl+Z works — not during Play-In-Editor, and not for asset deletes, saves to disk or arbitrary Python.
- **Provenance:** snapshot-imported; treat the directory as canonical — see
  [`../adr/0004-ue-plugin-location.md`](../adr/0004-ue-plugin-location.md).

## In-editor workspace

The toolkit rail has three destinations: **Agent** for chat, plans, activity
steps, and approvals; **World** for the scene map and contextual findings; and
**Library** for profiled assets and reusable recipes. Settings is the bottom
control, with preferences and tool access inside it.

The Agent composer exposes **Explore**, **Draft**, and **Production**. Explore
is the initial, read-only mode; unknown tools are withheld. Draft and
Production route mutations through the existing exact-call approval gate.
The current World map covers loaded actors only, so it labels unloaded World
Partition regions as unknown rather than implying they are empty. The
versioned scene-intent graph is a researched next step, not yet a map feature.

World's **Inspect** reads native world facts immediately. **Import with Agent**
and **Validate with Agent** add guided requests to the composer without sending
them or replacing an existing draft. Findings use a wrapping list with search,
severity filters, and per-item dismiss/restore and locate actions.

The separate level-editor Plan Mode toggle is removed. **Settings → External
MCP safety** controls the native plan gate; disabling it does not disable
built-in chat approvals. External proposals are stored in the module and
reviewed in Agent. Approval authorizes the next native write command under the
existing gate, not an exact-argument authorization token.

The bundled specialist manifest contains production planning, concept art,
scene layout/blockout, asset preparation, procedural systems, gameplay,
world ingestion, lighting, audio, cinematics, and QA profiles. Each profile
can only narrow the enabled catalog. These are authored operating instructions
with tested routing, not trained or quality-benchmarked models.

## Handler-domain table

One `*Handler.cpp` per domain in
`Source/HaybaMCPToolkit/Private/handlers/`, each implementing
`IHaybaMCPHandler` (`GetCommands()` / `Handle()`):

| | | | |
|---|---|---|---|
| Actor | Animation | Asset | Audio |
| BehaviorTree | Blueprint | Build | DataAsset |
| Docs | Editor | Foliage | ISM |
| Idle | Input | Legacy | Level |
| Material | Network | PIE | Perf |
| Physics | Project | Python | Render |
| SceneGraph | Spline | StaticMesh | Test |
| Texture | UI | UILayout | Vault |
| WorldPartition | | | |

33 concrete handler files, all inside the always-loaded `HaybaMCPToolkit`
plugin.

## Satellite plugins

Two more UE modules ship optional handlers outside `HaybaMCPToolkit`,
installed into a host project separately:

- `unreal/HaybaMCPGAS` — Gameplay Ability System commands.
- `unreal/HaybaMCPMetaSound` — MetaSound graph commands (two of six work
  today; the rest are documented but not agent-callable, pending an
  upstream API).

`HaybaMCPNiagara` and `HaybaMCPSequencer` were deleted — their commands
duplicated `niagara_*` / `seq_*` tools already shipped by the TS/python
layer under different names. See
[ADR-0008](../adr/0008-satellite-plugins-earn-their-place.md) for the
command-by-command audit.

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
