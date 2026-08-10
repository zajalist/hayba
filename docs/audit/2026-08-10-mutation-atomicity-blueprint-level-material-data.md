# Mutation atomicity audit — Blueprint, Level, Material, DataAsset

**Date:** 2026-08-10
**Issue:** #369
**Scope:** state-changing commands in the four handlers named above. This is a
contract, not a claim that the remaining handlers have been audited.

The common boundary is **Parse → Preflight → Execute → Verify → Shape**. An
error ending in “nothing was changed” is issued before `Modify()`, world
replacement, graph insertion, reflection copy, or dirtying. Once execution has
started, the response carries observed dirty/save/verification facts; it does
not disguise a persistence or readback failure as a clean rejection.

## Blueprint

| Commands | First mutation | Preflight | Verification / recovery |
|---|---|---|---|
| `blueprint_create` | `CreatePackage` / `CreateBlueprint` | Required strings, parent class, valid unused `/Game` package, registry + memory collision guard | Returns actual path plus `saved` and `dirty`. `saved:false` means the new object exists only in memory; save or delete it, never retry the same create blindly. |
| `blueprint_add_component`, `blueprint_add_variable`, `blueprint_add_function` | SCS/member/function graph insertion | Concrete component type and unique component name; supported variable type and unique variable name; unique function graph name | Every command recompiles, reports `compiled_clean`, compile diagnostics and `dirty`. A failed compile enters the existing broken-blueprint gate; repair/compile before another mutation. |
| `blueprint_add_node`, `blueprint_add_event` | `BP->Modify()` immediately before graph insertion | All strings, bounded integral positions/counts, supported node kind, graph, referenced variable/class/function/event | Returns the inserted node/pins and dirty state. The edit is staged until explicit compile. |
| `blueprint_connect_nodes` | `BP->Modify()` immediately before `TryCreateConnection` | Both nodes and pins, schema `CanCreateConnection` | Reads the bidirectional `LinkedTo` relation back, reports `verified`/`dirty`, and warns on an unknown mismatch instead of manufacturing `connected:true`. |
| `blueprint_set_pin_default` | `BP->Modify()` | Resolves object/class reference and calls `IsPinDefaultValid` before `Modify()` | Returns applied readback, `verified`, and `dirty`; invalid object paths/literals cannot create an empty undo/dirty edit. |
| `blueprint_set_defaults` | `CDO->Modify()` followed by completed property copies | The patch is bounded (128 properties, 4,096 JSON values, 1,024 array items, depth 32), then every value is applied to a same-class transient staging object; missing/unconvertible keys are classified before execution | After compile, the generated class and CDO are re-resolved (old CDO pointers are not retained). `succeeded`, `failed`, `skipped`, and `verification_failed` describe the exact partial outcome. |
| `blueprint_compile` | Blueprint compiler; optional package save | `path` and boolean `save` are parsed before compile | Compile diagnostics are authoritative. Save failure returns the compile report with `saved:false`, `save_error`, and dirty state instead of a preflight-looking error. `save:false` is represented as `save_requested:false`, not a fake failed save. |

## Level and viewport state

| Commands | First mutation | Preflight | Verification / recovery |
|---|---|---|---|
| `level_load` | `LoadMap` | Bounded path normalized to an existing package, editor present, PIE/SIE stopped, current map not dirty | Re-resolves the editor world after the transition and compares its package to the requested path. A mismatch is an unknown outcome with the observed path; inspect `level_get_info`, do not retry blindly. |
| `level_create` | `CreateNewMapForEditing` | Valid unused `/Game` package, editor present, PIE/SIE stopped, current map clean | Returns `world_changed`, previous/observed world, `saved`, `dirty`, and `verified`. If save fails after replacement, the response explicitly says the new unsaved world is active and tells the caller how to recover. |
| `level_save` | Removal of transient mesh references immediately before `SaveCurrentLevel` | Editor world/current level exists; PIE/SIE stopped; sanitization is restricted to actors in the level being saved | Failed save restores every removed mesh reference and the original package dirty flag before returning error. Successful save verifies the package exists and is no longer dirty. |
| `level_set_bookmark`, `level_goto_bookmark` | In-memory bookmark insert / viewport setters | Exact finite location or a real viewport; bounded name; current world and viewport before goto | A bookmark records its world package. It is rejected after a map transition rather than applying a transform captured in a different world. Goto cannot return success without an active viewport client. |

`level_save`'s optional `path` and `level_create`'s advertised `name` parameter
remain a descriptor/handler mismatch outside these handler-owned changes. The
runtime command saves the current level and creates by full `path`; the surface
must not claim otherwise.

## Material and material-function graphs

| Commands | First mutation | Preflight | Verification / recovery |
|---|---|---|---|
| `material_create`, `material_function_create`, `material_create_instance` | `AssetTools.CreateAsset` | Required strings, valid `/Game` target, resolved parent where applicable, registry + live-memory collision guard | Returns actual path, `saved`, `dirty`, and save error. A failed save is an in-memory created asset, not permission to retry creation. |
| `material_add_node`, `material_set_node` | asset/expression `Modify()` immediately before create/copy | Exactly one target, concrete expression class, bounded integral position, and complete recursive property compatibility (including finite numbers, enum/object resolution, depth 32, nested-field and array caps) | Node insertion/position is read back. Unexpected property failures are still listed. Graph remains dirty and is not persisted until explicit compile; per-edit `PostEditChange` broadcasts are forbidden. |
| `material_connect_nodes`, `material_disconnect` | asset `Modify()` immediately before changing one resolved `FExpressionInput` | Exactly one target and one addressing form, integral bounded indices, source output and destination input/property resolved before mutation | Connection is read back by pointer/output index. Disconnect distinguishes `already_disconnected` from an applied edit and does not dirty on a no-op. |
| `material_set_property` | `Mat->Modify()` followed by completed property copies | Every requested setting is validated and applied to a fresh transient staging material; the live graph/resource is not duplicated or compiled | Copies only fully staged property values and returns per-key verification plus dirty state. It reports `save_requested:false`; explicit compile is the persistence boundary. |
| `material_set_param` | instance `Modify()` immediately before one setter | Existing parameter and exact value kind; finite scalar/vector values; referenced texture; static switch presence | Reads the parameter back, reports `verified`, then reports the real save result and dirty state. |
| `material_apply` | component `Modify()` immediately before `SetMaterial` | World/actor/material/component and bounded existing slot all resolved | Reads the slot back, distinguishes `already_applied`, and reports package dirty state. |
| node/comment/reroute delete/add/set commands | owning asset `Modify()` immediately before collection edit | Exactly one material/function target, existing IDs, finite bounded positions/sizes/colors/fonts, non-empty updates and unique reroute names | Returns dirty state and, for graph deletes/adds, collection readback. All function edits are staged. |
| `material_compile` | guarded `UpdateMaterialFunction` or material translate, then save | Static graph crash-shape validation runs before translation | This is now the **only** call site for `UpdateMaterialFunction`. It is SEH guarded, reports translator errors and the real save result. A guarded fault is an unknown/unsaved outcome; stop dependent mutations and inspect/restart as instructed. |

Material function edit commands previously called `UpdateMaterialFunction`
after every small edit. That performed a crash-prone compile/broadcast while a
graph was intentionally incomplete. They now only dirty the function; the
explicit guarded compile command owns translation and persistence.

## DataAsset

| Commands | First mutation | Preflight | Verification / recovery |
|---|---|---|---|
| `data_create` | `AssetTools.CreateAsset` | Required fields, UDataAsset subclass, valid `/Game` target, collision guard | Returns actual object path, `saved`, and `dirty`; a failed save is explicitly an in-memory asset. |
| `data_set` | `Asset->Modify()` followed by one completed property copy | Target must be a DataAsset; property must be editable/persisted. JSON is bounded to 4,096 values, 1,024 array items, 256 object fields and depth 32 before conversion runs against a fresh same-class transient object containing a copy of the old property value. | Post-edit value is compared to staging and serialized as `observed_value`; `verified`, real `saved`, `dirty`, and recovery text distinguish coercion and persistence failure. A conversion failure cannot partially resize/write the live property. |

## Regression evidence

`src/tools/mutation-atomicity-contract.test.ts` pins the ordering that matters:
staging and schema checks precede `Modify()`, world preflights precede map
replacement, the level sanitizer has an explicit restore path, post-compile CDO
verification re-resolves the class, and `UpdateMaterialFunction` has exactly one
guarded call site. Mutating any of those boundaries makes the focused test fail.

Live dirty-count and object-state discrimination still belongs in the tagged
editor survival run. Never run it against an untagged/user-owned editor.
