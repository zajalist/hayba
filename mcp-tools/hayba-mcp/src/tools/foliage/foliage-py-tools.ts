// Foliage-and-scatter P0 tools, generated as UE Python via the pyTemplate
// factory (see py-tool-factory.ts). Sibling of actor/actor-py-tools.ts and
// landscape/landscape-py-tools.ts (the closest Wave-3 pattern) — same
// PyToolDescriptor shape, same _emit/_err envelope (auto-prepended by
// runUePythonJson), same index.ts splice, same _prop()/_set() multi-name
// defensive reflection idiom, same warnings[] surfacing.
//
// Source of truth for the catalog: docs/plans/2026-06-28-mcp-supertooling-tools.json,
// domain "foliage-and-scatter". We ship the python-feasible, NET-NEW subset that
// authors the foliage SYSTEM directly (create types, read/set typed params, bulk
// add explicit transforms, deterministic ground-traced scatter, and bounded
// removal). We skip catalog entries whose only reliable path is the render /
// job-envelope pipeline, PLUMB-mask integration, stateful selection working-sets,
// or a legacy C++ handler that is already surfaced:
//
//   SHIPPED (11):
//     reads  — foliage_capability_probe, foliage_list_types, foliage_type_inspect,
//              foliage_get_instance_count
//     writes — foliage_type_set_params (set-to-value), foliage_replace_mesh
//              (set-to-value)
//     non-idempotent — foliage_type_create (asset-create), foliage_add_instances
//              (append), foliage_scatter_paint (ground-traced append),
//              foliage_remove_in_bounds (bounded delete), foliage_clear_type
//              (destructive, confirm-gated)
//
//   SKIPPED (why):
//     - foliage_scatter_dry_run / foliage_density_heatmap / foliage_capture_compare
//       → render_camera / editor_capture_viewport / buffer-viz MIX tools; a
//       separate vision-loop effort (mirrors landscape_capture_topdown skip).
//     - foliage_scatter_on_mask → needs PLUMB / texture / vertex-colour mask
//       sampling infra not yet exposed to the stateless py-tool shape.
//     - foliage_scatter_by_slope_altitude → deferred scatter *variant*; the base
//       foliage_scatter_paint already ground-traces + reads the hit normal, so
//       slope/altitude filtering is a thin follow-up rather than net capability.
//     - foliage_select_in_bounds / foliage_batch_transform → require a persisted
//       selection_id working-set (session state); the py-tool factory handlers
//       are stateless. Deferred to a selection-aware surface.
//     - foliage_cull_distance_set_bulk → subsumed by foliage_type_set_params
//       (start/end cull are two of its knobs); a batch convenience, not net-new.
//     - proc_foliage_volume_create / proc_foliage_spawner_add_type /
//       proc_foliage_resimulate → AProceduralFoliageVolume + spawner authoring +
//       an async simulate/bake behind the job envelope; speculative python API +
//       pipeline concern, deferred.
//     - ism_actor_create / ism_add_instances → ALREADY surfaced as legacy C++
//       handlers (sidecar: ism_create_actor / ism_add_instances / ism_clear_
//       instances, all in tool-executor's NON_IDEMPOTENT set). Re-platforming
//       would only add drift; not re-implemented here.
//
//   OVERLAP with world_generate (the validated-scatter FLAGSHIP): world_generate
//   runs the PLUMB-validated procedural-scatter pipeline (constraint checks,
//   quantified validation, dry-run/commit). The tools HERE are direct
//   foliage-system AUTHORING — create a FoliageType asset, set its typed params,
//   push explicit or density-seeded transforms into the InstancedFoliageActor,
//   and remove within bounds. No validation layer, no constraint language: the
//   low-level verbs world_generate (and a human) build ON, not a competitor to it.
//
// UNCERTAIN-API flags for the next live-validation pass (all wrapped defensively
// so they degrade to a structured value/error/warning rather than a silent wrong
// answer):
//   - unreal.EditorFoliageLibrary method surface varies across 5.x — add_instances
//     / get_instance_transforms / remove_instances (and the world-first vs
//     type-first arg order) are all probed via _call() over candidate names;
//     degrade to a warning + skip when absent.
//   - FoliageType param property spellings (density, radius, scale_x/y/z as
//     FloatInterval, z_offset, align_to_normal, random_yaw, collision_with_world,
//     cast_shadow, cull_distance as Int32Interval) are set via _set() multi-name
//     probes; unknown keys are collected into unchanged_keys[] not silently lost.
//   - FoliageType_InstancedStaticMesh asset factory
//     (FoliageType_InstancedStaticMeshFactory vs AssetTools.create_asset) is
//     probed; mesh binding via set_editor_property("mesh"|"static_mesh").
//   - InstancedFoliageActor enumeration: iterate level actors for
//     InstancedFoliageActor, else EditorFoliageLibrary type listing; degrades to
//     an empty list with a warning.

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

// ── Shared Python: world + foliage-library + reflection helpers ────────────────
// A FoliageType is a UFoliageType asset (usually FoliageType_InstancedStaticMesh);
// its instances live in per-level AInstancedFoliageActor. We resolve the editor
// world, probe the EditorFoliageLibrary static surface by candidate name (its
// signature drifts across 5.x), and read/write FoliageType UPROPERTYs through the
// same _prop/_set multi-name defensive probe used by the landscape sibling.
const PY_FOLIAGE_HELPERS = [
  'def _world():',
  '    try: return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()',
  '    except Exception:',
  '        try: return unreal.EditorLevelLibrary.get_editor_world()',
  '        except Exception: return None',
  'def _eas():',
  '    return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
  'def _all_actors():',
  '    try: return _eas().get_all_level_actors()',
  '    except Exception: return []',
  'def _efl():',
  '    return getattr(unreal, "EditorFoliageLibrary", None)',
  'def _call(obj, names, *args):',
  '    for n in names:',
  '        fn = getattr(obj, n, None)',
  '        if fn is None: continue',
  '        try: return (True, fn(*args))',
  '        except Exception: pass',
  '    return (False, None)',
  'def _prop(o, *names):',
  '    for n in names:',
  '        try:',
  '            v = o.get_editor_property(n)',
  '            if v is not None: return v',
  '        except Exception: pass',
  '    return None',
  'def _set(o, value, *names):',
  '    for n in names:',
  '        try:',
  '            o.set_editor_property(n, value); return True',
  '        except Exception: pass',
  '    return False',
  'def _vec(v):',
  '    try: return [v.x, v.y, v.z]',
  '    except Exception: return None',
  'def _mesh_path(m):',
  '    try: return m.get_path_name() if m else None',
  '    except Exception: return None',
  'def _ft_mesh(ft):',
  '    return _prop(ft, "mesh", "static_mesh")',
  'def _load_ft(path):',
  '    ft = unreal.load_asset(path)',
  '    if ft is None: raise Exception("foliage type not found: %s" % path)',
  '    return ft',
  'def _interval(lo, hi):',
  '    for cn in ("FloatInterval",):',
  '        c = getattr(unreal, cn, None)',
  '        if c is not None:',
  '            try: return c(lo, hi)',
  '            except Exception: pass',
  '    return None',
  'def _int_interval(lo, hi):',
  '    c = getattr(unreal, "Int32Interval", None)',
  '    if c is not None:',
  '        try: return c(lo, hi)',
  '        except Exception: pass',
  '    return None',
  'def _xf(loc, rot, scale):',
  '    return unreal.Transform(unreal.Vector(loc[0], loc[1], loc[2]),',
  '                            unreal.Rotator(rot[0], rot[1], rot[2]),',
  '                            unreal.Vector(scale[0], scale[1], scale[2]))',
  'def _ifas():',
  '    out = []',
  '    for a in _all_actors():',
  '        try:',
  '            if isinstance(a, unreal.InstancedFoliageActor): out.append(a)',
  '        except Exception: pass',
  '    return out',
  'def _count_in_box(ft, box):',
  '    ok, xf = _call(_efl(), ["get_instance_transforms"], ft, box)',
  '    if ok and xf is not None:',
  '        try: return len(xf)',
  '        except Exception: return None',
  '    return None',
  'def _add_instances(ft, xforms):',
  '    efl = _efl()',
  '    w = _world()',
  '    ok, _ = _call(efl, ["add_instances"], w, ft, xforms)',
  '    if ok: return True',
  '    ok, _ = _call(efl, ["add_instances"], ft, xforms)',
  '    return ok',
].join('\n');

const readMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'inspecting foliage types/instances or probing foliage bindings before authoring or scattering (the read half of the inspect-then-edit loop)',
  not_when: 'you already hold a fresh read-back from a prior call',
};

const writeMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['mutates_actor'],
  when: 'editing a FoliageType asset property (density/scale/align/cull/mesh) and you want structured read-back in one call',
  not_when: 'running the PLUMB-validated procedural scatter — that is world_generate',
};

// ── foliage_capability_probe ──────────────────────────────────────────────────
export const foliageCapabilityProbeSchema = z.object({});
export type FoliageCapabilityProbeParams = z.infer<typeof foliageCapabilityProbeSchema>;

function capabilityProbeScript(_p: FoliageCapabilityProbeParams): string {
  return [
    PY_FOLIAGE_HELPERS,
    'try:',
    '    efl = _efl()',
    '    surface = []',
    '    for a in _all_actors():',
    '        try:',
    '            if isinstance(a, unreal.LandscapeProxy): surface.append({"label": a.get_actor_label(), "kind": "landscape"})',
    '            elif isinstance(a, unreal.StaticMeshActor): surface.append({"label": a.get_actor_label(), "kind": "static_mesh"})',
    '        except Exception: pass',
    '    try: ev = unreal.SystemLibrary.get_engine_version()',
    '    except Exception: ev = None',
    '    caps = {',
    '        "has_foliage_lib": efl is not None,',
    '        "has_add_instances": efl is not None and getattr(efl, "add_instances", None) is not None,',
    '        "has_get_instance_transforms": efl is not None and getattr(efl, "get_instance_transforms", None) is not None,',
    '        "has_remove_instances": efl is not None and getattr(efl, "remove_instances", None) is not None,',
    '        "has_proc_foliage": hasattr(unreal, "ProceduralFoliageVolume") or hasattr(unreal, "ProceduralFoliageSpawner"),',
    '        "has_hism": hasattr(unreal, "HierarchicalInstancedStaticMeshComponent"),',
    '        "has_foliage_type_ism": hasattr(unreal, "FoliageType_InstancedStaticMesh"),',
    '    }',
    '    _emit({"ok": True, "capabilities": caps, "engine_version": ev,',
    '           "surface_actors": surface[:50], "surface_actor_count": len(surface),',
    '           "instanced_foliage_actors": len(_ifas())})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const foliageCapabilityProbeDescriptor: PyToolDescriptor<typeof foliageCapabilityProbeSchema.shape> = {
  name: 'foliage_capability_probe',
  description:
    'Report which UE Python foliage bindings are available (EditorFoliageLibrary + add/get/remove instances, procedural-foliage, HISM, FoliageType_InstancedStaticMesh) plus the engine version and whether a Landscape/StaticMesh collision surface exists — the graceful-degradation gate to call BEFORE any scatter/author op.',
  cost: 'low',
  returns:
    '{ok, capabilities:{has_foliage_lib,has_add_instances,has_get_instance_transforms,has_remove_instances,has_proc_foliage,has_hism,has_foliage_type_ism}, engine_version, surface_actors:[{label,kind}], surface_actor_count, instanced_foliage_actors}',
  schema: foliageCapabilityProbeSchema.shape,
  meta: readMeta,
  buildScript: capabilityProbeScript,
  timeoutMs: 30_000,
};

// ── foliage_list_types ────────────────────────────────────────────────────────
export const foliageListTypesSchema = z.object({
  limit: z.number().int().positive().optional().default(50).describe('Max foliage types returned (pagination)'),
  offset: z.number().int().nonnegative().optional().default(0).describe('Pagination offset'),
});
export type FoliageListTypesParams = z.infer<typeof foliageListTypesSchema>;

function listTypesScript(p: FoliageListTypesParams): string {
  return [
    PY_FOLIAGE_HELPERS,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'try:',
    '    warnings = []',
    '    seen = {}',
    '    for ifa in _ifas():',
    '        ok, types = _call(ifa, ["get_used_foliage_types", "get_foliage_types"])',
    '        if not ok or types is None: continue',
    '        try:',
    '            for ft in types:',
    '                pth = ft.get_path_name()',
    '                if pth not in seen: seen[pth] = ft',
    '        except Exception: pass',
    '    if not seen:',
    '        warnings.append("no foliage types enumerable (empty level or API drift)")',
    '    items = list(seen.items())',
    '    total = len(items)',
    '    page = items[_offset:_offset+_limit]',
    '    out = []',
    '    for pth, ft in page:',
    '        cnt = _count_in_box(ft, None)',
    '        out.append({"path": pth, "class": type(ft).__name__, "mesh": _mesh_path(_ft_mesh(ft)),',
    '                    "density": _prop(ft, "density"), "radius": _prop(ft, "radius"),',
    '                    "instance_count": cnt})',
    '    _emit({"ok": True, "types": out, "total": total, "has_more": (_offset+_limit) < total,',
    '           "next_offset": _offset+_limit, "warnings": warnings})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const foliageListTypesDescriptor: PyToolDescriptor<typeof foliageListTypesSchema.shape> = {
  name: 'foliage_list_types',
  description:
    'Enumerate the foliage types used in the level (across all InstancedFoliageActors) with mesh path, density, radius and instance count. Paginated. The read entry point so agents stop guessing foliage type asset paths. UNCERTAIN-API: type enumeration is probed and degrades to [] + a warning.',
  cost: 'low',
  returns:
    '{ok, types:[{path,class,mesh,density,radius,instance_count}], total, has_more, next_offset, warnings[]}',
  schema: foliageListTypesSchema.shape,
  meta: readMeta,
  buildScript: listTypesScript,
  timeoutMs: 30_000,
};

// ── foliage_type_inspect ──────────────────────────────────────────────────────
export const foliageTypeInspectSchema = z.object({
  foliage_type_path: z.string().min(1).describe('Content path of the FoliageType asset, e.g. "/Game/Foliage/FT_Grass"'),
});
export type FoliageTypeInspectParams = z.infer<typeof foliageTypeInspectSchema>;

function typeInspectScript(p: FoliageTypeInspectParams): string {
  return [
    PY_FOLIAGE_HELPERS,
    `_path = ${pyStr(p.foliage_type_path)}`,
    'try:',
    '    ft = _load_ft(_path)',
    '    warnings = []',
    '    def _iv(v):',
    '        try: return {"min": v.min, "max": v.max}',
    '        except Exception: return None',
    '    params = {',
    '        "density": _prop(ft, "density"),',
    '        "radius": _prop(ft, "radius"),',
    '        "align_to_normal": _prop(ft, "align_to_normal"),',
    '        "random_yaw": _prop(ft, "random_yaw"),',
    '        "collision_with_world": _prop(ft, "collision_with_world"),',
    '        "cast_shadow": _prop(ft, "cast_shadow"),',
    '        "scale_x": _iv(_prop(ft, "scale_x")),',
    '        "scale_y": _iv(_prop(ft, "scale_y")),',
    '        "scale_z": _iv(_prop(ft, "scale_z")),',
    '        "z_offset": _iv(_prop(ft, "z_offset")),',
    '        "cull_distance": _iv(_prop(ft, "cull_distance")),',
    '    }',
    '    mesh = _ft_mesh(ft)',
    '    if mesh is None: warnings.append("no mesh bound on foliage type")',
    '    cnt = _count_in_box(ft, None)',
    '    _emit({"ok": True, "foliage_type_path": ft.get_path_name(), "class": type(ft).__name__,',
    '           "mesh_path": _mesh_path(mesh), "params": params, "instance_count": cnt, "warnings": warnings})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const foliageTypeInspectDescriptor: PyToolDescriptor<typeof foliageTypeInspectSchema.shape> = {
  name: 'foliage_type_inspect',
  description:
    'Read every authored param of a single FoliageType (density, radius, scale X/Y/Z intervals, z-offset, align-to-normal, random-yaw, collision, cast-shadow, cull distance) plus mesh path and instance count — the paired read for verify/diff before a foliage_type_set_params write.',
  cost: 'low',
  returns:
    '{ok, foliage_type_path, class, mesh_path, params:{density,radius,align_to_normal,random_yaw,collision_with_world,cast_shadow,scale_x,scale_y,scale_z,z_offset,cull_distance}, instance_count, warnings[]}',
  schema: foliageTypeInspectSchema.shape,
  meta: readMeta,
  buildScript: typeInspectScript,
  timeoutMs: 30_000,
};

// ── foliage_get_instance_count ────────────────────────────────────────────────
export const foliageGetInstanceCountSchema = z.object({
  foliage_type_path: z.string().min(1).describe('Content path of the FoliageType asset'),
});
export type FoliageGetInstanceCountParams = z.infer<typeof foliageGetInstanceCountSchema>;

function getInstanceCountScript(p: FoliageGetInstanceCountParams): string {
  return [
    PY_FOLIAGE_HELPERS,
    `_path = ${pyStr(p.foliage_type_path)}`,
    'try:',
    '    ft = _load_ft(_path)',
    '    cnt = _count_in_box(ft, None)',
    '    warnings = [] if cnt is not None else ["instance count unavailable (get_instance_transforms not exposed)"]',
    '    _emit({"ok": True, "foliage_type_path": ft.get_path_name(), "instance_count": cnt, "warnings": warnings})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const foliageGetInstanceCountDescriptor: PyToolDescriptor<typeof foliageGetInstanceCountSchema.shape> = {
  name: 'foliage_get_instance_count',
  description:
    'Return the number of placed instances of a foliage type across the level — the cheapest read to verify a scatter/add/remove landed. UNCERTAIN-API: degrades to null + a warning when instance introspection is not python-exposed.',
  cost: 'low',
  returns: '{ok, foliage_type_path, instance_count, warnings[]}',
  schema: foliageGetInstanceCountSchema.shape,
  meta: readMeta,
  buildScript: getInstanceCountScript,
  timeoutMs: 30_000,
};

// ── foliage_type_set_params ───────────────────────────────────────────────────
export const foliageTypeSetParamsSchema = z.object({
  foliage_type_path: z.string().min(1).describe('Content path of the FoliageType asset to edit'),
  density: z.number().nonnegative().optional().describe('Instances per 1000x1000 unit area (UFoliageType.Density)'),
  radius: z.number().nonnegative().optional().describe('Collision radius that prevents instances overlapping'),
  align_to_normal: z.boolean().optional().describe('Rotate instances to the ground normal'),
  random_yaw: z.boolean().optional().describe('Randomise yaw per instance'),
  collision_with_world: z.boolean().optional().describe('Enable per-instance world collision'),
  cast_shadow: z.boolean().optional().describe('Instances cast shadows'),
  scale_min: z.number().positive().optional().describe('Uniform scale range minimum (sets scale X/Y/Z min)'),
  scale_max: z.number().positive().optional().describe('Uniform scale range maximum (sets scale X/Y/Z max)'),
  cull_start: z.number().nonnegative().optional().describe('Cull distance start (fade begins)'),
  cull_end: z.number().nonnegative().optional().describe('Cull distance end (fully culled)'),
});
export type FoliageTypeSetParamsParams = z.infer<typeof foliageTypeSetParamsSchema>;

function typeSetParamsScript(p: FoliageTypeSetParamsParams): string {
  const num = (v: number | undefined): string => (v !== undefined ? String(v) : 'None');
  const bool = (v: boolean | undefined): string => (v === undefined ? 'None' : v ? 'True' : 'False');
  return [
    PY_FOLIAGE_HELPERS,
    `_path = ${pyStr(p.foliage_type_path)}`,
    `_density = ${num(p.density)}`,
    `_radius = ${num(p.radius)}`,
    `_align = ${bool(p.align_to_normal)}`,
    `_yaw = ${bool(p.random_yaw)}`,
    `_collision = ${bool(p.collision_with_world)}`,
    `_cast = ${bool(p.cast_shadow)}`,
    `_smin = ${num(p.scale_min)}`,
    `_smax = ${num(p.scale_max)}`,
    `_cstart = ${num(p.cull_start)}`,
    `_cend = ${num(p.cull_end)}`,
    'try:',
    '    provided = [x for x in [_density,_radius,_align,_yaw,_collision,_cast,_smin,_smax,_cstart,_cend] if x is not None]',
    '    if not provided: raise Exception("provide at least one param to set")',
    '    ft = _load_ft(_path)',
    '    changed = []',
    '    unchanged = []',
    '    def _apply(key, value, *names):',
    '        if value is None: return',
    '        if _set(ft, value, *names): changed.append(key)',
    '        else: unchanged.append(key)',
    '    _apply("density", _density, "density")',
    '    _apply("radius", _radius, "radius")',
    '    _apply("align_to_normal", _align, "align_to_normal")',
    '    _apply("random_yaw", _yaw, "random_yaw")',
    '    _apply("collision_with_world", _collision, "collision_with_world")',
    '    _apply("cast_shadow", _cast, "cast_shadow")',
    '    if _smin is not None or _smax is not None:',
    '        lo = _smin if _smin is not None else 1.0',
    '        hi = _smax if _smax is not None else (lo if _smin is not None else 1.0)',
    '        iv = _interval(lo, hi)',
    '        if iv is not None:',
    '            for ax in ("scale_x", "scale_y", "scale_z"):',
    '                if _set(ft, iv, ax): changed.append(ax)',
    '                else: unchanged.append(ax)',
    '        else: unchanged.append("scale")',
    '    if _cstart is not None or _cend is not None:',
    '        cur = _prop(ft, "cull_distance")',
    '        lo = int(_cstart) if _cstart is not None else (int(cur.min) if cur is not None else 0)',
    '        hi = int(_cend) if _cend is not None else (int(cur.max) if cur is not None else 0)',
    '        iv = _int_interval(lo, hi)',
    '        if iv is not None and _set(ft, iv, "cull_distance"): changed.append("cull_distance")',
    '        else: unchanged.append("cull_distance")',
    '    try: unreal.EditorAssetLibrary.save_loaded_asset(ft)',
    '    except Exception: pass',
    '    _emit({"ok": True, "foliage_type_path": ft.get_path_name(), "changed_keys": changed,',
    '           "unchanged_keys": unchanged})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const foliageTypeSetParamsDescriptor: PyToolDescriptor<typeof foliageTypeSetParamsSchema.shape> = {
  name: 'foliage_type_set_params',
  description:
    'Set the core authoring knobs on a FoliageType — density, radius, scale range (X/Y/Z), align-to-normal, random-yaw, world collision, cast-shadow, and cull start/end — then save + read back which keys changed. Set-to-value (retry-safe); omitted fields untouched. UNCERTAIN-API: unknown property spellings land in unchanged_keys[] rather than being silently lost.',
  cost: 'low',
  returns: '{ok, foliage_type_path, changed_keys[], unchanged_keys[]}',
  schema: foliageTypeSetParamsSchema.shape,
  meta: writeMeta,
  buildScript: typeSetParamsScript,
  timeoutMs: 30_000,
};

// ── foliage_replace_mesh ──────────────────────────────────────────────────────
export const foliageReplaceMeshSchema = z.object({
  foliage_type_path: z.string().min(1).describe('Content path of the FoliageType asset to re-mesh'),
  new_mesh_path: z.string().min(1).describe('Content path of the StaticMesh to bind, e.g. "/Game/Meshes/SM_Rock"'),
});
export type FoliageReplaceMeshParams = z.infer<typeof foliageReplaceMeshSchema>;

function replaceMeshScript(p: FoliageReplaceMeshParams): string {
  return [
    PY_FOLIAGE_HELPERS,
    `_path = ${pyStr(p.foliage_type_path)}`,
    `_mesh = ${pyStr(p.new_mesh_path)}`,
    'try:',
    '    ft = _load_ft(_path)',
    '    mesh = unreal.load_asset(_mesh)',
    '    if mesh is None: raise Exception("static mesh not found: %s" % _mesh)',
    '    if not _set(ft, mesh, "mesh", "static_mesh"): raise Exception("could not set mesh on foliage type")',
    '    try: unreal.EditorAssetLibrary.save_loaded_asset(ft)',
    '    except Exception: pass',
    '    _emit({"ok": True, "foliage_type_path": ft.get_path_name(), "assigned_mesh": _mesh,',
    '           "readback": _mesh_path(_ft_mesh(ft))})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const foliageReplaceMeshDescriptor: PyToolDescriptor<typeof foliageReplaceMeshSchema.shape> = {
  name: 'foliage_replace_mesh',
  description:
    'Swap the StaticMesh bound to a FoliageType (bulk re-theming — every existing instance re-renders with the new mesh) and read the binding back. Set-to-value (retry-safe).',
  cost: 'low',
  returns: '{ok, foliage_type_path, assigned_mesh, readback}',
  schema: foliageReplaceMeshSchema.shape,
  meta: writeMeta,
  buildScript: replaceMeshScript,
  timeoutMs: 30_000,
};

// ── foliage_type_create ───────────────────────────────────────────────────────
export const foliageTypeCreateSchema = z.object({
  static_mesh_path: z.string().min(1).describe('Content path of the source StaticMesh, e.g. "/Game/Meshes/SM_Tree"'),
  dest_path: z.string().min(1).describe('Destination folder for the new FoliageType asset, e.g. "/Game/Foliage"'),
  name: z.string().min(1).describe('Asset name for the new FoliageType, e.g. "FT_Tree"'),
  density: z.number().nonnegative().optional().describe('Optional initial density'),
});
export type FoliageTypeCreateParams = z.infer<typeof foliageTypeCreateSchema>;

function typeCreateScript(p: FoliageTypeCreateParams): string {
  return [
    PY_FOLIAGE_HELPERS,
    `_mesh = ${pyStr(p.static_mesh_path)}`,
    `_dest = ${pyStr(p.dest_path)}`,
    `_name = ${pyStr(p.name)}`,
    `_density = ${p.density !== undefined ? String(p.density) : 'None'}`,
    'try:',
    '    mesh = unreal.load_asset(_mesh)',
    '    if mesh is None: raise Exception("static mesh not found: %s" % _mesh)',
    '    full = _dest.rstrip("/") + "/" + _name',
    '    existing = unreal.load_asset(full)',
    '    created = False',
    '    if existing is not None:',
    '        ft = existing',
    '    else:',
    '        tools = unreal.AssetToolsHelpers.get_asset_tools()',
    '        factory = None',
    '        for fn in ("FoliageType_InstancedStaticMeshFactory", "FoliageTypeFactory"):',
    '            fc = getattr(unreal, fn, None)',
    '            if fc is not None:',
    '                try: factory = fc()',
    '                except Exception: factory = None',
    '            if factory is not None: break',
    '        cls = getattr(unreal, "FoliageType_InstancedStaticMesh", None)',
    '        if factory is None or cls is None: raise Exception("FoliageType factory/class not python-exposed")',
    '        ft = tools.create_asset(_name, _dest.rstrip("/"), cls, factory)',
    '        created = True',
    '    if ft is None: raise Exception("could not create/load foliage type: %s" % full)',
    '    _set(ft, mesh, "mesh", "static_mesh")',
    '    if _density is not None: _set(ft, _density, "density")',
    '    try: unreal.EditorAssetLibrary.save_loaded_asset(ft)',
    '    except Exception: pass',
    '    _emit({"ok": True, "foliage_type_path": ft.get_path_name(), "created": created,',
    '           "mesh": _mesh_path(_ft_mesh(ft))})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const foliageTypeCreateDescriptor: PyToolDescriptor<typeof foliageTypeCreateSchema.shape> = {
  name: 'foliage_type_create',
  description:
    'Create (or reuse if present) a FoliageType_InstancedStaticMesh asset from a StaticMesh with optional initial density — the entry point for all foliage authoring. Reuses an existing asset at the path (retry-safe read-back) but is classified NON-IDEMPOTENT as an asset-create lifecycle op. UNCERTAIN-API: FoliageType factory/class is probed and errors clearly when not python-exposed.',
  cost: 'medium',
  returns: '{ok, foliage_type_path, created, mesh}',
  schema: foliageTypeCreateSchema.shape,
  meta: { ...writeMeta, cost: 'medium', effects: ['creates_asset'] },
  buildScript: typeCreateScript,
  timeoutMs: 30_000,
};

// ── foliage_add_instances ─────────────────────────────────────────────────────
const transformSchema = z.object({
  location: z.array(z.number()).length(3).describe('[x,y,z] world location'),
  rotation: z.array(z.number()).length(3).optional().describe('[roll,pitch,yaw] rotation (default [0,0,0])'),
  scale: z.array(z.number()).length(3).optional().describe('[x,y,z] scale (default [1,1,1])'),
});
export const foliageAddInstancesSchema = z.object({
  foliage_type_path: z.string().min(1).describe('Content path of the FoliageType asset'),
  transforms: z.array(transformSchema).min(1).describe('Explicit world transforms to place'),
  chunk_size: z.number().int().positive().optional().default(2000).describe('Instances per add call (game-thread freeze guard)'),
});
export type FoliageAddInstancesParams = z.infer<typeof foliageAddInstancesSchema>;

function addInstancesScript(p: FoliageAddInstancesParams): string {
  const norm = p.transforms.map((t) => ({
    location: t.location,
    rotation: t.rotation ?? [0, 0, 0],
    scale: t.scale ?? [1, 1, 1],
  }));
  return [
    PY_FOLIAGE_HELPERS,
    `_path = ${pyStr(p.foliage_type_path)}`,
    `_raw = ${JSON.stringify(norm)}`,
    `_chunk = ${p.chunk_size}`,
    'try:',
    '    ft = _load_ft(_path)',
    '    if _efl() is None or getattr(_efl(), "add_instances", None) is None:',
    '        raise Exception("EditorFoliageLibrary.add_instances not python-exposed")',
    '    before = _count_in_box(ft, None)',
    '    added = 0',
    '    i = 0',
    '    while i < len(_raw):',
    '        batch = _raw[i:i+_chunk]',
    '        xforms = [_xf(t["location"], t["rotation"], t["scale"]) for t in batch]',
    '        if not _add_instances(ft, xforms): raise Exception("add_instances failed at offset %d" % i)',
    '        added += len(batch)',
    '        i += _chunk',
    '    after = _count_in_box(ft, None)',
    '    _emit({"ok": True, "foliage_type_path": ft.get_path_name(), "added": added,',
    '           "instance_count": after, "count_before": before})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const foliageAddInstancesDescriptor: PyToolDescriptor<typeof foliageAddInstancesSchema.shape> = {
  name: 'foliage_add_instances',
  description:
    'Bulk-add explicit world transforms for a foliage type via EditorFoliageLibrary.add_instances, chunked to avoid a game-thread freeze — the direct authoring verb (fixes the historic silent C++ add stub). NON-IDEMPOTENT (append). UNCERTAIN-API: errors clearly when add_instances is not python-exposed.',
  cost: 'medium',
  returns: '{ok, foliage_type_path, added, instance_count, count_before}',
  schema: foliageAddInstancesSchema.shape,
  meta: { ...writeMeta, cost: 'medium', effects: ['mutates_actor'] },
  buildScript: addInstancesScript,
  timeoutMs: 60_000,
};

// ── foliage_scatter_paint ─────────────────────────────────────────────────────
export const foliageScatterPaintSchema = z.object({
  foliage_type_path: z.string().min(1).describe('Content path of the FoliageType asset'),
  center: z.array(z.number()).length(3).describe('[x,y,z] world center of the scatter region'),
  radius: z.number().positive().describe('Scatter radius in world units (circular footprint)'),
  density_per_100m2: z.number().positive().describe('Target instances per 100x100 unit cell (drives candidate count)'),
  seed: z.number().int().optional().default(1337).describe('Deterministic RNG seed'),
  scale_min: z.number().positive().optional().default(1).describe('Per-instance uniform scale minimum'),
  scale_max: z.number().positive().optional().default(1).describe('Per-instance uniform scale maximum'),
  align_normal: z.boolean().optional().default(false).describe('Align instances to the ground-hit normal'),
  trace_height: z.number().positive().optional().default(100000).describe('How far above center to start the downward ground trace'),
});
export type FoliageScatterPaintParams = z.infer<typeof foliageScatterPaintSchema>;

function scatterPaintScript(p: FoliageScatterPaintParams): string {
  return [
    PY_FOLIAGE_HELPERS,
    'import math, random',
    `_path = ${pyStr(p.foliage_type_path)}`,
    `_c = ${JSON.stringify(p.center)}`,
    `_radius = ${p.radius}`,
    `_dens = ${p.density_per_100m2}`,
    `_seed = ${p.seed}`,
    `_smin = ${p.scale_min}`,
    `_smax = ${p.scale_max}`,
    `_align = ${p.align_normal ? 'True' : 'False'}`,
    `_th = ${p.trace_height}`,
    'try:',
    '    ft = _load_ft(_path)',
    '    if _efl() is None or getattr(_efl(), "add_instances", None) is None:',
    '        raise Exception("EditorFoliageLibrary.add_instances not python-exposed")',
    '    area_cells = (math.pi * _radius * _radius) / (100.0 * 100.0)',
    '    n = max(1, int(area_cells * _dens))',
    '    rng = random.Random(_seed)',
    '    xforms = []',
    '    skipped = 0',
    '    for _ in range(n):',
    '        ang = rng.random() * 2.0 * math.pi',
    '        r = _radius * math.sqrt(rng.random())',
    '        x = _c[0] + r * math.cos(ang)',
    '        y = _c[1] + r * math.sin(ang)',
    '        start = unreal.Vector(x, y, _c[2] + _th)',
    '        end = unreal.Vector(x, y, _c[2] - _th)',
    '        hit = unreal.SystemLibrary.line_trace_single(_world(), start, end,',
    '              unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, False, [], unreal.DrawDebugTrace.NONE, True)',
    '        if isinstance(hit, tuple): ok_hit, hr = hit[0], hit[1]',
    '        else: ok_hit, hr = bool(hit), hit',
    '        if not ok_hit: skipped += 1; continue',
    '        try: imp = hr.impact_point',
    '        except Exception: imp = hr.to_tuple()[4]',
    '        rot = [0.0, 0.0, rng.random() * 360.0]',
    '        if _align:',
    '            try:',
    '                nrm = hr.impact_normal',
    '                rq = unreal.MathLibrary.make_rot_from_z(nrm)',
    '                rot = [rq.roll, rq.pitch, rng.random() * 360.0]',
    '            except Exception: pass',
    '        s = _smin + rng.random() * (_smax - _smin)',
    '        xforms.append(_xf([imp.x, imp.y, imp.z], rot, [s, s, s]))',
    '    painted = 0',
    '    if xforms:',
    '        if not _add_instances(ft, xforms): raise Exception("add_instances failed during scatter")',
    '        painted = len(xforms)',
    '    _emit({"ok": True, "foliage_type_path": ft.get_path_name(), "painted": painted,',
    '           "skipped_no_hit": skipped, "candidates": n, "seed": _seed,',
    '           "instance_count": _count_in_box(ft, None)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const foliageScatterPaintDescriptor: PyToolDescriptor<typeof foliageScatterPaintSchema.shape> = {
  name: 'foliage_scatter_paint',
  description:
    'Deterministic area scatter: ground-trace downward onto landscape/collision inside a circular radius at a target density, with per-instance yaw + uniform-scale jitter and optional align-to-normal, then commit via add_instances. Same seed → same placement. NON-IDEMPOTENT (append). This is the low-level authoring verb, NOT the PLUMB-validated world_generate flagship. UNCERTAIN-API: needs a collision surface (see foliage_capability_probe.surface_actors) and add_instances exposure.',
  cost: 'medium',
  returns: '{ok, foliage_type_path, painted, skipped_no_hit, candidates, seed, instance_count}',
  schema: foliageScatterPaintSchema.shape,
  meta: { ...writeMeta, cost: 'medium', effects: ['mutates_actor'] },
  buildScript: scatterPaintScript,
  timeoutMs: 120_000,
};

// ── foliage_remove_in_bounds ──────────────────────────────────────────────────
export const foliageRemoveInBoundsSchema = z.object({
  foliage_type_path: z.string().min(1).describe('Content path of the FoliageType asset'),
  center: z.array(z.number()).length(3).describe('[x,y,z] world center of the removal box'),
  extent: z.array(z.number()).length(3).describe('[x,y,z] half-extent of the removal box'),
});
export type FoliageRemoveInBoundsParams = z.infer<typeof foliageRemoveInBoundsSchema>;

function removeInBoundsScript(p: FoliageRemoveInBoundsParams): string {
  return [
    PY_FOLIAGE_HELPERS,
    `_path = ${pyStr(p.foliage_type_path)}`,
    `_c = ${JSON.stringify(p.center)}`,
    `_e = ${JSON.stringify(p.extent)}`,
    'try:',
    '    ft = _load_ft(_path)',
    '    box = None',
    '    bc = getattr(unreal, "Box", None)',
    '    if bc is not None:',
    '        try: box = bc(unreal.Vector(_c[0]-_e[0], _c[1]-_e[1], _c[2]-_e[2]), unreal.Vector(_c[0]+_e[0], _c[1]+_e[1], _c[2]+_e[2]))',
    '        except Exception: box = None',
    '    before = _count_in_box(ft, None)',
    '    okc, _ = _call(_efl(), ["remove_instances"], _world(), ft, box)',
    '    if not okc: raise Exception("EditorFoliageLibrary.remove_instances not python-exposed / failed")',
    '    after = _count_in_box(ft, None)',
    '    removed = (before - after) if (before is not None and after is not None) else None',
    '    _emit({"ok": True, "foliage_type_path": ft.get_path_name(), "removed": removed,',
    '           "count_before": before, "instance_count": after})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const foliageRemoveInBoundsDescriptor: PyToolDescriptor<typeof foliageRemoveInBoundsSchema.shape> = {
  name: 'foliage_remove_in_bounds',
  description:
    'Remove instances of a foliage type inside an axis-aligned box (center + half-extent) and return the delta count. NON-IDEMPOTENT (delete). UNCERTAIN-API: EditorFoliageLibrary.remove_instances signature/box arg is probed and errors clearly when unavailable.',
  cost: 'medium',
  returns: '{ok, foliage_type_path, removed, count_before, instance_count}',
  schema: foliageRemoveInBoundsSchema.shape,
  meta: { ...writeMeta, cost: 'medium', effects: ['mutates_actor'] },
  buildScript: removeInBoundsScript,
  timeoutMs: 60_000,
};

// ── foliage_clear_type ────────────────────────────────────────────────────────
export const foliageClearTypeSchema = z.object({
  foliage_type_path: z.string().min(1).describe('Content path of the FoliageType asset'),
  confirm: z.literal(true).describe('Must be true — this removes ALL instances of the type (destructive)'),
});
export type FoliageClearTypeParams = z.infer<typeof foliageClearTypeSchema>;

function clearTypeScript(p: FoliageClearTypeParams): string {
  return [
    PY_FOLIAGE_HELPERS,
    `_path = ${pyStr(p.foliage_type_path)}`,
    'try:',
    '    ft = _load_ft(_path)',
    '    before = _count_in_box(ft, None)',
    '    okc, _ = _call(_efl(), ["remove_instances"], _world(), ft, None)',
    '    if not okc: raise Exception("EditorFoliageLibrary.remove_instances not python-exposed / failed")',
    '    after = _count_in_box(ft, None)',
    '    removed = (before - after) if (before is not None and after is not None) else None',
    '    _emit({"ok": True, "foliage_type_path": ft.get_path_name(), "removed": removed,',
    '           "count_before": before, "instance_count": after})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const foliageClearTypeDescriptor: PyToolDescriptor<typeof foliageClearTypeSchema.shape> = {
  name: 'foliage_clear_type',
  description:
    'Remove ALL instances of a foliage type from the level (destructive, one-undo, requires confirm:true). NON-IDEMPOTENT. UNCERTAIN-API: routes through EditorFoliageLibrary.remove_instances with a null box (all-instances) and errors clearly when unavailable.',
  cost: 'medium',
  returns: '{ok, foliage_type_path, removed, count_before, instance_count}',
  schema: foliageClearTypeSchema.shape,
  meta: { ...writeMeta, cost: 'medium', effects: ['mutates_actor'] },
  buildScript: clearTypeScript,
  timeoutMs: 60_000,
};

// ── Aggregate: all foliage-domain PyToolDescriptors (spliced in index.ts) ──────
export const foliagePyDescriptors: PyToolDescriptor[] = [
  foliageCapabilityProbeDescriptor,
  foliageListTypesDescriptor,
  foliageTypeInspectDescriptor,
  foliageGetInstanceCountDescriptor,
  foliageTypeSetParamsDescriptor,
  foliageReplaceMeshDescriptor,
  foliageTypeCreateDescriptor,
  foliageAddInstancesDescriptor,
  foliageScatterPaintDescriptor,
  foliageRemoveInBoundsDescriptor,
  foliageClearTypeDescriptor,
] as unknown as PyToolDescriptor[];

/** Names of foliage-domain factory tools that are non-idempotent (asset-create,
 *  append, or delete). Mirrors LANDSCAPE_NON_IDEMPOTENT; added to tool-executor's
 *  NON_IDEMPOTENT set so the transport-retry gate skips them. */
export const FOLIAGE_NON_IDEMPOTENT: readonly string[] = [
  foliageTypeCreateDescriptor.name,
  foliageAddInstancesDescriptor.name,
  foliageScatterPaintDescriptor.name,
  foliageRemoveInBoundsDescriptor.name,
  foliageClearTypeDescriptor.name,
];
