# Handoff: optimization tooling the toolkit is missing

From a real UE 5.8.2 session on `D:/UnrealEngine/saskartarad` — an 8.16 km World Partition
map (256 Nanite landscape proxies, 3 PCG graphs, dense instanced foliage). The session
diagnosed a GPU crash and a framerate/memory problem end to end using only `python_run`
plus log grepping. Everything below is friction that actually cost round-trips, not
speculation.

Ordered by how much pain each one removes.

---

## 1. `cvar_query` — the single biggest gap

**What happened.** To confirm whether `r.Shadow.Virtual.Cache.MaxMaterialPositionInvalidationRange`
and `foliage.WPODisableDistance` exist in 5.8, I had to:

1. `execute_console_command(world, "<name>")` for each candidate,
2. tail `Saved/Logs/saskartarad.log`,
3. read whether the line came back as `Cmd: <name>` (does not exist) or
   `<name> = "value"   LastSetBy: <source>` (exists).

Then, for the full picture, `DumpCVars` → a **10,628-line** log dump → grep.

**Why the existing path fails.** `unreal.SystemLibrary.get_console_variable_float_value(name)`
returns `0.0` both for "the value is zero" and "no such cvar". That ambiguity is dangerous:
a misspelled cvar in `[SystemSettings]` is **silently ignored** by the engine, so a typo
looks exactly like a setting that didn't help.

**Proposed tool.**

```
cvar_query(names: string[] | pattern: string)
  -> [{ name, exists, value, type, default, lastSetBy, help, flags }]
```

`lastSetBy` is the high-value field — it distinguishes `Constructor` (engine default) from
`Scalability` from `SystemSettingsIni` from `ProjectSetting`. That is how this session found
the editor was running **Cinematic** VSM settings (`ResolutionLodBiasDirectional=-1.5`,
`MaxPhysicalPages=8192`, `SMRT.RayCountDirectional=16`, all `LastSetBy: Scalability`) rather
than defaults — a major and otherwise invisible cost.

Pair it with `cvar_set(pairs)` that **verifies the readback** and reports any name that
didn't take.

---

## 2. `console_exec` that returns its own output

`execute_console_command` returns `None`. Every diagnostic command in this session
(`DumpTextureStreamingStats`, `DumpCVars`, `pcg.Cache.LogStats`, the `stat` family) needed a
follow-up shell round-trip to tail and grep the log, plus guessing the log line format.

```
console_exec(command, capture: bool = true, timeout_ms)
  -> { lines: string[], durationMs }
```

Implementation: install a temporary `FOutputDevice` around the `Exec` call. This alone
removes roughly a third of the tool calls this session made.

---

## 3. `pcg_spawner_audit` / `pcg_spawner_descriptor_set` — the actual bug finder

**The bug that caused everything.** Every PCG mesh spawner entry in the project had
`InstanceStartCullDistance = 0` and `InstanceEndCullDistance = 0`. In
`FPCGSoftISMComponentDescriptor` **zero means infinite, not "sensible default"**. Result:
every rock, barrel, fence board, cobblestone, shrub and grass clump across 8.16 km was
submitted for rendering, shadowing, ray tracing and GPU skinning at any distance.

It produced three symptoms that looked unrelated:

- low framerate,
- "texture streaming pool over budget",
- a `DXGI_ERROR_DEVICE_REMOVED` GPU hang with breadcrumb `GPUSkinCache_UpdateSkinningBatches`
  at only 7.75 GB of a 9.7 GB VRAM budget — evidence against a simple
  aggregate-VRAM-exhaustion explanation, not proof of the exact crash cause.

**It is invisible in the PCG graph editor.** The only way to see it is
`descriptor.export_text()` string parsing.

**Reading descriptors today is genuinely awful:**

- `dir()` on a struct returns only `['assign','cast','copy','export_text','import_text',
  'static_struct','to_dict','to_tuple']` — no property names at all.
- `export_text()` returns a ~3,800-character flat string you have to substring-search.
  I searched a 900-char window for `WorldPositionOffset`, concluded the field didn't exist,
  told the user so, and **was wrong** — `WorldPositionOffsetDisableDistance`,
  `NanitePixelProgrammableDistance` and `ShadowCacheInvalidationBehavior` were all present,
  just past my window. A structured reader would have prevented a wrong answer to the user.
- Writing requires a copy-back dance, because struct getters return copies:

  ```python
  e = ents[i]; d = e.get_editor_property('descriptor')
  d.set_editor_property(...); e.set_editor_property('descriptor', d); ents[i] = e
  sel.set_editor_property('mesh_entries', ents)
  ```

  and `settings.set_editor_property('mesh_selector_parameters', sel)` **throws** — the
  selector is an instanced UObject, so mutating it in place is both necessary and sufficient.

**Proposed tools.**

```
pcg_spawner_audit(graph?: string)   // all graphs if omitted
  -> [{ graph, nodeIndex, entryIndex, mesh, weight, warnings: [...] }]
```

Warnings worth flagging, all of which were real findings here:

| Warning | Why |
|---|---|
| `endCullDistance == 0` | infinite draw distance |
| `visibleInRayTracing` on dense small foliage | BVH VRAM plus per-frame build |
| `affectDistanceFieldLighting` on grass | noise in the global distance field |
| `shadowCacheInvalidationBehavior == Auto` on WPO foliage | invalidates VSM pages every frame |
| `worldPositionOffsetDisableDistance == 0` while the material writes WPO | WPO evaluated to the horizon |
| Nanite on a sub-1000-triangle mesh that already has LODs | fixed Nanite overhead for no benefit (found `SM_Rock_01`: 396 tris / 3 LODs, `SM_barrel_01`: 998 tris / 4 LODs) |
| mesh has 1 LOD and Nanite is **off** | no LODs at all |
| `castContactShadow` on dense instanced foliage | expensive, invisible |

```
pcg_spawner_descriptor_set(graph, nodeIndex, entryIndices|"all", props: {...})
```

taking snake_case props and returning a verified readback, handling the copy-back dance
internally.

---

## 4. `crash_report_read`

`Saved/Crashes/<id>/` is a goldmine that currently needs hand-parsing:

- `CrashContext.runtime-xml` → `<CrashType>GPUCrash`, `<ErrorMessage>`, `<GPUBreadcrumbs>`,
  `<MemoryStats.*>`, `<Misc.NumberOfCores>`
- the **sibling `saskartarad.log`** → the complete cvar state *at the moment of the crash*,
  plus `LogD3D12RHI: Error: Video Memory Stats` (Local Budget / Local Used), the active GPU
  breadcrumb, and DRED/Aftermath status.

Reading `r.SkinCache.RecomputeTangents = "2"` out of that crash-time log is exactly how the
root cause was found. Without a tool it is: find newest crash dir → grep the xml for specific
tags → grep the sibling log for five different patterns.

```
crash_report_read(index = 0)  // newest
  -> { crashType, errorMessage, gpuBreadcrumbs[], vram: {budgetMB, usedMB},
       cvarsAtCrash: {...}, callstackTop[], logTail[] }
```

---

## 5. `gpu_memory_report` / `streaming_report`

```
streaming_report() -> { poolSizeMB, nonStreamingMipsMB, requiredMB, currentMB,
                        overBudgetMB, topAssets: [{path, currentMB, wantedMB}] }

gpu_memory_report() -> { localBudgetMB, localUsedMB, systemBudgetMB, systemUsedMB,
                         nanitePoolMB, vsmPhysicalPagesMB, rtBvhMB }
```

`DumpTextureStreamingStats` already prints most of the first; it just needs capture and
parse. The per-asset breakdown (`ListStreamingTextures`) is what answers "which textures are
blowing the budget" — a question this session never got a clean answer to.

---

## 6. `wp_load_region` — currently blocked by a crash risk

This session could not verify its own fixes under load, because there is no safe way to load
a World Partition region:

- `WorldPartitionBlueprintLibrary.get_actor_descs()` takes **no arguments** and returns all
  1,335+ descs. The docstring is misleading; passing a `Box` is a `TypeError`.
- `load_actors(actors_to_load)` takes `Array[Guid]`.
- **Constructing `unreal.Guid` hard-crashes this editor.** Both `unreal.Guid()` +
  `import_text()` and `unreal.Guid(a=,b=,c=,d=)` fault in `python311` →
  `PythonScriptPlugin` (`EXCEPTION_ACCESS_VIOLATION`). It killed the editor on 2026-09-22
  and cost a full restart.

So the agent had to ask the human to click in the World Partition window. A native handler
doing the box query and the load on the C++ side sidesteps Guid marshalling entirely:

```
wp_load_region(box | center+extent, dryRun?) -> { actorsLoaded, byClass: {...} }
wp_unload_all()
```

This is arguably the highest-value item for *verification* workflows — right now an agent can
change things but cannot measure the result without the human.

---

## 7. Smaller things

- **`asset_nanite_audit(paths|folder)`** → `{ path, naniteEnabled, triangles, numLods,
  hasWpoMaterial }`. Used constantly; currently 3–4 `python_run` calls each.
- **`does_asset_exist` is unreliable right after import.** It returns `False` for a
  freshly-imported asset the registry hasn't indexed yet, while `load_asset` on the same path
  returns a valid object. This session wrote a "0 entries were added" conclusion off that
  false negative and had to retract it later. Either fall back to `load_asset` internally or
  document the caveat loudly.
- **`material_get_info` has no `node_filter` parameter** despite the signature suggesting one,
  and **`material_compile` takes `material_path`, not `path`**.

---

## 8. `python_run` constraints worth surfacing in the tool description

Each of these cost at least one failed call:

- **5 s cooperative deadline.**
- Forbidden substrings: `try`, `getattr`, `open(`, `.replace(`, `new_level(`. Note that `try`
  and `.replace(` are things a model reaches for constantly; the rejection should name which
  token tripped.
- Non-primitives print as `<non-primitive value omitted>` unless wrapped in `str()`.
- **Exception arguments are stripped** (`AttributeError: <exception arguments omitted by
  bounded capture>`), so a failure gives you a line number but not the attribute name.
  Letting the exception *message* through — even truncated, even with paths scrubbed — is the
  single cheapest debugging improvement available to this tool.
- PCG attribute selectors serialise as `PCGBegin(Name)PCGEnd` / `PCGBegin($Density)PCGEnd`;
  `import_text` with normal struct syntax is silently ignored.
- `match_and_set_type` is a **UClass**; the instance is `match_and_set_instance`. Reading the
  former and calling `get_editor_property('entries')` on it produces a confusing error and, in
  this session, a wrong "0 entries" conclusion that was reported to the user before being
  caught.

---

## Reference: what the fixes turned out to be

For whoever writes the audit rules. All verified against UE 5.8.2 source at
`C:/Program Files/Epic Games/UE_5.8/Engine/Source`:

- `r.SkinCache.RecomputeTangents` 2 → 0 (the crashing breadcrumb; foliage bends rigidly, so
  recomputed tangents buy nothing)
- per-entry `InstanceStart/EndCullDistance` (were all 0)
- `ShadowCacheInvalidationBehavior` → `Rigid` on foliage
- `visibleInRayTracing` / `affectDistanceFieldLighting` off for grass and small debris
- `r.Streaming.PoolSize` 1536 → 3072 — note that an explicit value **replaces**
  `[TextureStreaming] PoolSizeVRAMPercentage` (70 on Windows) entirely
- `r.Shadow.Virtual.ResolutionLodBiasDirectional` −1.5 → 0.0 (scalability was Cinematic)
- `r.Shadow.Virtual.NonNanite.IncludeInCoarsePages` → 0

Two traps worth encoding as **anti-rules**, because a naive optimizer gets both wrong — this
session applied both, caught them in review against engine source, and reverted them:

1. **`r.Shadow.Virtual.Cache.DeformableMeshesInvalidate=0` is not a foliage fix.**
   `VirtualShadowMapCacheManager.cpp:1288` gates on `Proxy->HasDeformableMesh()` for *every*
   proxy, so it also freezes the shadows of the player character and any animated NPC. The
   targeted equivalent is per-component `ShadowCacheInvalidationBehavior = Rigid`.
2. **`foliage.MaxEndCullDistance` is not a global backstop.** It only applies inside
   `FHierarchicalStaticMeshSceneProxy`'s dynamic-mesh path
   (`HierarchicalInstancedStaticMesh.cpp:1658` and `:1870`). It does nothing for the plain
   `InstancedStaticMeshComponent` + Nanite components that PCG spawns.

An audit tool that recommended either of those would be actively harmful.

---

## One measurement caveat

`pcg.Cache.Editor.MemoryBudgetMB` defaults to **6144**, which looks like a 6 GB RAM hog and
was initially reported to the user as one. `pcg.Cache.LogStats` then showed
`0 Entry count / 0.00 Memory(MB)` — it is a ceiling, not usage. Any audit tool that flags
"large budget" settings must read actual usage before claiming a win. Note also that
`pcg.Cache.MemoryBudgetMB` is **deprecated in 5.7** in favour of the `.Editor.` and
`.Runtime.` variants, and warns when set.
