// Mesh-and-geometryscript P0/asset-readback tools, generated as UE Python via
// the pyTemplate factory (see py-tool-factory.ts). Sibling of
// actor/actor-py-tools.ts and editor/editor-py-tools.ts — same PyToolDescriptor
// shape, same _emit/_err envelope, same index.ts splice.
//
// Source of truth for the catalog: docs/plans/2026-06-28-mcp-supertooling-tools.json,
// domain "mesh-and-geometryscript". We ship the python-feasible, NET-NEW
// StaticMesh-asset readback subset plus one material-slot setter, and skip
// catalog entries that are C++-backed, already surfaced, or GeometryScript-heavy:
//
//   SHIPPED (5): mesh_get_sockets, mesh_get_lods, mesh_get_materials,
//     mesh_get_bounds, mesh_set_material_slot.
//
//   SKIPPED:
//     - mesh_inspect / mesh_extract / mesh_topology_stats / mesh_list(_dynamic) →
//       already in the legacy sidecar (mesh_extract, mesh_list_dynamic,
//       mesh_topology_stats) and index.ts uses the C++ mesh_get_info for bounds.
//       mesh_get_* here are the ASSET-level StaticMesh readbacks those C++
//       geometry-extract tools do not cover (socket list, per-LOD tri/vert,
//       material-slot table).
//     - geo_* (geo_pipeline / geo_bake_to_staticmesh / geo_boolean / geo_remesh
//       / …) → the GeometryScript op graph is a large, stateful C++ surface
//       (DynamicMesh handles, transactions); a python_run wrapper is a separate
//       dedicated effort, not a thin readback. Deferred wholesale.
//     - staticmesh_set_nanite / staticmesh_generate_lods / staticmesh_collision_set
//       → mutating build-setting writers whose reliable path is the
//       StaticMeshEditorSubsystem C++ build API; deferred to a C++/live pass
//       rather than shipped as speculative reflection writes.
//
// OVERLAP notes (intentional, documented):
//   - mesh_get_bounds vs the C++ mesh_get_info bounds (used by
//     bake-physical-asset in index.ts): mesh_get_info returns min/max/extents
//     for the physical-asset baker; mesh_get_bounds is the standalone
//     origin+extent+sphere-radius readback (BoxSphereBounds) for agents sizing a
//     placement. Both derive from the same StaticMesh; keep the cheap standalone.
//   - mesh_set_material_slot vs material MCP tools: this sets which material
//     ASSET occupies a StaticMesh slot (asset wiring); the material_* tools edit
//     the material graph itself. Different layers.
//
// NON_IDEMPOTENT: none. mesh_set_material_slot is a set-to-value write (assigning
// the same material to the same slot twice is the same state — the house rule
// treats set-to-value as idempotent), so it is NOT added to tool-executor's
// NON_IDEMPOTENT set. The other four are reads.
//
// UNCERTAIN-API flags for the next live-validation pass (all wrapped defensively
// so they degrade to a structured error rather than a silent wrong answer):
//   - mesh_get_lods: per-LOD tri/vert counts live on StaticMeshEditorSubsystem
//     (get_lod_count / get_number_triangles / get_number_verts) in 5.7, formerly
//     EditorStaticMeshLibrary. Both are probed; degrades to lod_count-only.
//   - mesh_get_sockets: the `sockets` property vs get_sockets() vs
//     get_socket_by_name enumeration varies; the `sockets` array is read first.
//   - mesh_set_material_slot: assignment via the static_materials array
//     (set_editor_property) vs StaticMeshEditorSubsystem.set_material — both
//     probed.

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

// ── Shared Python helper: load + validate a StaticMesh from a content path ──────
const PY_MESH_HELPERS = [
  'def _load_sm(path):',
  '    obj = unreal.EditorAssetLibrary.load_asset(path)',
  '    if obj is None: raise Exception("asset not found: %s" % path)',
  '    if not isinstance(obj, unreal.StaticMesh): raise Exception("not a StaticMesh: %s (%s)" % (path, type(obj).__name__))',
  '    return obj',
  'def _sm_subsystem():',
  '    try: return unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)',
  '    except Exception: return None',
].join('\n');

const readMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'reading a StaticMesh asset\'s sockets / LODs / materials / bounds before placing or editing it',
  not_when: 'you need raw geometry topology dumps — use the C++ mesh_extract / mesh_topology_stats',
};

const writeMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['writes-to-disk'],
  when: 'swapping the material asset assigned to a StaticMesh slot',
  not_when: 'editing the material graph itself — use the material_* tools',
};

// ── mesh_get_sockets ────────────────────────────────────────────────────────────
export const meshGetSocketsSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the StaticMesh, e.g. "/Game/Meshes/SM_Rock"'),
});
export type MeshGetSocketsParams = z.infer<typeof meshGetSocketsSchema>;

function meshGetSocketsScript(p: MeshGetSocketsParams): string {
  return [
    PY_MESH_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    'try:',
    '    sm = _load_sm(_path)',
    '    socks = []',
    '    raw = None',
    '    try: raw = sm.get_editor_property("sockets")',
    '    except Exception: raw = None',
    '    if raw is None:',
    '        try: raw = sm.sockets',
    '        except Exception: raw = None',
    '    for s in (raw or []):',
    '        try:',
    '            loc = s.relative_location; rot = s.relative_rotation; sc = s.relative_scale',
    '            socks.append({"name": str(s.socket_name),',
    '                          "location": [loc.x, loc.y, loc.z],',
    '                          "rotation": [rot.roll, rot.pitch, rot.yaw],',
    '                          "scale": [sc.x, sc.y, sc.z]})',
    '        except Exception:',
    '            try: socks.append({"name": str(s.socket_name)})',
    '            except Exception: pass',
    '    _emit({"ok": True, "asset_path": _path, "sockets": socks, "count": len(socks)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const meshGetSocketsDescriptor: PyToolDescriptor<typeof meshGetSocketsSchema.shape> = {
  name: 'mesh_get_sockets',
  description:
    'List a StaticMesh\'s named sockets with relative transform (location/rotation/scale) — the attachment points an agent needs before snapping child actors onto a mesh. Reads the `sockets` property defensively.',
  cost: 'low',
  returns: '{ok, asset_path, sockets:[{name,location,rotation,scale}], count}',
  schema: meshGetSocketsSchema.shape,
  meta: readMeta,
  buildScript: meshGetSocketsScript,
  timeoutMs: 30_000,
};

// ── mesh_get_lods ───────────────────────────────────────────────────────────────
export const meshGetLodsSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the StaticMesh'),
});
export type MeshGetLodsParams = z.infer<typeof meshGetLodsSchema>;

function meshGetLodsScript(p: MeshGetLodsParams): string {
  return [
    PY_MESH_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    'try:',
    '    sm = _load_sm(_path)',
    '    sub = _sm_subsystem()',
    '    lod_count = None',
    '    try:',
    '        if sub is not None: lod_count = sub.get_lod_count(sm)',
    '    except Exception: lod_count = None',
    '    if lod_count is None:',
    '        try: lod_count = unreal.EditorStaticMeshLibrary.get_lod_count(sm)',
    '        except Exception: lod_count = None',
    '    lods = []',
    '    if lod_count:',
    '        for i in range(lod_count):',
    '            tri = None; vert = None',
    '            try:',
    '                if sub is not None:',
    '                    tri = sub.get_number_triangles(sm, i); vert = sub.get_number_verts(sm, i)',
    '            except Exception: pass',
    '            if tri is None:',
    '                try:',
    '                    tri = unreal.EditorStaticMeshLibrary.get_number_triangles(sm, i)',
    '                    vert = unreal.EditorStaticMeshLibrary.get_number_verts(sm, i)',
    '                except Exception: pass',
    '            lods.append({"lod": i, "triangles": tri, "vertices": vert})',
    '    _emit({"ok": True, "asset_path": _path, "lod_count": lod_count, "lods": lods})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const meshGetLodsDescriptor: PyToolDescriptor<typeof meshGetLodsSchema.shape> = {
  name: 'mesh_get_lods',
  description:
    'Report a StaticMesh\'s LOD count and per-LOD triangle/vertex counts (StaticMeshEditorSubsystem, falling back to EditorStaticMeshLibrary). Degrades to lod_count with null tri/vert when the per-LOD getters are unavailable on this build.',
  cost: 'low',
  returns: '{ok, asset_path, lod_count, lods:[{lod,triangles,vertices}]}',
  schema: meshGetLodsSchema.shape,
  meta: readMeta,
  buildScript: meshGetLodsScript,
  timeoutMs: 30_000,
};

// ── mesh_get_materials ──────────────────────────────────────────────────────────
export const meshGetMaterialsSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the StaticMesh'),
});
export type MeshGetMaterialsParams = z.infer<typeof meshGetMaterialsSchema>;

function meshGetMaterialsScript(p: MeshGetMaterialsParams): string {
  return [
    PY_MESH_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    'try:',
    '    sm = _load_sm(_path)',
    '    mats = []',
    '    raw = []',
    '    try: raw = sm.get_editor_property("static_materials")',
    '    except Exception: raw = []',
    '    for i, m in enumerate(raw or []):',
    '        slot = None; mat_path = None',
    '        try: slot = str(m.material_slot_name)',
    '        except Exception: pass',
    '        try:',
    '            mi = m.material_interface',
    '            if mi is not None: mat_path = mi.get_path_name()',
    '        except Exception: pass',
    '        mats.append({"slot_index": i, "slot_name": slot, "material": mat_path})',
    '    _emit({"ok": True, "asset_path": _path, "materials": mats, "count": len(mats)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const meshGetMaterialsDescriptor: PyToolDescriptor<typeof meshGetMaterialsSchema.shape> = {
  name: 'mesh_get_materials',
  description:
    'List a StaticMesh\'s material slots: slot index, slot name, and the assigned material asset path (from static_materials). The map an agent reads before mesh_set_material_slot.',
  cost: 'low',
  returns: '{ok, asset_path, materials:[{slot_index,slot_name,material}], count}',
  schema: meshGetMaterialsSchema.shape,
  meta: readMeta,
  buildScript: meshGetMaterialsScript,
  timeoutMs: 30_000,
};

// ── mesh_get_bounds ─────────────────────────────────────────────────────────────
export const meshGetBoundsSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the StaticMesh'),
});
export type MeshGetBoundsParams = z.infer<typeof meshGetBoundsSchema>;

function meshGetBoundsScript(p: MeshGetBoundsParams): string {
  return [
    PY_MESH_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    'try:',
    '    sm = _load_sm(_path)',
    '    origin = None; extent = None; radius = None; bmin = None; bmax = None',
    '    try:',
    '        b = sm.get_bounds()',
    '        o = b.origin; e = b.box_extent',
    '        origin = [o.x, o.y, o.z]; extent = [e.x, e.y, e.z]',
    '        try: radius = b.sphere_radius',
    '        except Exception: pass',
    '        bmin = [o.x - e.x, o.y - e.y, o.z - e.z]',
    '        bmax = [o.x + e.x, o.y + e.y, o.z + e.z]',
    '    except Exception: pass',
    '    if origin is None:',
    '        try:',
    '            mn, mx = sm.get_bounding_box()',
    '            bmin = [mn.x, mn.y, mn.z]; bmax = [mx.x, mx.y, mx.z]',
    '            origin = [(mn.x+mx.x)/2.0, (mn.y+mx.y)/2.0, (mn.z+mx.z)/2.0]',
    '            extent = [(mx.x-mn.x)/2.0, (mx.y-mn.y)/2.0, (mx.z-mn.z)/2.0]',
    '        except Exception: pass',
    '    if origin is None: raise Exception("could not read StaticMesh bounds")',
    '    _emit({"ok": True, "asset_path": _path, "origin": origin, "extent": extent,',
    '           "sphere_radius": radius, "min": bmin, "max": bmax})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const meshGetBoundsDescriptor: PyToolDescriptor<typeof meshGetBoundsSchema.shape> = {
  name: 'mesh_get_bounds',
  description:
    'Read a StaticMesh\'s local bounds: origin, box extent, sphere radius, and min/max corners (cm). The cheap standalone sizing readback (BoxSphereBounds), distinct from the C++ mesh_get_info bounds used by the physical-asset baker.',
  cost: 'low',
  returns: '{ok, asset_path, origin, extent, sphere_radius, min, max}',
  schema: meshGetBoundsSchema.shape,
  meta: readMeta,
  buildScript: meshGetBoundsScript,
  timeoutMs: 30_000,
};

// ── mesh_set_material_slot ──────────────────────────────────────────────────────
export const meshSetMaterialSlotSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the StaticMesh to modify'),
  slot_index: z.number().int().nonnegative().describe('Material slot index to set'),
  material_path: z.string().min(1).describe('Content path of the material/MaterialInstance to assign'),
});
export type MeshSetMaterialSlotParams = z.infer<typeof meshSetMaterialSlotSchema>;

function meshSetMaterialSlotScript(p: MeshSetMaterialSlotParams): string {
  return [
    PY_MESH_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    `_slot = ${p.slot_index}`,
    `_mat = ${pyStr(p.material_path)}`,
    'try:',
    '    sm = _load_sm(_path)',
    '    mat = unreal.EditorAssetLibrary.load_asset(_mat)',
    '    if mat is None: raise Exception("material not found: %s" % _mat)',
    '    applied = False',
    '    sub = _sm_subsystem()',
    '    try:',
    '        if sub is not None:',
    '            sub.set_material(sm, _slot, mat); applied = True',
    '    except Exception: applied = False',
    '    if not applied:',
    '        mats = sm.get_editor_property("static_materials")',
    '        if _slot >= len(mats): raise Exception("slot_index %d out of range (%d slots)" % (_slot, len(mats)))',
    '        mats[_slot].material_interface = mat',
    '        sm.set_editor_property("static_materials", mats)',
    '        applied = True',
    '    unreal.EditorAssetLibrary.save_asset(_path, only_if_is_dirty=False)',
    '    # Read back the applied slot to confirm.',
    '    readback = None',
    '    try:',
    '        rb = sm.get_editor_property("static_materials")',
    '        if _slot < len(rb) and rb[_slot].material_interface is not None:',
    '            readback = rb[_slot].material_interface.get_path_name()',
    '    except Exception: pass',
    '    # Bind ok to the read-back matching the requested asset — a set that silently',
    '    # no-ops (out-of-range slot the subsystem ignored, engine rejection) is a failure.',
    '    verified = (readback is not None and unreal.EditorAssetLibrary.load_asset(readback) == mat)',
    '    warnings = [] if verified else ["slot %d material readback (%s) does not match requested (%s) — write did not stick" % (_slot, readback, _mat)]',
    '    _emit({"ok": bool(applied and verified), "asset_path": _path, "slot_index": _slot,',
    '           "material": _mat, "applied": applied, "verified": verified, "readback": readback, "warnings": warnings})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const meshSetMaterialSlotDescriptor: PyToolDescriptor<typeof meshSetMaterialSlotSchema.shape> = {
  name: 'mesh_set_material_slot',
  description:
    'Assign a material/MaterialInstance asset to a StaticMesh material slot by index, saving the mesh and reading back the applied material path. Probes StaticMeshEditorSubsystem.set_material then the static_materials array. Idempotent set-to-value (assigning the same material twice is the same state). Sets the material ASSET on the slot — use material_* tools to edit the graph.',
  cost: 'low',
  returns: '{ok, asset_path, slot_index, material, applied, verified, readback, warnings[]}',
  schema: meshSetMaterialSlotSchema.shape,
  meta: writeMeta,
  buildScript: meshSetMaterialSlotScript,
  timeoutMs: 30_000,
};

// ── Aggregate: all mesh-domain PyToolDescriptors (spliced in index.ts) ──────────
export const meshPyDescriptors: PyToolDescriptor[] = [
  meshGetSocketsDescriptor,
  meshGetLodsDescriptor,
  meshGetMaterialsDescriptor,
  meshGetBoundsDescriptor,
  meshSetMaterialSlotDescriptor,
] as unknown as PyToolDescriptor[];

/** Mesh-domain factory tools that are non-idempotent. None: mesh_set_material_slot
 *  is a set-to-value write (idempotent per the house rule); the rest are reads. */
export const MESH_NON_IDEMPOTENT: readonly string[] = [];
