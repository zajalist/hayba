# Handoff — MCP Toolkit Agent-Ergonomics Postmortem & Fixes

**Author:** Claude (Opus 4.8), session 4df015f5 — building the Plumb composable PCG spline-room system in UE 5.7 via the hayba-toolkit MCP.
**Audience:** the next Claude tasked with improving `hayba-mcp` + `HaybaMCPToolkit`.
**Date:** 2026-06-28

## Context

A long, geometry-heavy session authoring PCG graphs (`/Game/Plumb/Graphs/...`), greybox meshes, and materials entirely through the MCP. The work *succeeded*, but a large fraction of the round-trips were spent fighting tool ergonomics rather than the actual problem. Every issue below is grounded in a concrete incident from that session. Ordered by cost.

The single most expensive theme: **the agent could not see the viewport**, so it reasoned from numeric transforms while the human reasoned from pixels — causing several wrong-direction loops ("i dont see the walls", "floor is in the ceiling", "UVs are stretched"). Fix the capture path first.

---

## P0 — `editor_capture_viewport` returns the image as truncated TEXT, not an image block

**Symptom:** every capture came back with `image_base64` truncated (`"_truncated":[{"path":"image_base64","removed":19524}]`). The agent never saw a single screenshot the entire session.

**Root cause:** `mcp-tools/hayba-mcp/src/tools/editor/editor-capture-viewport.ts:31`
```ts
let text = JSON.stringify(resp.data, null, 2);   // image_base64 embedded as a giant string
return { content: [{ type: 'text', text }] };    // text gets length-capped downstream → image destroyed
```
The base64 is serialized into a text content block, which the response-shaping/transport layer then truncates.

**Fix:** return a proper MCP **image content block** and keep the metadata as a separate small text block:
```ts
const { image_base64, ...meta } = resp.data as any;       // split payload from metadata
return {
  content: [
    { type: 'image', data: image_base64, mimeType: 'image/jpeg' }, // UE handler returns JPEG
    { type: 'text', text: JSON.stringify(meta, null, 2) },         // camera, width, height
  ],
};
```
Confirm the UE side encoding (`HaybaMCPEditorHandler.cpp` → `CaptureViewport`, and `EHaybaRendererType::Image` in `HaybaMCPToolStreamPanel.cpp:111`) is JPEG; set `mimeType` accordingly. If a client can't render inline images, *then* fall back to writing a PNG/JPEG to a temp path and returning the path string — but the image block is the right primary path.

**Acceptance:** agent calls `editor_capture_viewport` and can actually describe on-screen geometry without the human relaying it.

---

## P1 — No UE reflection introspection (schema / pins / enums)

**Symptom:** dozens of round-trips rediscovering API shape by trial-and-error. Real examples from this session:
- `unreal.Rotator(0,0,90)` is `(roll,pitch,yaw)` → that's **yaw**, not the roll intended (silently wrong, no error).
- `InstancedStaticMeshComponent.get_instance_transform(i, False)` returns a `Transform` — does **not** unpack as a tuple.
- `copy_mesh_from_static_mesh` needs a `GeometryScriptMeshReadLOD`; `copy_mesh_to_static_mesh` needs a `GeometryScriptMeshWriteLOD` (cryptic nativize errors otherwise).
- PCG attribute selector for a slashed name requires `import_text('PCGBegin(PCGEx/CollectionEntry)PCGEnd')` — `set_attribute_name('PCGEx/CollectionEntry')` returns `True` but silently leaves `@Last`.
- The visible "Map" pin on the PCGEx Staging node is internally **`CollectionSource`**, not `Overrides` (which is the generic node-override pin). Wired the wrong pin once because of this.

**Fix:** add an introspection command (e.g. `hayba_introspect`) that, given:
- a UClass/UStruct name → dumps editor-property names, types, and (for enums) member values;
- a PCG node (graph + node id, or a settings class) → dumps **input and output pin labels**, flagged data-pin vs property-override-pin.

`get_tool_signature` exists but only covers MCP command schemas, not the UE reflection surface the agent actually authors against. This is the second-biggest multiplier after P0.

**Acceptance:** agent can discover a node's pin labels and a struct's properties in one call instead of N failed edits.

---

## P1 — stdout truncation has no pagination / spill

**Symptom:** listing pins, asset inventories, and property dumps repeatedly truncated mid-output, forcing a workaround of writing to a scratch file from inside `python_run` and `Read`ing it back.

**Fix (any one):** raise the `python_run` stdout cap; add `offset`/`limit` paging; or auto-spill to a temp file when output exceeds the cap and return the path. The file-spill is cheap and robust.

**Acceptance:** a 40-line pin dump returns in one call without manual file gymnastics.

---

## P2 — Known editor-crashers have no guardrail

**Symptom:** the toolkit knowingly exposes commands that crash the editor. From memory + this session: `render_camera` and `level_create` crash; in-use `delete_asset` of a session-touched PCG graph wedges the editor via a blocking modal; `set_lod_build_settings`/`build_scale3d` crash and don't update bounds. ~5 editor crashes across the broader effort traced to these.

**Fix:** a refusal/confirm layer keyed on a known-crash list. On hit, return an error that names a safe alternative, e.g.:
- `render_camera` → "use `set_level_viewport_camera_info` + `editor_capture_viewport`".
- in-use `delete_asset` → "rename/move instead; never delete a graph cooked this session".
- `build_scale3d` → "use GeometryScript `append_box`/`transform_mesh` + `copy_mesh_to_static_mesh`".

**Acceptance:** calling a known-crasher returns guidance instead of taking down the editor.

---

## P2 — Cook+verify is two steps; `wait_for_idle` never settles

**Symptom:** `PCGComponent.generate(True)` is async, so instance counts read 0 in the same call — every cook needed a *separate* follow-up call to inspect results. And `wait_for_idle` returned `world_tick: { busyOnEntry: true, timedOut }` **every time** — it gave no usable settle signal (world_tick is essentially always "busy" in the editor).

**Fix:**
- Add `pcg_cook_and_wait(actor, component?)` that regenerates, blocks on **PCG graph settle** (not `world_tick`), and returns the resulting output summary (per-mesh ISM counts + optional `mesh_topology_stats`) in one response.
- Fix or drop `world_tick` from `wait_for_idle`'s gating — it's a false-positive source. Gate on shaders/assets/pcg only.

**Acceptance:** one call cooks and returns instance counts; `wait_for_idle` actually returns settled when the scene is idle.

---

## P3 — `python_run` is the de-facto API; PCG authoring primitives are missing

**Symptom:** ~90% of this session's graph authoring was hand-rolled `python_run` against UE reflection (add node, set property, wire pin, cook, inspect). The `plumb_*`/`pcg_*` wrappers don't cover the core author loop, so every operation re-derived reflection details (see P1).

**Fix:** a few thin, composable PCG primitives:
- `pcg_add_node(graph, settingsClass) -> nodeId`
- `pcg_set_prop(graph, nodeId, path, value)` (supports nested struct paths like `distribution_settings/distribution`)
- `pcg_wire(graph, fromNode, fromPin, toNode, toPin)`
- `pcg_inspect_instances(actor) -> [{mesh, count, sampleTransform}]`

These would replace the bespoke python and eliminate most P1 guessing.

**Acceptance:** building a Subdivide→Staging→Spawner chain is 4 typed calls, not a 60-line python block with trial-and-error.

---

## Smaller notes

- **Nativize errors are cryptic.** `Cannot nativize 'NoneType' as 'RequestedLOD'` should ideally surface the expected Python type/constructor up front. Low priority; P1 introspection mostly addresses this.
- **`get_referencers` is great** — it made the safe "archive vs delete" cleanup workflow trivial. More "is this safe to move/delete" helpers in that vein (e.g. "what maps/actors reference this asset") would be valuable.
- **`hayba_invoke python_run` tracebacks are good** — keep them. The crash-guard fix (SEH + script-wrapper finalize inside the guard, `HaybaMCPPythonHandler.cpp`) from an earlier session is holding; don't regress it.

## Suggested order of work

1. **P0 capture-to-image-block** — unblocks agent self-verification (biggest single win).
2. **P1 introspection** — kills the largest source of failed round-trips.
3. **P1 stdout pagination/spill** — cheap, removes file-gymnastics.
4. **P2 crash guardrails** + **P2 cook_and_wait / wait_for_idle fix** — stability + fewer calls.
5. **P3 PCG authoring primitives** — the big ergonomic refactor; do last, informed by 1–4.

## Key files

- `mcp-tools/hayba-mcp/src/tools/editor/editor-capture-viewport.ts` — P0 fix site.
- `unreal/.../Private/handlers/HaybaMCPEditorHandler.cpp` — `CaptureViewport`, confirm JPEG encoding.
- `unreal/.../Private/handlers/HaybaMCPIdleHandler.cpp` — `wait_for_idle` / `world_tick` gating (P2).
- `unreal/.../Private/handlers/HaybaMCPPythonHandler.cpp` — `python_run` (stdout cap P1; introspection could live alongside).
- `mcp-tools/hayba-mcp/src/tools/index.ts` — tool registration (where new `pcg_*` / `hayba_introspect` wrappers register).
