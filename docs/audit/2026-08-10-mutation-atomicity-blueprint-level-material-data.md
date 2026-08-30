# Mutation atomicity audit — Blueprint, Level, Material, DataAsset

**Date:** 2026-08-10
**Issue:** #369
**Scope:** state-changing commands in the four handlers named above. This is a
contract, not a claim that the remaining handlers have been audited.

The common boundary is **Parse → Preflight → Execute → Verify → Shape**. An
error ending in “nothing was changed” is issued before `Modify()`, world
replacement, graph insertion, bounded scalar copy, or dirtying. Once execution has
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
| `data_create` | `AssetTools.CreateAsset` | Required fields, current concrete UDataAsset subclass, valid `/Game` target, collision guard | Creation captures only stable path/class strings plus a weak pointer before `MarkPackageDirty`. No raw creation/class pointer crosses that broadcast. The object is freshly resolved by exact identity before `SaveLoadedAsset`, then freshly resolved again because save is a second callback boundary. `dirty_marked`, `pre_save_re_resolved`, `save_attempted`, conditional `saved`, `target_re_resolved`, and `dirty_known` expose each seam. Any unproven dirty/save/identity fact emits nested `ok:false` with `data_create_unknown_outcome`, so response shaping cannot claim success. |
| `data_get` | None | The `/Game` package/object path is limited to 1,024 characters and lexically validated before object load. Reflection is a purpose-built bounded walk: at most 256 top-level properties, 4,096 JSON values, 1,024 items **and 1,024 physical slots** per container, 256 fields per struct, depth 16, 16,384 characters per string and 262,144 string characters total. Set/map `GetMaxIndex()` is checked before every iterator: `Num()` alone is not a traversal bound for sparse storage, and UE's iterators scan the holes. It never calls `UPropertyToJsonValue`, `ExportTextItem`, a custom struct converter or `FText::ToString`, because each can materialize arbitrary output before the router can trim it. | Partial reads are explicit: `reflection_complete`, `reflection_truncated`, examined/returned/omitted-at-least counts, `omitted_count_exact`, bounded omitted names, unsupported count, first limit reason and the active limits travel with the property bag. Integral values inside the exact IEEE-754 range are JSON numbers; larger signed/unsigned values are exact decimal strings and counted by `large_integers_as_strings`, never rounded or wrapped. A sparse set/map beyond the physical-slot cap is omitted with `reflection_truncated:true`, rather than scanned. Soft, weak and lazy wrapper references are deliberately unsupported/partial: reading them through `FObjectPropertyBase` would turn a valid unloaded path into a false null. Accessor-backed properties are likewise unsupported/partial: raw storage can differ from the logical getter value, while invoking the getter would execute arbitrary native code. |
| `data_set` | One completed, bounded scalar property copy | Path and property name are bounded and lexically validated before load or `FindFProperty`. Only **exact built-in** numeric, enum, bool, string, and name field classes with `ArrayDim == 1` and no native getter/setter are accepted; custom subclasses and accessor-backed fields cannot enter. JSON kinds, finite/integral ranges, enum membership, exact IEEE integer encoding, and string/name limits are validated before staging. Large signed/unsigned integers use canonical decimal strings; enum names resolve by index then value so a legal underlying `-1` is not confused with failure, and bounded authored `A|B` flag lists are split and checked token by token. Assignment uses direct typed property setters—never `JsonValueToUProperty`, `ImportText`, or another extensible converter. Fixed arrays, dynamic containers, every struct, object/interface/delegate/optional/text/field-path value, `CPF_SkipSerialization`, instanced references and every other extensible type are refused. Rejecting all structs is intentional: `UUserDefinedStruct` has no `CppStructOps`, but `InitializeStruct` still copies its mutable `DefaultInstance` into staging. Abstract, transient, deprecated and superseded asset classes are refused too. | Inline scalar storage is capped at 1 MiB and the existing scalar passes bounded reflection before `CopyCompleteValue`. Staging uses `FDefaultConstructedPropertyElement`; it never constructs the attacker-selected DataAsset class. The router explicitly skips the global editor transaction, and the handler skips `Modify`, `PreEditChange`, `PostEditChangeProperty`, deep `Identical`, and implicit `SaveLoadedAsset`. Before `MarkPackageDirty`, it captures only bounded intended JSON plus weak/path/class identity, then leaves the scope containing every UObject/class/property/value pointer and staged destructor. Because dirty marking broadcasts arbitrary callbacks, post-broadcast verification re-loads the object by path, checks exact class identity, re-finds/re-audits the property (including the accessor refusal) and performs a fresh bounded read. `copy_completed` states only that the scalar copy ran. `target_re_resolved`, `dirty_marked`, `dirty_known`, optional `dirty`, and `verified` expose each later seam. If any is untrustworthy, nested `ok:false` plus `data_set_unknown_outcome` makes the top-level response `unknown_outcome` even in ErrorsOnly mode while preserving observed data and mandatory readback recovery. `save_requested:false` never pretends persistence was attempted. |

## Regression evidence

`src/tools/mutation-atomicity-contract.test.ts` pins the ordering that matters:
staging and schema checks precede `Modify()`, world preflights precede map
replacement, the level sanitizer has an explicit restore path, post-compile CDO
verification re-resolves the class, and `UpdateMaterialFunction` has exactly one
guarded call site. Mutating any of those boundaries makes the focused test fail.

`Hayba.MCP.DataAsset.ReadWritePreflight` also uses disposable in-memory assets
to prove abstract classes, soft-object graphs, all structs, `SkipSerialization`
fields and wrong JSON kinds are refused without dirtying or changing their
target. An unloaded soft path proves `data_get` reports wrapper references as
partial rather than false null. A positive scalar write proves the direct bool
setter and fresh verification path. Real sparse script set/map
fixtures (512 live entries behind 2,048 slots) exercise the exact physical-slot
guard used before reflection iteration; scalar-only `data_set` has no container
staging path. Test-only calls through the production parser/resolver prove exact
`UINT64_MAX`, overflow refusal, a legitimate enum value of `-1`, and combined
authored enum flags without an `INDEX_NONE` ambiguity. A package-dirty callback
fixture changes a scalar during `PackageMarkedDirtyEvent` and proves the result
uses fresh post-callback resolution/readback rather than stale pre-callback
verification. Its result is passed through `MakeOkResponse` under ErrorsOnly to
prove nested failure becomes top-level `ok:false`, `unknown_outcome`, preserves
observed data and retains mandatory recovery. The test writes no package.

Live dirty-count and object-state discrimination still belongs in the tagged
editor survival run. Never run it against an untagged/user-owned editor.
