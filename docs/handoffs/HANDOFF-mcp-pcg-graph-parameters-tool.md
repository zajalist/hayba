# Handoff — Add an MCP tool to author PCG graph user-parameters

**Author:** Claude (Opus 4.8), session 4df015f5 — building the Plumb composable spline-room system.
**Audience:** the next Claude implementing a new `HaybaMCPToolkit` command.
**Date:** 2026-06-29

## Why this tool is needed

The Plumb composability keystone is "swap one style config → the whole room restyles, zero graph edits." The canonical UE way to do that is **PCG graph user-parameters** (exposed on the graph) driven by **`PCGGraphInstance`** style assets that override those parameters. From a script-driven agent (me, via `python_run`) I can:

- **SET** existing graph-parameter values — `unreal.PCGGraphParametersHelpers.set_object_parameter(...)` etc. ✅
- **READ** them, and create the `PCGUserParameterGetSettings` node to consume them in-graph. ✅
- **ADD** a new user-parameter to a graph — ❌ **NOT POSSIBLE from Python.**

### Root cause (verified this session)
- A PCG graph's `user_parameters` is an `FInstancedPropertyBag` (Python: `unreal.InstancedPropertyBag`). Its Python surface is only `get/set_editor_property`, `import_text`, `export_text`, `assign`, `copy` — **no add-property method.**
- The property *definitions* live in a dynamically-generated transient `UPropertyBag` struct (`export_text()` returns `(Value=/Engine/Transient.PropertyBag_<hash>())`). Defining a new property is done by C++ `FInstancedPropertyBag::AddProperty(...)`, which is **not bound to Python/Blueprint**.
- `StructUtilsFunctionLibrary` and `BlueprintInstancedStructLibrary` only expose equality/validity helpers — no add-property.
- The Python enum `unreal.PropertyBagPropertyType` lists only **scalar** types (`BOOL, BYTE, DOUBLE, FLOAT, INT32, INT64, NAME, STRING, TEXT, U_INT32, U_INT64`) — **no `Object`/`SoftObject`/`Struct`/`Class`/`Enum`**, so even a value-only path can't represent a kit (`PCGExMeshCollection*`) parameter.

Result: the agent must ask a human to add parameters in the editor Details panel — a collaboration break the user explicitly wants removed. Hence this tool.

## What to build

A toolkit command (handler), e.g. **`pcg_graph_add_parameter`**, callable over the MCP, that adds (and optionally sets the default of) a user-parameter on a `UPCGGraph`. C++ has full access to `FInstancedPropertyBag::AddProperty` and `FPropertyBagPropertyDesc`, including object/struct/class types.

### Proposed signature
```
pcg_graph_add_parameter({
  graph: "/Game/Plumb/Graphs/Sub/SG_WallFacade",   // package path of the UPCGGraph
  name:  "WallKit",                                  // parameter name
  type:  "Object",                                   // Bool|Byte|Int32|Int64|Float|Double|Name|String|Text|Enum|Struct|Object|SoftObject|Class|SoftClass
  valueClass: "/Script/PCGExtendedToolkit.PCGExMeshCollection", // for Object/Class/SoftObject/SoftClass/Struct/Enum: the type's class/struct/enum path
  container: "None",                                 // optional: None|Array|Set
  defaultValue: "/Game/Plumb/Kits/Kit_WallBay",      // optional: asset path (object types) or literal (scalars)
  overwrite: false                                    // if the name exists: error vs replace
})
```
Return: `{ ok, added: bool, name, type, paramCount }`.

A companion **`pcg_graph_list_parameters`** (name/type/default per param) is cheap and very useful for the agent to verify and to drive `set_*_parameter` afterward.

### Implementation sketch (C++)
1. Load the graph: `UPCGGraph* Graph = LoadObject<UPCGGraph>(...)`.
2. Get the mutable bag. PCG exposes the user-parameter bag via `Graph->GetMutableUserParametersStruct()` (or the equivalent accessor on the version installed here — grep `UserParameters` in the PCG plugin). It is an `FInstancedPropertyBag`.
3. Build an `FPropertyBagPropertyDesc Desc(FName(name), EPropertyBagPropertyType::Object, ValueTypeObjectPtr)`:
   - Map the `type` string → `EPropertyBagPropertyType`.
   - For `Object`/`Class`/`SoftObject`/`SoftClass`: resolve `valueClass` to a `UClass*` and pass as the desc's value-type-object.
   - For `Struct`: resolve to `UScriptStruct*`. For `Enum`: `UEnum*`.
   - For `container`: set `Desc.ContainerTypes` accordingly.
4. `Bag.AddProperties({ Desc })` (or `AddProperty`). If `overwrite` and the name exists, `RemoveProperty` first.
5. Optionally set the default value (`Bag.SetValueObject(name, LoadObject(defaultValue))` etc.).
6. `Graph->Modify(); Graph->MarkPackageDirty();` and notify so the editor + any open graph UI refresh (a `PostEditChange` / the PCG-specific "user parameters changed" delegate). Save is the caller's choice.

Watch the installed PCG version's exact accessor names — `GetMutableUserParametersStruct`, the change-notification delegate, and whether `AddProperties` migrates existing instanced values (it should preserve them).

### Optional stretch — `pcg_graph_bind_parameter`
Wiring a parameter to a node property is doable from Python today (create `PCGUserParameterGetSettings`, point it at the param, wire its output into the target node's override pin), but it's fiddly and pin-name-sensitive. A convenience command `pcg_graph_bind_parameter({graph, paramName, targetNodeId, targetProperty})` that does the get-node + override wiring would complete the round-trip. Lower priority than the add.

## Downstream payoff (what unblocks)

With `pcg_graph_add_parameter`, the agent can author the real config-swap end-to-end with no human editor step:
1. Add `WallKit`/`PillarKit`/`DoorKit` Object params to `SG_WallFacade`.
2. Bind each `CollectionToModuleInfos.asset_collection` to its param.
3. Create `PCGGraphInstance` style assets (`Style_Stone`, `Style_Brick`) overriding the three kit params via `PCGGraphParametersHelpers.set_object_parameter`.
4. A beginner picks a graph instance on their spline → whole room restyles, zero graph edits. (The ONEiRA promise.)

Today's interim workaround (works, but heavier): **style = a duplicated master variant** (`M_Room`, `M_Room_Plain`, …); the beginner selects the master via the component's graph. Verified: `PCGComponent.set_graph(master)` recooks and resolves each master's `subgraph_override` correctly. The downside is one master + one wall-subgraph per style instead of one parameterized graph + lightweight instances — exactly what this tool removes.

## Acceptance criteria
- `pcg_graph_add_parameter` adds an Object-typed param to `SG_WallFacade`; `pcg_graph_list_parameters` then shows it; the param appears in the editor Details → User Parameters.
- `PCGGraphParametersHelpers.set_object_parameter` can set it, and a `PCGGraphInstance` of the graph can override it.
- Cooking a component on the graph with the param bound to a CMI's `asset_collection` spawns meshes from the param's kit (swap the override value → different meshes, verified by ISM mesh names).

## Key files
- `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/` — add a `HaybaMCPPCGHandler.cpp` (or extend an existing handler) registering `pcg_graph_add_parameter` / `pcg_graph_list_parameters`.
- `mcp-tools/hayba-mcp/src/tools/` — add the TS tool wrapper + register in `tools/index.ts`.
- PCG plugin source (installed): grep `GetMutableUserParametersStruct` / `FInstancedPropertyBag` / `EPropertyBagPropertyType` for the exact API on this engine version.
