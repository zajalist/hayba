# Handoff — python_run world-switch crash: add a guardrail (+ optional safe path)

**Author:** Claude (Fable 5), sessions 4df015f5/3c601b17 — Plumb PCG system on `template.uproject`.
**Audience:** the next Claude working on `HaybaMCPToolkit` / `hayba-mcp`.
**Date:** 2026-07-05
**Companions:** `HANDOFF-mcp-agent-ergonomics-postmortem.md` (P2 "known-crasher guardrail" — this is a concrete new entry for that list, with a confirmed repro and crash signature), `HANDOFF-mcp-pcg-graph-parameters-tool.md`.

## The crash (confirmed repro, user-visible editor death)

Calling a **world-switching** function from `python_run` kills the editor:

```python
unreal.EditorLoadingAndSavingUtils.new_blank_map(False)   # ← this call
```

Sequence observed:
1. The call first raises a **native access violation** during script execution — the plugin's SEH guard (`ExecPythonGuarded`, `HaybaMCPPythonHandler.cpp:35`) catches it and reports "native access violation … re-acquire handles fresh". Editor still alive at this point.
2. On a subsequent tick the engine asserts and the editor dies:
   ```
   Assertion failed: CurrentGWorld == EditorContext.World()
   [Engine\Source\Editor\UnrealEd\Private\EditorEngine.cpp] [Line: 1745]
   ```

**Root cause:** `python_run` executes on the game thread **mid-tick from the TCP server's tick delegate** (`FHaybaMCPTcpServer::DrainPendingCommands` → `FHaybaMCPPythonHandler::Run`). A map load/create tears down the current `UWorld` and swaps `GWorld` **underneath the in-flight tick whose context still references the old world**. The SEH guard can swallow the first AV, but nothing can reconcile `GWorld` vs `EditorContext.World()` afterwards — the 1745 assert is unavoidable. This is not a bug in the python script; it is a structural "never do this from this execution context."

Same family (previously observed, now explained by the same mechanism): the `level_create` hayba command crashing the editor (twice, earlier sessions).

## Fix 1 (required): block world-switching calls in python_run

Add a pre-execution guard in `HaybaMCPPythonHandler` (or a python-side prelude injected before the user script) that rejects scripts containing world-switching calls, with a clear error naming the alternative:

- Deny-list (substring match on the script is fine as a first pass):
  - `EditorLoadingAndSavingUtils.new_blank_map`
  - `EditorLoadingAndSavingUtils.new_map_from_template`
  - `EditorLoadingAndSavingUtils.load_map`
  - `EditorLevelLibrary.new_level` / `.load_level` (deprecated aliases)
  - `LevelEditorSubsystem.new_level` / `.load_level`
- Error message should say: *"World-switching calls crash the editor when run from the MCP tick (GWorld/EditorContext desync, EditorEngine.cpp:1745). Use the `editor_open_map` command instead (see Fix 2), or ask the user to switch maps in the editor UI."*
- Also remove/guard the existing `level_create` legacy command the same way (known crasher).

This mirrors the P2 "known-crash guardrail" item in the ergonomics handoff; treat this as its first concrete implementation with a repro.

## Fix 2 (recommended): provide a SAFE map-switch command

The agent has a legitimate need to open/create maps. The safe pattern is to **defer the world switch out of the command tick**:

- New command `editor_open_map { path?: string, template?: string, save_current?: bool }`.
- Implementation: from the handler, **do not** call the load synchronously. Schedule it for the next engine tick *outside* the TCP drain, e.g.:
  ```cpp
  // in the handler: capture params, then
  GEditor->GetTimerManager()->SetTimerForNextTick([Params]() {
      FEditorFileUtils::LoadMap(Params.Path, /*LoadAsTemplate*/false, /*bShowProgress*/true);
      // or UEditorLoadingAndSavingUtils::NewBlankMap / NewMapFromTemplate for create-cases
  });
  ```
  and return `{scheduled:true}` immediately. The agent then polls `hayba_check_ue_status` / a `current_map` query until the world name changes.
- Include `current_map` in the response of `hayba_check_ue_status` (cheap, helps the agent confirm the switch landed).

## Related save-blocker worth a helper (optional, low effort)

The reason the agent reached for `new_blank_map` at all: an **untitled level created from the OpenWorld template cannot be saved** — `save_map` fails with
`Can't save ...: Illegal reference to private object: 'StaticMesh /Temp/Untitled_1_InstanceOf_.../HVLDTOB47BH89LD9IMV2MQ.StaticMesh_HLOD0_Instancing_0' referenced by 'LandscapeMeshProxyComponent_0'` (template HLOD/Landscape junk holding `/Temp` refs). Also note `save_map` can pop a **modal "Message" dialog** on such warnings, which blocks the game thread and looks like a wedge to the MCP (the agent had to close it via `WM_CLOSE`).

Two cheap improvements:
1. A `level_save { path }` command that (a) pre-strips actors whose class is Landscape*/`HLOD` when the current map is an unsaved `/Temp` template map (or at least reports the illegal-ref failure as structured data instead of a modal), and (b) runs the save with `FEditorFileUtils::PromptToCheckoutLevels` suppressed / silent flags so no modal can block the thread.
2. In the TS layer, surface save warnings in the command result rather than relying on the editor's modal.

## Addendum (2026-07-06): world-partition untitled levels also crash USER-INITIATED saves

After scripted `save_map` attempts on an OpenWorld-template untitled level (illegal HLOD refs → failed SaveAs, modal dismissed via WM_CLOSE, partial Landscape/HLOD actor deletion), the USER clicking Save in the UI crashed the editor:
`Assertion failed: !GetWorldPartition() || !GetWorldPartition()->IsInitialized() [WorldPartitionSubsystem.cpp:507]` (Slate → LevelEditor → SaveAs path).
Takeaway for `level_save`: never run the strip-and-SaveAs dance on a world-partitioned /Temp level — it leaves the WP subsystem inconsistent and the *next* save (even the user's) asserts.
**Project-side mitigation now in place** (template.uproject): `EditorStartupMap=/Game/Plumb/L_PlumbWork` — a clean non-WP Basic-template level committed as an asset, so sessions never start in the hostile OpenWorld untitled world. The MCP-side `level_save`/`editor_open_map` work should treat "current world is an unsaved WP template" as an error state with a clear message, not something to muscle through.

## Acceptance criteria
- `python_run` with `new_blank_map(...)` in the script returns a structured error (editor stays alive, no assert) naming the safe alternative.
- `editor_open_map` switches maps without the EditorEngine.cpp:1745 assert (verify: switch, then run a trivial `python_run` — no AV, no crash on next ticks).
- `level_save` (if built) saves an untitled OpenWorld-template level containing PCG actors without a blocking modal, or returns the illegal-ref list as data.

## Key files
- `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPPythonHandler.cpp` — deny-list guard (Fix 1); `ExecPythonGuarded` at :35, `Run` at :288.
- `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPTcpServer.cpp` — `DrainPendingCommands` (:171), where the mid-tick context comes from.
- New handler for `editor_open_map` / `level_save` — alongside `HaybaMCPEditorHandler.cpp`.
- `mcp-tools/hayba-mcp/src/tools/` — TS wrappers + registration in `tools/index.ts`.
