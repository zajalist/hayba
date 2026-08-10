# Generated-Python bounded-work inventory

Issue #413 audits all 108 `PyToolDescriptor` declarations under `src/tools/`,
including the PCG primitives and introspection descriptor as well as the
`*-py-tools.ts` domain files.
The machine-readable inventory and drift test live beside the Python boundary in
`generated-python-work-inventory.ts` and `.test.ts`; a descriptor cannot be added
without choosing a work classification.

## Closed in this slice

| Tool                         | Exact pre-transport limit                                                                               | Safer alternative                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `foliage_scatter_paint`      | 10,000 precomputed ground-trace/transform candidates; radius <= 100,000 uu; density <= 10,000 per 100m2 | Reduce radius/density or split the footprint into non-overlapping regions whose candidate formula is <= 10,000. |
| `niagara_advance_simulation` | 7,200 precomputed native ticks; seconds <= 60; tick delta in [1/240, 1]                                 | Increase `tick_dt`, or advance in chunks of at most 7,200 ticks.                                                |

Both refuse non-finite/out-of-range input and over-limit derived counts before
script allocation and before the UE transport is called. The generated script
receives the already-validated integer count; it no longer repeats the formula.
Every numeric refusal, including schema-level field failures, carries a stable
`bounded_work_limit` fact, the exact applicable limit, a safer/chunking
alternative, and confirmation that no Unreal request was sent.

## Classification used by the drift guard

- `bounded-in-scope`: a caller-derived formula has an exact pre-transport cap.
- `fixed-caller-work`: this review found no caller collection or numeric formula
  multiplying the script/native-call count.
- `follow-up-open`: a caller collection, caller numeric value, or project/editor
  collection can still amplify work. This is an inventory finding, not a safety
  endorsement.

The caller-collection backlog currently includes `actor_set_selection`,
`actor_batch_transform`, `actor_set_folder`, `asset_save`, `asset_open_editor`,
`content_browser_sync`, `foliage_add_instances`, `niagara_param_set`,
`niagara_set_user_param_default`, `pcg_set_prop`, and
`water_body_river_create`. The Niagara value fields are unbounded `z.any()`
payloads whose color path materializes `list(value)`; `pcg_set_prop` accepts an
unbounded `z.unknown()` value and recursively walks object fields. These tools
have not received collection limits in this slice.

The helper audit also pins project/editor-cardinality findings individually as
open. This includes actor-resolution fallbacks used by `actor_focus` and the
actor batch/set tools; the actor fallback in `object_exists`; import
`source_files`/filename extraction in `asset_get_source_path`; all-instance
transform reads used by `foliage_type_inspect` and `foliage_add_instances`;
the landscape actor resolver used by all four material/LOD/Nanite tools; and
the `static_materials` collection in `mesh_set_material_slot`. The same search
found exposed-parameter-store enumeration in
`niagara_set_user_param_default`, dirty-package native work in `asset_save`,
enabled-plugin enumeration in `water_check_plugin`, and optional WaterZone
actor lookup in the three water-body create tools. Component, track, asset
registry, reflection, and other engine collections already identified by the
inventory remain open as well. None of these inventory corrections changes a
tool implementation or claims that the underlying work is bounded.

Caller-controlled numeric amplification is a separate open category. It
currently includes `water_body_ocean_create` (extent),
`water_body_lake_create` (radius), `water_body_river_create` (width/depth),
`water_waves_set_gerstner` (wave count/wavelength), and `water_zone_create`
(extent/render-target resolution). These tools have not been fixed by #413;
they require their own finite/range and derived native-work caps before they
can move out of `follow-up-open`.

This work does not replace process isolation for arbitrary `python_run`, does
not prove engine-native calls are crash-proof, and does not close the broader
collection findings. Disposable-editor hostile and positive live validation is
still required before #413 can be closed.
