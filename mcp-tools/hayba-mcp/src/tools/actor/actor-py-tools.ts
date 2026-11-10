// Actor-domain P0 tools, generated as UE Python via the pyTemplate factory.
//
// These are the first net-new *breadth* tools shipped through the factory
// pipeline (see py-tool-factory.ts). Each is a PyToolDescriptor: zod schema +
// buildScript(params) emitting a single HAYBA_JSON line via _emit/_err, adapted
// into STANDARD_DESCRIPTORS through toToolDescriptor in index.ts.
//
// OVERLAP: the legacy sidecar already surfaces actor_get_properties /
// actor_set_properties / actor_get_components / actor_call_function /
// actor_duplicate / actor_tag / actor_set_visibility / actor_snap_to_socket /
// actor_batch_spawn, and hand-written descriptors cover actor_spawn / actor_list
// / actor_delete / actor_transform. The tools here are strictly NET-NEW:
// richer read-back (inspect), query (find), selection r/w, asset-path spawn,
// batched transform, viewport focus, and outliner-folder organisation.
//
// Validated UE 5.7 accessor idioms (see MEMORY + pcg-primitives.ts):
//   unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
//   eas.get_all_level_actors(); actor.get_actor_label(); actor.get_path_name()
//   actor.get_components_by_class(...); get/set_editor_property reflection.

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

// ── Shared Python: resolve a level actor by label (exact) or full path ────────
// Every actor tool accepts an `actor_id` that is either the editor label
// (get_actor_label, the human-readable outliner name) or the full path
// (get_path_name). We match label first (exact), then path, then a unique
// label-substring — mirroring the PCG node-resolver's exact→substring policy.
// ROTATOR CONVENTION — this file uses [roll, pitch, yaw] because that is UE
// python's TRUE positional signature for unreal.Rotator(roll, pitch, yaw) and
// set_actor_rotation. This is DIFFERENT from render-camera.ts and the legacy
// sidecar, which use [pitch, yaw, roll] (the C++ FRotator field order). Do NOT
// cross-copy rotation arrays between these files — the components will be
// silently transposed (roll↔pitch), tilting/mis-aiming actors. Convert
// explicitly at the boundary.
// No try/with in this block: native python_run policy HCR-TIME-001 refuses them,
// so _find_actor returns (actor, None) | (None, error) for explicit status.
// _resolve_actor keeps the raising contract for tools that still catch it.
const PY_ACTOR_HELPERS = [
  'def _eas():',
  '    return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
  'def _all_actors():',
  '    return _eas().get_all_level_actors()',
  'def _find_actor(ref):',
  '    acts = _all_actors()',
  '    for a in acts:',
  '        if a.get_actor_label() == ref or a.get_path_name() == ref:',
  '            return a, None',
  '    sub = [a for a in acts if ref in a.get_actor_label()]',
  '    if len(sub) == 1: return sub[0], None',
  '    if len(sub) > 1: return None, "ambiguous actor ref %r matches %d actors" % (ref, len(sub))',
  '    return None, "actor not found: %s" % ref',
  'def _resolve_actor(ref):',
  '    a, msg = _find_actor(ref)',
  '    if a is None: raise Exception(msg)',
  '    return a',
  'def _vec(v):',
  '    return [v.x, v.y, v.z]',
  'def _xform(a):',
  '    t = a.get_actor_transform()',
  '    r = a.get_actor_rotation()',
  '    return {"location": _vec(t.translation), "rotation": [r.roll, r.pitch, r.yaw], "scale": _vec(t.scale3d)}',
].join('\n');

const readMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'inspecting or querying level actors before a write (the read half of the inspect-then-edit loop)',
  not_when: 'you already hold a fresh read-back from a prior call',
};

const writeMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['mutates_actor'],
  when: 'editing actors in the active level and you want structured before/after read-back in one call',
  not_when: 'authoring an asset on disk — use the asset/material/pcg tools',
};

// ── actor_inspect ─────────────────────────────────────────────────────────────
export const actorInspectSchema = z.object({
  actor_id: z.string().min(1).describe('Actor label (outliner name) or full path'),
});
export type ActorInspectParams = z.infer<typeof actorInspectSchema>;

function inspectScript(p: ActorInspectParams): string {
  return [
    PY_ACTOR_HELPERS,
    `_ref = ${pyStr(p.actor_id)}`,
    'a, _msg = _find_actor(_ref)',
    'if a is None:',
    '    _err(_msg)',
    'else:',
    '    comps = [{"class": type(c).__name__, "name": c.get_name()} for c in a.get_components_by_class(unreal.ActorComponent)]',
    '    mats = []',
    '    for smc in a.get_components_by_class(unreal.StaticMeshComponent):',
    '        for i in range(smc.get_num_materials()):',
    '            m = smc.get_material(i)',
    '            mats.append({"component": smc.get_name(), "slot": i, "material": (m.get_path_name() if m else None)})',
    '    origin, ext = a.get_actor_bounds(False)',
    '    bounds = {"origin": _vec(origin), "extent": _vec(ext)}',
    '    pa = a.get_attach_parent_actor()',
    '    parent = pa.get_actor_label() if pa else None',
    '    folder = str(a.get_folder_path())',
    '    tags = [str(t) for t in a.tags]',
    '    _emit({"ok": True, "actor_id": a.get_actor_label(), "path": a.get_path_name(),',
    '           "class": type(a).__name__, "transform": _xform(a), "bounds": bounds,',
    '           "components": comps, "material_slots": mats, "tags": tags,',
    '           "folder": folder, "attach_parent": parent})',
  ].join('\n');
}

export const actorInspectDescriptor: PyToolDescriptor<typeof actorInspectSchema.shape> = {
  name: 'actor_inspect',
  description:
    'Full read-back of a level actor: class, transform, bounds, components, material slots, tags, outliner folder, attach parent. The inspection half of the inspect-then-edit loop.',
  cost: 'low',
  returns:
    '{ok, actor_id, path, class, transform:{location,rotation,scale}, bounds:{origin,extent}, components:[{class,name}], material_slots:[{component,slot,material}], tags[], folder, attach_parent}',
  schema: actorInspectSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: inspectScript,
  timeoutMs: 30_000,
};

// ── actor_find ────────────────────────────────────────────────────────────────
export const actorFindSchema = z.object({
  label_contains: z.string().optional().describe('Case-insensitive substring match on the actor label'),
  class_name: z.string().optional().describe('Exact class name filter, e.g. "StaticMeshActor"'),
  tag: z.string().optional().describe('Exact actor tag filter'),
  near: z.array(z.number()).length(3).optional().describe('[x,y,z] centre for a spatial radius filter'),
  radius_cm: z.number().positive().optional().describe('Radius in cm around `near` (requires `near`)'),
  limit: z.number().int().positive().optional().default(100).describe('Max actors returned (pagination)'),
  offset: z.number().int().nonnegative().optional().default(0).describe('Pagination offset'),
});
export type ActorFindParams = z.infer<typeof actorFindSchema>;

function findScript(p: ActorFindParams): string {
  return [
    PY_ACTOR_HELPERS,
    `_label = ${p.label_contains !== undefined ? pyStr(p.label_contains) : 'None'}`,
    `_cls = ${p.class_name !== undefined ? pyStr(p.class_name) : 'None'}`,
    `_tag = ${p.tag !== undefined ? pyStr(p.tag) : 'None'}`,
    `_near = ${p.near !== undefined ? JSON.stringify(p.near) : 'None'}`,
    `_radius = ${p.radius_cm !== undefined ? String(p.radius_cm) : 'None'}`,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'matched = []',
    'for a in _all_actors():',
    '    lbl = a.get_actor_label()',
    '    if _label is not None and _label.lower() not in lbl.lower(): continue',
    '    if _cls is not None and type(a).__name__ != _cls: continue',
    '    if _tag is not None and (unreal.Name(_tag) not in a.tags): continue',
    '    if _near is not None and _radius is not None:',
    '        loc = a.get_actor_location()',
    '        dx = loc.x - _near[0]; dy = loc.y - _near[1]; dz = loc.z - _near[2]',
    '        if (dx*dx + dy*dy + dz*dz) > (_radius*_radius): continue',
    '    matched.append(a)',
    'total = len(matched)',
    'page = matched[_offset:_offset+_limit]',
    'out = [{"actor_id": a.get_actor_label(), "path": a.get_path_name(),',
    '        "class": type(a).__name__, "location": _vec(a.get_actor_location())} for a in page]',
    '_emit({"ok": True, "actors": out, "total": total, "has_more": (_offset+_limit) < total})',
  ].join('\n');
}

export const actorFindDescriptor: PyToolDescriptor<typeof actorFindSchema.shape> = {
  name: 'actor_find',
  description:
    'Query level actors by label substring, exact class, tag, and/or a spatial radius around a point. Paginated. Returns {actors[], total, has_more}.',
  cost: 'low',
  returns: '{ok, actors:[{actor_id,path,class,location}], total, has_more}',
  schema: actorFindSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: findScript,
  timeoutMs: 30_000,
};

// ── actor_get_selection ───────────────────────────────────────────────────────
export const actorGetSelectionSchema = z.object({});
export type ActorGetSelectionParams = z.infer<typeof actorGetSelectionSchema>;

function getSelectionScript(_p: ActorGetSelectionParams): string {
  return [
    PY_ACTOR_HELPERS,
    'sel = _eas().get_selected_level_actors()',
    'out = [{"actor_id": a.get_actor_label(), "path": a.get_path_name(), "class": type(a).__name__} for a in sel]',
    '_emit({"ok": True, "actors": out, "count": len(out)})',
  ].join('\n');
}

export const actorGetSelectionDescriptor: PyToolDescriptor<typeof actorGetSelectionSchema.shape> = {
  name: 'actor_get_selection',
  description: 'Read the current editor actor selection.',
  cost: 'low',
  returns: '{ok, actors:[{actor_id,path,class}], count}',
  schema: actorGetSelectionSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: getSelectionScript,
  timeoutMs: 30_000,
};

// ── actor_set_selection ───────────────────────────────────────────────────────
export const actorSetSelectionSchema = z.object({
  actor_ids: z.array(z.string().min(1)).describe('Actor labels or full paths to select (replaces the current selection)'),
});
export type ActorSetSelectionParams = z.infer<typeof actorSetSelectionSchema>;

function setSelectionScript(p: ActorSetSelectionParams): string {
  return [
    PY_ACTOR_HELPERS,
    `_refs = ${JSON.stringify(p.actor_ids)}`,
    'eas = _eas()',
    'eas.select_nothing()',
    'selected = []',
    'missing = []',
    'for ref in _refs:',
    '    a, _msg = _find_actor(ref)',
    '    if a is None:',
    '        missing.append(ref)',
    '        continue',
    '    eas.set_actor_selection_state(a, True)',
    '    selected.append(a.get_actor_label())',
    '_emit({"ok": len(missing) == 0, "selected": selected, "missing": missing, "count": len(selected)})',
  ].join('\n');
}

export const actorSetSelectionDescriptor: PyToolDescriptor<typeof actorSetSelectionSchema.shape> = {
  name: 'actor_set_selection',
  description: 'Replace the editor actor selection with the given actors (by label or path). Returns the resolved selection + any unresolved ids.',
  cost: 'low',
  returns: '{ok, selected[], missing[], count}',
  schema: actorSetSelectionSchema.shape,
  meta: writeMeta,
  buildScript: setSelectionScript,
  timeoutMs: 30_000,
};

// ── actor_spawn_from_asset ────────────────────────────────────────────────────
export const actorSpawnFromAssetSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of a StaticMesh or Blueprint asset, e.g. "/Game/Meshes/SM_Rock"'),
  location: z.array(z.number()).length(3).optional().describe('[x,y,z] spawn location (default [0,0,0])'),
  rotation: z.array(z.number()).length(3).optional().describe('[roll,pitch,yaw] spawn rotation (default [0,0,0])'),
  label: z.string().optional().describe('Optional actor label'),
  snap_to_floor: z.boolean().optional().default(false).describe('Line-trace straight down from the spawn point and seat the actor on the first hit'),
});
export type ActorSpawnFromAssetParams = z.infer<typeof actorSpawnFromAssetSchema>;

function spawnFromAssetScript(p: ActorSpawnFromAssetParams): string {
  const loc = p.location ?? [0, 0, 0];
  const rot = p.rotation ?? [0, 0, 0];
  return [
    PY_ACTOR_HELPERS,
    `_asset_path = ${pyStr(p.asset_path)}`,
    `_loc = ${JSON.stringify(loc)}`,
    `_rot = ${JSON.stringify(rot)}`,
    `_label = ${p.label !== undefined ? pyStr(p.label) : 'None'}`,
    `_snap = ${p.snap_to_floor ? 'True' : 'False'}`,
    'asset = unreal.load_asset(_asset_path)',
    'actor = None',
    '_msg = "asset not found: %s" % _asset_path',
    'if asset is not None:',
    '    loc = unreal.Vector(_loc[0], _loc[1], _loc[2])',
    '    rot = unreal.Rotator(_rot[0], _rot[1], _rot[2])',
    '    if _snap:',
    '        # Trace BEFORE spawning: with no try/except, a trace failure must not leave a stray actor.',
    '        world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()',
    '        end = unreal.Vector(loc.x, loc.y, loc.z - 1000000.0)',
    '        hit = unreal.SystemLibrary.line_trace_single(world, loc, end,',
    '              unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, False, [], unreal.DrawDebugTrace.NONE, True)',
    '        if isinstance(hit, tuple): ok_hit, hr = hit[0], hit[1]',
    '        else: ok_hit, hr = bool(hit), hit',
    '        if ok_hit:',
    '            loc = hr.to_tuple()[4] if hasattr(hr, "to_tuple") else hr.impact_point',
    '    actor = _eas().spawn_actor_from_object(asset, loc, rot)',
    '    _msg = "spawn failed for %s" % _asset_path',
    'if actor is None:',
    '    _err(_msg)',
    'else:',
    '    if _label is not None: actor.set_actor_label(_label)',
    '    _emit({"ok": True, "actor_id": actor.get_actor_label(), "path": actor.get_path_name(),',
    '           "class": type(actor).__name__, "transform": _xform(actor)})',
  ].join('\n');
}

export const actorSpawnFromAssetDescriptor: PyToolDescriptor<typeof actorSpawnFromAssetSchema.shape> = {
  name: 'actor_spawn_from_asset',
  description:
    'Spawn an actor from a content asset path (StaticMesh or Blueprint) without knowing the actor class. Optional snap_to_floor line-traces down onto geometry. Returns actor_id + final transform read-back. NON-IDEMPOTENT.',
  cost: 'medium',
  returns: '{ok, actor_id, path, class, transform:{location,rotation,scale}}',
  schema: actorSpawnFromAssetSchema.shape,
  meta: { ...writeMeta, cost: 'medium', effects: ['spawns_actor'] },
  buildScript: spawnFromAssetScript,
  timeoutMs: 30_000,
};

// ── actor_batch_transform ─────────────────────────────────────────────────────
export const actorBatchTransformSchema = z.object({
  transforms: z.array(z.object({
    actor_id: z.string().min(1).describe('Actor label or full path'),
    location: z.array(z.number()).length(3).optional().describe('[x,y,z] absolute location'),
    rotation: z.array(z.number()).length(3).optional().describe('[roll,pitch,yaw] absolute rotation'),
    scale: z.array(z.number()).length(3).optional().describe('[x,y,z] absolute scale'),
  })).min(1).describe('Per-actor transform edits; each omitted field is left unchanged'),
});
export type ActorBatchTransformParams = z.infer<typeof actorBatchTransformSchema>;

function batchTransformScript(p: ActorBatchTransformParams): string {
  return [
    PY_ACTOR_HELPERS,
    `_edits = ${JSON.stringify(p.transforms)}`,
    'results = []',
    'for e in _edits:',
    '    a, _msg = _find_actor(e["actor_id"])',
    '    if a is None:',
    '        results.append({"actor_id": e.get("actor_id"), "ok": False, "error": _msg})',
    '        continue',
    '    before = _xform(a)',
    '    if e.get("location") is not None:',
    '        l = e["location"]; a.set_actor_location(unreal.Vector(l[0], l[1], l[2]), False, False)',
    '    if e.get("rotation") is not None:',
    '        r = e["rotation"]; a.set_actor_rotation(unreal.Rotator(r[0], r[1], r[2]), False)',
    '    if e.get("scale") is not None:',
    '        s = e["scale"]; a.set_actor_scale3d(unreal.Vector(s[0], s[1], s[2]))',
    '    results.append({"actor_id": a.get_actor_label(), "ok": True, "before": before, "after": _xform(a)})',
    '_emit({"ok": all(r["ok"] for r in results), "results": results, "count": len(results)})',
  ].join('\n');
}

export const actorBatchTransformDescriptor: PyToolDescriptor<typeof actorBatchTransformSchema.shape> = {
  name: 'actor_batch_transform',
  description:
    'Transform many actors in one call: each entry sets absolute location/rotation/scale (omitted fields unchanged). Returns per-actor before/after read-back. Undo granularity follows the editor default (one python exec).',
  cost: 'low',
  returns: '{ok, results:[{actor_id,ok,before,after}|{actor_id,ok:false,error}], count}',
  schema: actorBatchTransformSchema.shape,
  meta: writeMeta,
  buildScript: batchTransformScript,
  timeoutMs: 30_000,
};

// ── actor_focus ───────────────────────────────────────────────────────────────
export const actorFocusSchema = z.object({
  actor_id: z.string().min(1).describe('Actor label or full path to frame in the viewport'),
});
export type ActorFocusParams = z.infer<typeof actorFocusSchema>;

function focusScript(p: ActorFocusParams): string {
  return [
    PY_ACTOR_HELPERS,
    `_ref = ${pyStr(p.actor_id)}`,
    'a, _msg = _find_actor(_ref)',
    'if a is None:',
    '    _err(_msg)',
    'else:',
    '    eas = _eas()',
    '    eas.select_nothing()',
    '    eas.set_actor_selection_state(a, True)',
    '    les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)',
    '    les.editor_invoke_console_command("CAMERA ALIGN ACTIVEVIEWPORTONLY")',
    '    _emit({"ok": True, "actor_id": a.get_actor_label(), "focused": True, "transform": _xform(a)})',
  ].join('\n');
}

export const actorFocusDescriptor: PyToolDescriptor<typeof actorFocusSchema.shape> = {
  name: 'actor_focus',
  description:
    'Frame the editor viewport camera on an actor (selects it and aligns the active viewport). For the vision loop before a screenshot.',
  cost: 'low',
  returns: '{ok, actor_id, focused, transform}',
  schema: actorFocusSchema.shape,
  meta: writeMeta,
  buildScript: focusScript,
  timeoutMs: 30_000,
};

// ── actor_set_folder ──────────────────────────────────────────────────────────
export const actorSetFolderSchema = z.object({
  actor_ids: z.array(z.string().min(1)).min(1).describe('Actor labels or full paths to move'),
  folder: z.string().describe('World-outliner folder path, e.g. "Buildings/District01". Empty string moves to the root.'),
});
export type ActorSetFolderParams = z.infer<typeof actorSetFolderSchema>;

function setFolderScript(p: ActorSetFolderParams): string {
  return [
    PY_ACTOR_HELPERS,
    `_refs = ${JSON.stringify(p.actor_ids)}`,
    `_folder = ${pyStr(p.folder)}`,
    'moved = []',
    'missing = []',
    'for ref in _refs:',
    '    a, _msg = _find_actor(ref)',
    '    if a is None:',
    '        missing.append(ref)',
    '        continue',
    '    a.set_folder_path(unreal.Name(_folder))',
    '    moved.append({"actor_id": a.get_actor_label(), "folder": str(a.get_folder_path())})',
    '_emit({"ok": len(missing) == 0, "moved": moved, "missing": missing, "count": len(moved)})',
  ].join('\n');
}

export const actorSetFolderDescriptor: PyToolDescriptor<typeof actorSetFolderSchema.shape> = {
  name: 'actor_set_folder',
  description:
    'Move actors into a world-outliner folder (organisation). Empty folder string moves to the root. Returns per-actor read-back of the applied folder.',
  cost: 'low',
  returns: '{ok, moved:[{actor_id,folder}], missing[], count}',
  schema: actorSetFolderSchema.shape,
  meta: writeMeta,
  buildScript: setFolderScript,
  timeoutMs: 30_000,
};

// ── Aggregate: all actor-domain PyToolDescriptors (spliced in index.ts) ────────
export const actorPyDescriptors: PyToolDescriptor[] = [
  actorInspectDescriptor,
  actorFindDescriptor,
  actorGetSelectionDescriptor,
  actorSetSelectionDescriptor,
  actorSpawnFromAssetDescriptor,
  actorBatchTransformDescriptor,
  actorFocusDescriptor,
  actorSetFolderDescriptor,
] as unknown as PyToolDescriptor[];

/** Names of actor-domain factory tools that are non-idempotent (mutating create). */
export const ACTOR_NON_IDEMPOTENT: readonly string[] = [actorSpawnFromAssetDescriptor.name];
