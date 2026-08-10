// Editor-introspection & observability P0 tools, generated as UE Python via the
// pyTemplate factory (see py-tool-factory.ts). Sibling of actor/actor-py-tools.ts
// — same PyToolDescriptor shape, same _emit/_err envelope, same index.ts splice.
//
// Source of truth for the catalog: docs/plans/2026-06-28-mcp-supertooling-tools.json,
// domain "editor-introspection-and-observability" (P0s). We ship the
// python-feasible, NET-NEW subset and skip catalog entries that are C++-backed,
// TS-only, already surfaced by the legacy sidecar, or whose python is speculative:
//
//   SHIPPED HERE (11): editor_get_camera, editor_cvar_get,
//     editor_cvar_set, selection_get, asset_inspect,
//     outliner_tree, object_inspect, object_exists, content_browser_sync,
//     reflect_search_types, reflect_class.
//
//   SKIPPED:
//     - log_tail / perf_stats  → catalog marks C++ (HaybaMCPToolkit handlers);
//       editor_get_output_log is ALREADY surfaced by the legacy sidecar, and
//       there is no clean python readback for FPS/frame-ms/draw-calls.
//     - mcp_health             → catalog marks TS (extends check-ue-status.ts);
//       not a python_run tool — hayba_check_ue_status already covers it.
//     - reflect_properties     → overlaps the existing hayba_introspect (dir-based
//       reflected-property dump); net-new value too low to justify a near-dup.
//     - editor_set_camera / editor_focus_actor → already in the legacy sidecar;
//       actor_focus (actor-py-tools) also frames an actor.
//     - editor_undo / redo / bookmark_set / bookmark_jump → no clean, real UE
//       python API (undo/redo/bookmarks live behind C++ FEditorModeTools /
//       IBookmarkTypeTools); a python wrapper would be speculative. Deferred to a
//       C++ handler pass rather than shipped as guesswork.
//
// OVERLAP notes (intentional, documented):
//   - selection_get is broader than actor_get_selection: it also reports the
//     content-browser asset selection and selected components.
//   - object_inspect is the generic-by-path read; actor_inspect is the richer
//     level-actor read. Both are kept.
//   - asset_inspect vs the native sidecar's asset_registry_query and
//     asset_get_info (C++, single-asset info): asset_registry_query is the
//     BULK/DISCOVERY surface (class + path-prefix filter, pagination — "what
//     assets exist here"); asset_inspect is the PYTHON-SIDE single-asset read
//     (class, dirty flag, dependency/referencer counts — AssetRegistry-derived
//     metadata); asset_get_info is the C++-backed single-asset info call and
//     may expose engine-side fields the python path cannot reach (e.g. deeper
//     tag/metadata introspection via UObject reflection). The registry query
//     is native so discovery is not blocked by Python reflection policy. Use
//     asset_registry_query to find candidates, asset_inspect for dependency
//     graph questions, asset_get_info when you need the C++-only fields.
//   - object_inspect vs the legacy sidecar's object_get_property: object_inspect
//     is a PYTHON dir()-walk over any live UObject (asset, object, or resolved
//     by level-actor label) — cheap, broad, string-coerced values, good for
//     "what does this thing even look like". object_get_property is C++-backed
//     and reads one CPF_Edit-flagged property by exact path — precise, typed,
//     but only sees editor-exposed reflected properties and does not resolve
//     actor labels. Use object_inspect to explore/discover; use
//     object_get_property once you know the exact property path you need.
//
// Validated UE 5.7 idioms used here (verified against MEMORY + existing tools):
//   unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem|LevelEditorSubsystem
//     |EditorActorSubsystem)
//   UnrealEditorSubsystem.get_level_viewport_camera_info()
//   unreal.SystemLibrary.get_console_variable_{int,float,bool}_value(name)
//   unreal.SystemLibrary.execute_console_command(None, "name value")  (cvar set)
//   unreal.AssetRegistryHelpers.get_asset_registry()
//   unreal.EditorUtilityLibrary.get_selected_assets()
//   unreal.EditorAssetLibrary.load_asset / does_asset_exist
//
// NON-IDEMPOTENT: none. cvar_set is retry-safe (setting the same value twice is
// the same state) and content_browser_sync is a pure UI focus — neither creates
// or appends, so neither is added to tool-executor's NON_IDEMPOTENT set.
//
// UNCERTAIN-API flags for the next live-validation pass (all wrapped defensively
// so they degrade to a structured error rather than a silent wrong answer):
//   - editor_get_camera: get_level_viewport_camera_info() return arity varies by
//     engine build ((loc,rot) vs (bool,loc,rot)) — both shapes handled.
//   - content_browser_sync: sync_browser_to_objects vs sync_browser_to_folders —
//     both probed; degrades to error if neither exists.
//   - reflect_class: python exposes no clean UClass flag/interface reflection;
//     we walk the python type MRO + CDO defaults and report what we can.

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

// ── Shared Python helpers (editor subsystems + reflection resolve) ────────────
const PY_EDITOR_HELPERS = [
  'def _sub(name):',
  '    try: return unreal.get_editor_subsystem(getattr(unreal, name))',
  '    except Exception: return None',
  'def _vec(v):',
  '    try: return [v.x, v.y, v.z]',
  '    except Exception: return None',
  'def _rot(r):',
  '    try: return [r.roll, r.pitch, r.yaw]',
  '    except Exception: return None',
  'def _resolve_type(nm):',
  '    if not nm: return None',
  '    o = getattr(unreal, nm, None)',
  '    if o is not None: return o',
  '    if nm.startswith("E") and len(nm) > 1:',
  '        o = getattr(unreal, nm[1:], None)',
  '        if o is not None: return o',
  '    try: return unreal.load_class(None, nm)',
  '    except Exception: return None',
].join('\n');

const readMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'probing editor/world/asset state before an action loop (the gating + read half of inspect-then-edit)',
  not_when: 'you already hold a fresh read of the same state from a prior call',
};

const uiMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'steering the editor UI/console (cvar set, content-browser focus) — changes editor state, not saved assets',
  not_when: 'authoring an asset on disk — use the asset/material/pcg tools',
};

// ── editor_get_camera ─────────────────────────────────────────────────────────
export const editorGetCameraSchema = z.object({});
export type EditorGetCameraParams = z.infer<typeof editorGetCameraSchema>;

function editorGetCameraScript(_p: EditorGetCameraParams): string {
  return [
    PY_EDITOR_HELPERS,
    'try:',
    '    ues = _sub("UnrealEditorSubsystem")',
    '    if ues is None: raise Exception("UnrealEditorSubsystem unavailable")',
    '    info = ues.get_level_viewport_camera_info()',
    '    loc = None; rot = None',
    '    if isinstance(info, tuple):',
    '        # ((loc,rot)) or (bool, loc, rot) depending on engine build',
    '        parts = [x for x in info if not isinstance(x, bool)]',
    '        if len(parts) >= 2: loc, rot = parts[0], parts[1]',
    '    if loc is None: raise Exception("get_level_viewport_camera_info returned no transform")',
    '    _emit({"ok": True, "location": _vec(loc), "rotation": _rot(rot)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const editorGetCameraDescriptor: PyToolDescriptor<typeof editorGetCameraSchema.shape> = {
  name: 'editor_get_camera',
  description:
    'Read the active editor viewport camera location + rotation. Net-new read counterpart to the legacy editor_set_camera. Rotation is [roll,pitch,yaw] degrees.',
  cost: 'low',
  returns: '{ok, location:[x,y,z], rotation:[roll,pitch,yaw]}',
  schema: editorGetCameraSchema.shape,
  meta: readMeta,
  buildScript: editorGetCameraScript,
  timeoutMs: 30_000,
};

// ── editor_cvar_get ───────────────────────────────────────────────────────────
// KNOWN API LIMITATION: unreal.SystemLibrary's get_console_variable_{int,float,
// bool}_value getters return type-defaults (0 / 0.0 / False) for a nonexistent
// or mistyped cvar name — there is no dedicated "does this cvar exist" python
// API. To avoid silently reporting a fabricated 0 as if it were a real reading,
// we probe existence via get_console_variable_string_value (if present on this
// engine build) BEFORE trusting the typed value: an empty/None string strongly
// suggests the cvar does not exist, so we surface verified:false rather than a
// bare 0. If no string getter exists on this build, we cannot verify at all and
// say so explicitly via verified:false + a "no existence probe available on
// this engine build" note — callers must not treat value as trustworthy in
// that case without independent confirmation.
export const editorCvarGetSchema = z.object({
  name: z.string().min(1).describe('Console variable name, e.g. "r.ScreenPercentage"'),
  type: z.enum(['int', 'float', 'bool']).optional()
    .describe('Typed read: int | float | bool. If omitted, defaults to float and the response sets type_assumed:true.'),
});
export type EditorCvarGetParams = z.infer<typeof editorCvarGetSchema>;

function editorCvarGetScript(p: EditorCvarGetParams): string {
  const typeAssumed = p.type === undefined;
  const effectiveType = p.type ?? 'float';
  return [
    PY_EDITOR_HELPERS,
    `_name = ${pyStr(p.name)}`,
    `_type = ${pyStr(effectiveType)}`,
    `_type_assumed = ${typeAssumed ? 'True' : 'False'}`,
    'try:',
    '    if _type == "int":',
    '        val = unreal.SystemLibrary.get_console_variable_int_value(_name)',
    '    elif _type == "bool":',
    '        val = unreal.SystemLibrary.get_console_variable_bool_value(_name)',
    '    else:',
    '        val = unreal.SystemLibrary.get_console_variable_float_value(_name)',
    '    # Existence probe: prefer the string getter when this engine build has one.',
    '    str_getter = getattr(unreal.SystemLibrary, "get_console_variable_string_value", None)',
    '    verified = None; str_val = None; note = None',
    '    if str_getter is not None:',
    '        try:',
    '            str_val = str_getter(_name)',
    '            verified = bool(str_val is not None and str(str_val) != "")',
    '        except Exception:',
    '            verified = False',
    '    else:',
    '        verified = False',
    '        note = "no cvar-existence probe available on this engine build; value may be a type-default for an unknown/mistyped name"',
    '    if verified is False and str_getter is None:',
    '        pass  # note already set above',
    '    elif verified is False:',
    '        note = "cvar not found (empty string readback) — value is a type-default, not a real reading"',
    '    _emit({"ok": True, "name": _name, "type": _type, "type_assumed": _type_assumed,',
    '           "value": val, "verified": verified, "string_value": str_val, "note": note})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const editorCvarGetDescriptor: PyToolDescriptor<typeof editorCvarGetSchema.shape> = {
  name: 'editor_cvar_get',
  description:
    'Typed read of a console variable (int/float/bool) via KismetSystemLibrary getters. CAVEAT: UE\'s typed getters return type-defaults (0/0.0/False) for an unknown or mistyped cvar name, indistinguishable from a real zero value — this tool probes existence via the string getter when available and reports verified:false (plus a note) whenever the value cannot be confirmed real; treat verified:false as "do not trust this value". type defaults to float when omitted, with type_assumed:true in the response. NOT a freeform console runner — use editor_run_console_command for that.',
  cost: 'low',
  returns: '{ok, name, type, type_assumed, value, verified, string_value, note}',
  schema: editorCvarGetSchema.shape,
  meta: readMeta,
  buildScript: editorCvarGetScript,
  timeoutMs: 30_000,
};

// ── editor_cvar_set ───────────────────────────────────────────────────────────
export const editorCvarSetSchema = z.object({
  name: z.string().min(1).describe('Console variable name, e.g. "r.ScreenPercentage"'),
  value: z.union([z.number(), z.boolean(), z.string()]).describe('New value (number, bool, or string)'),
});
export type EditorCvarSetParams = z.infer<typeof editorCvarSetSchema>;

function editorCvarSetScript(p: EditorCvarSetParams): string {
  const valStr = typeof p.value === 'boolean' ? (p.value ? '1' : '0') : String(p.value);
  return [
    PY_EDITOR_HELPERS,
    `_name = ${pyStr(p.name)}`,
    `_val = ${pyStr(valStr)}`,
    'try:',
    '    unreal.SystemLibrary.execute_console_command(None, "%s %s" % (_name, _val))',
    '    # Read back (float getter is the most forgiving) to confirm the applied value.',
    '    applied = None',
    '    try: applied = unreal.SystemLibrary.get_console_variable_float_value(_name)',
    '    except Exception: pass',
    '    # Same existence caveat as editor_cvar_get: the float getter returns 0.0 for a',
    '    # nonexistent cvar, so a typo would otherwise look like a successful set-to-0.',
    '    str_getter = getattr(unreal.SystemLibrary, "get_console_variable_string_value", None)',
    '    verified = None; note = None; _ok = True',
    '    if str_getter is not None:',
    '        try:',
    '            sv = str_getter(_name)',
    '            verified = bool(sv is not None and str(sv) != "")',
    '            if not verified:',
    '                note = "cvar not found after set (empty string readback) — the name is likely mistyped"',
    '                _ok = False',  // definitive not-found → honest failure, not a silent set-to-0
    '        except Exception:',
    '            verified = False',
    '            note = "string readback failed; cannot confirm the cvar exists"',
    '    else:',
    '        verified = False',
    '        note = "no cvar-existence probe available on this engine build; applied may be a type-default if the name is wrong"',
    '    _emit({"ok": _ok, "name": _name, "requested": _val, "applied": applied, "verified": verified, "note": note})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const editorCvarSetDescriptor: PyToolDescriptor<typeof editorCvarSetSchema.shape> = {
  name: 'editor_cvar_set',
  description:
    'Typed set of a console variable, with a float read-back of the applied value. CAVEAT: the float readback returns 0.0 for a nonexistent cvar, indistinguishable from a real set-to-0 — this tool also probes the string getter (when available on this engine build) and returns ok:false + verified:false + a note when the readback proves the cvar does not exist (mistyped name). When no existence probe is available it stays ok:true with verified:false. Idempotent (retry-safe). NOT a freeform console runner — use editor_run_console_command for arbitrary commands.',
  cost: 'low',
  returns: '{ok, name, requested, applied, verified, note}',
  schema: editorCvarSetSchema.shape,
  meta: uiMeta,
  buildScript: editorCvarSetScript,
  timeoutMs: 30_000,
};

// ── selection_get ─────────────────────────────────────────────────────────────
export const selectionGetSchema = z.object({});
export type SelectionGetParams = z.infer<typeof selectionGetSchema>;

function selectionGetScript(_p: SelectionGetParams): string {
  return [
    PY_EDITOR_HELPERS,
    'try:',
    '    eas = _sub("EditorActorSubsystem")',
    '    actors = []',
    '    try:',
    '        for a in eas.get_selected_level_actors():',
    '            actors.append({"actor_id": a.get_actor_label(), "path": a.get_path_name(), "class": type(a).__name__})',
    '    except Exception: pass',
    '    assets = []',
    '    try:',
    '        for asset in unreal.EditorUtilityLibrary.get_selected_assets():',
    '            assets.append(asset.get_path_name())',
    '    except Exception: pass',
    '    comps = []',
    '    try:',
    '        for c in unreal.EditorUtilityLibrary.get_selected_components():',
    '            comps.append({"class": type(c).__name__, "name": c.get_name()})',
    '    except Exception: pass',
    '    _emit({"ok": True, "actors": actors, "assets": assets, "components": comps,',
    '           "actor_count": len(actors), "asset_count": len(assets)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const selectionGetDescriptor: PyToolDescriptor<typeof selectionGetSchema.shape> = {
  name: 'selection_get',
  description:
    'Full editor selection probe: selected level actors, content-browser assets, and selected components. Broader than actor_get_selection (adds assets + components) — the context probe for "apply to selection" tools.',
  cost: 'low',
  returns: '{ok, actors:[{actor_id,path,class}], assets[], components:[{class,name}], actor_count, asset_count}',
  schema: selectionGetSchema.shape,
  meta: readMeta,
  buildScript: selectionGetScript,
  timeoutMs: 30_000,
};

// ── asset_inspect ─────────────────────────────────────────────────────────────
export const assetInspectSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the asset, e.g. "/Game/Meshes/SM_Rock"'),
});
export type AssetInspectParams = z.infer<typeof assetInspectSchema>;

function assetInspectScript(p: AssetInspectParams): string {
  return [
    PY_EDITOR_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    'try:',
    '    ar = unreal.AssetRegistryHelpers.get_asset_registry()',
    '    exists = False',
    '    try: exists = unreal.EditorAssetLibrary.does_asset_exist(_path)',
    '    except Exception: pass',
    '    if not exists: raise Exception("asset not found: %s" % _path)',
    '    cls = None',
    '    try:',
    '        obj = unreal.EditorAssetLibrary.load_asset(_path)',
    '        if obj is not None: cls = type(obj).__name__',
    '    except Exception: pass',
    '    dirty = False',
    '    try:',
    '        pkg = obj.get_outermost() if obj else None',
    '        if pkg is not None: dirty = bool(pkg.is_dirty())',
    '    except Exception: pass',
    '    dep_count = None; ref_count = None',
    '    try:',
    '        pn = unreal.Name(_path.split(".")[0] if "." in _path else _path)',
    '        deps = ar.get_dependencies(pn)',
    '        refs = ar.get_referencers(pn)',
    '        dep_count = len(deps) if deps is not None else 0',
    '        ref_count = len(refs) if refs is not None else 0',
    '    except Exception: pass',
    '    disk = None',
    '    try: disk = unreal.EditorAssetLibrary.get_metadata_tag(obj, "DiskSize") if obj else None',
    '    except Exception: pass',
    '    _emit({"ok": True, "asset_path": _path, "class": cls, "dirty": dirty,',
    '           "dep_count": dep_count, "ref_count": ref_count, "disk_size": disk})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const assetInspectDescriptor: PyToolDescriptor<typeof assetInspectSchema.shape> = {
  name: 'asset_inspect',
  description:
    'AssetRegistry metadata for one asset: class, dirty flag, dependency/referencer counts. Read before edit/delete to avoid surprises. Differs from the legacy asset_get_info (C++-backed single-asset info, may see engine-only fields) and from asset_registry_query (bulk discovery/pagination) — use this when you already know the asset path and want its dependency graph.',
  cost: 'low',
  returns: '{ok, asset_path, class, dirty, dep_count, ref_count, disk_size}',
  schema: assetInspectSchema.shape,
  meta: readMeta,
  buildScript: assetInspectScript,
  timeoutMs: 30_000,
};

// ── outliner_tree ─────────────────────────────────────────────────────────────
export const outlinerTreeSchema = z.object({
  folder: z.string().optional().describe('Only actors under this outliner folder path, e.g. "Buildings"'),
  class_filter: z.string().optional().describe('Exact class name filter, e.g. "StaticMeshActor"'),
  name_filter: z.string().optional().describe('Case-insensitive substring match on the actor label'),
  limit: z.number().int().positive().optional().default(50).describe('Max nodes returned (pagination)'),
  offset: z.number().int().nonnegative().optional().default(0).describe('Pagination offset'),
});
export type OutlinerTreeParams = z.infer<typeof outlinerTreeSchema>;

function outlinerTreeScript(p: OutlinerTreeParams): string {
  return [
    PY_EDITOR_HELPERS,
    `_folder = ${p.folder !== undefined ? pyStr(p.folder) : 'None'}`,
    `_cls = ${p.class_filter !== undefined ? pyStr(p.class_filter) : 'None'}`,
    `_name = ${p.name_filter !== undefined ? pyStr(p.name_filter) : 'None'}`,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'try:',
    '    eas = _sub("EditorActorSubsystem")',
    '    nodes = []',
    '    for a in eas.get_all_level_actors():',
    '        try:',
    '            lbl = a.get_actor_label()',
    '            if _name is not None and _name.lower() not in lbl.lower(): continue',
    '            if _cls is not None and type(a).__name__ != _cls: continue',
    '            fld = ""',
    '            try: fld = str(a.get_folder_path())',
    '            except Exception: pass',
    '            if _folder is not None and fld != _folder: continue',
    '            parent = None',
    '            try:',
    '                pa = a.get_attach_parent_actor()',
    '                if pa: parent = pa.get_actor_label()',
    '            except Exception: pass',
    '            nodes.append({"actor_id": lbl, "path": a.get_path_name(),',
    '                          "class": type(a).__name__, "folder": fld, "attach_parent": parent})',
    '        except Exception: pass',
    '    total = len(nodes)',
    '    page = nodes[_offset:_offset+_limit]',
    '    _emit({"ok": True, "nodes": page, "total": total,',
    '           "has_more": (_offset+_limit) < total, "next_offset": _offset+_limit})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const outlinerTreeDescriptor: PyToolDescriptor<typeof outlinerTreeSchema.shape> = {
  name: 'outliner_tree',
  description:
    'Paginated world outliner: level actors with label, class, folder, and attachment parent — the agent\'s map of the level without dumping the whole world. Filter by folder/class/name.',
  cost: 'low',
  returns: '{ok, nodes:[{actor_id,path,class,folder,attach_parent}], total, has_more, next_offset}',
  schema: outlinerTreeSchema.shape,
  meta: readMeta,
  buildScript: outlinerTreeScript,
  timeoutMs: 30_000,
};

// ── object_inspect ────────────────────────────────────────────────────────────
export const objectInspectSchema = z.object({
  target: z.string().min(1).describe('Object path (e.g. "/Game/BP_Foo.BP_Foo_C") or a level-actor label'),
  filter: z.string().optional().describe('Case-insensitive substring filter on property names'),
  limit: z.number().int().positive().optional().default(80).describe('Max properties returned (pagination)'),
  offset: z.number().int().nonnegative().optional().default(0).describe('Pagination offset'),
});
export type ObjectInspectParams = z.infer<typeof objectInspectSchema>;

function objectInspectScript(p: ObjectInspectParams): string {
  return [
    PY_EDITOR_HELPERS,
    `_target = ${pyStr(p.target)}`,
    `_filter = ${p.filter !== undefined ? pyStr(p.filter) : 'None'}`,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'try:',
    '    obj = None',
    '    try: obj = unreal.load_object(None, _target)',
    '    except Exception: pass',
    '    if obj is None:',
    '        try: obj = unreal.EditorAssetLibrary.load_asset(_target)',
    '        except Exception: pass',
    '    if obj is None:',
    '        eas = _sub("EditorActorSubsystem")',
    '        for a in (eas.get_all_level_actors() if eas else []):',
    '            try:',
    '                if a.get_actor_label() == _target or a.get_path_name() == _target: obj = a; break',
    '            except Exception: pass',
    '    if obj is None: raise Exception("object not found: %s" % _target)',
    '    props = []',
    '    for nm in dir(obj):',
    '        if nm.startswith("_"): continue',
    '        if _filter is not None and _filter.lower() not in nm.lower(): continue',
    '        try: attr = getattr(obj, nm)',
    '        except Exception: continue',
    '        if callable(attr): continue',
    '        try: sval = str(attr)[:200]',
    '        except Exception: sval = None',
    '        props.append({"name": nm, "type": type(attr).__name__, "value": sval})',
    '    total = len(props)',
    '    page = props[_offset:_offset+_limit]',
    '    _emit({"ok": True, "object": obj.get_path_name(), "class": type(obj).__name__,',
    '           "properties": page, "total": total,',
    '           "has_more": (_offset+_limit) < total, "next_offset": _offset+_limit})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const objectInspectDescriptor: PyToolDescriptor<typeof objectInspectSchema.shape> = {
  name: 'object_inspect',
  description:
    'Read the property tree of any live UObject by path (asset or object) or by level-actor label, filtered + paginated. The generic read-back primitive (actor_inspect is the richer level-actor variant). Differs from the legacy object_get_property (C++-backed, reads one CPF_Edit property by exact path, no actor-label resolution): use object_inspect to explore/discover an object\'s shape, object_get_property once you know the exact property path.',
  cost: 'low',
  returns: '{ok, object, class, properties:[{name,type,value}], total, has_more, next_offset}',
  schema: objectInspectSchema.shape,
  meta: readMeta,
  buildScript: objectInspectScript,
  timeoutMs: 30_000,
};

// ── object_exists ─────────────────────────────────────────────────────────────
export const objectExistsSchema = z.object({
  target: z.string().min(1).describe('Object/asset path or level-actor label to test for existence'),
});
export type ObjectExistsParams = z.infer<typeof objectExistsSchema>;

function objectExistsScript(p: ObjectExistsParams): string {
  return [
    PY_EDITOR_HELPERS,
    `_target = ${pyStr(p.target)}`,
    'try:',
    '    found = False; kind = None; path = None',
    '    try:',
    '        if unreal.EditorAssetLibrary.does_asset_exist(_target): found = True; kind = "asset"; path = _target',
    '    except Exception: pass',
    '    if not found:',
    '        try:',
    '            o = unreal.load_object(None, _target)',
    '            if o is not None: found = True; kind = "object"; path = o.get_path_name()',
    '        except Exception: pass',
    '    if not found:',
    '        eas = _sub("EditorActorSubsystem")',
    '        for a in (eas.get_all_level_actors() if eas else []):',
    '            try:',
    '                if a.get_actor_label() == _target or a.get_path_name() == _target:',
    '                    found = True; kind = "actor"; path = a.get_path_name(); break',
    '            except Exception: pass',
    '    _emit({"ok": True, "exists": found, "kind": kind, "path": path})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const objectExistsDescriptor: PyToolDescriptor<typeof objectExistsSchema.shape> = {
  name: 'object_exists',
  description:
    'Existence probe: does an asset path, object path, or level-actor label resolve? Returns {exists, kind}. Cheap guard before a load/edit.',
  cost: 'low',
  returns: '{ok, exists, kind, path}',
  schema: objectExistsSchema.shape,
  meta: readMeta,
  buildScript: objectExistsScript,
  timeoutMs: 30_000,
};

// ── content_browser_sync ──────────────────────────────────────────────────────
export const contentBrowserSyncSchema = z.object({
  asset_paths: z.array(z.string().min(1)).min(1).describe('Content paths to reveal + select in the Content Browser'),
});
export type ContentBrowserSyncParams = z.infer<typeof contentBrowserSyncSchema>;

function contentBrowserSyncScript(p: ContentBrowserSyncParams): string {
  return [
    PY_EDITOR_HELPERS,
    `_paths = ${JSON.stringify(p.asset_paths)}`,
    'try:',
    '    objs = []',
    '    missing = []',
    '    for pth in _paths:',
    '        try:',
    '            o = unreal.EditorAssetLibrary.load_asset(pth)',
    '            if o is not None: objs.append(o)',
    '            else: missing.append(pth)',
    '        except Exception: missing.append(pth)',
    '    synced = False',
    '    if objs:',
    '        try:',
    '            unreal.EditorAssetLibrary.sync_browser_to_objects([o.get_path_name() for o in objs])',
    '            synced = True',
    '        except Exception:',
    '            try:',
    '                unreal.AssetToolsHelpers.get_asset_tools().sync_browser_to_assets(objs)',
    '                synced = True',
    '            except Exception: pass',
    '    if not synced and not objs: raise Exception("no loadable assets to sync")',
    '    if not synced: raise Exception("no available content-browser sync API in this build")',
    '    _emit({"ok": True, "synced": synced, "count": len(objs), "missing": missing})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const contentBrowserSyncDescriptor: PyToolDescriptor<typeof contentBrowserSyncSchema.shape> = {
  name: 'content_browser_sync',
  description:
    'Reveal + select assets in the Content Browser (UI focus). Probes sync_browser_to_objects then the AssetTools fallback; degrades to a structured error if neither exists.',
  cost: 'low',
  returns: '{ok, synced, count, missing[]}',
  schema: contentBrowserSyncSchema.shape,
  meta: uiMeta,
  buildScript: contentBrowserSyncScript,
  timeoutMs: 30_000,
};

// ── reflect_search_types ──────────────────────────────────────────────────────
export const reflectSearchTypesSchema = z.object({
  query: z.string().min(1).describe('Case-insensitive substring to match against type names in the unreal module'),
  limit: z.number().int().positive().optional().default(30).describe('Max matches returned'),
});
export type ReflectSearchTypesParams = z.infer<typeof reflectSearchTypesSchema>;

function reflectSearchTypesScript(p: ReflectSearchTypesParams): string {
  return [
    PY_EDITOR_HELPERS,
    `_q = ${pyStr(p.query)}`,
    `_limit = ${p.limit}`,
    'try:',
    '    q = _q.lower()',
    '    matches = []',
    '    for nm in dir(unreal):',
    '        if nm.startswith("_"): continue',
    '        if q not in nm.lower(): continue',
    '        try: o = getattr(unreal, nm)',
    '        except Exception: continue',
    '        if not isinstance(o, type): continue',
    '        kind = "class"',
    '        try:',
    '            if issubclass(o, unreal.EnumBase): kind = "enum"',
    '            elif issubclass(o, unreal.StructBase): kind = "struct"',
    '        except Exception: pass',
    '        matches.append({"name": nm, "kind": kind})',
    '    total = len(matches)',
    '    page = matches[:_limit]',
    '    _emit({"ok": True, "matches": page, "total": total, "has_more": total > _limit})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const reflectSearchTypesDescriptor: PyToolDescriptor<typeof reflectSearchTypesSchema.shape> = {
  name: 'reflect_search_types',
  description:
    'Fuzzy-search the UE python type system (classes/structs/enums exposed on the unreal module) by name substring. Turns "what\'s the class called?" into one call.',
  cost: 'low',
  returns: '{ok, matches:[{name,kind}], total, has_more}',
  schema: reflectSearchTypesSchema.shape,
  meta: readMeta,
  buildScript: reflectSearchTypesScript,
  timeoutMs: 30_000,
};

// ── reflect_class ─────────────────────────────────────────────────────────────
export const reflectClassSchema = z.object({
  class_path: z.string().min(1).describe('Class name (e.g. "StaticMeshComponent") or full class path'),
});
export type ReflectClassParams = z.infer<typeof reflectClassSchema>;

function reflectClassScript(p: ReflectClassParams): string {
  return [
    PY_EDITOR_HELPERS,
    `_cp = ${pyStr(p.class_path)}`,
    'try:',
    '    o = _resolve_type(_cp)',
    '    if o is None: raise Exception("class not found: %s" % _cp)',
    '    super_chain = []',
    '    try:',
    '        for b in getattr(o, "__mro__", [])[1:]:',
    '            nm = getattr(b, "__name__", None)',
    '            if nm and nm != "object": super_chain.append(nm)',
    '    except Exception: pass',
    '    cdo_summary = None',
    '    try:',
    '        cdo = o.get_default_object()',
    '        names = [k for k in dir(cdo) if not k.startswith("_")][:40]',
    '        summary = []',
    '        for k in names:',
    '            entry = {"name": k}',
    '            try:',
    '                v = getattr(cdo, k)',
    '                if isinstance(v, (str, int, float, bool)) and not callable(v):',
    '                    entry["value"] = v',
    '            except Exception: pass',
    '            summary.append(entry)',
    '        cdo_summary = summary',
    '    except Exception: pass',
    '    _emit({"ok": True, "class": getattr(o, "__name__", _cp), "super_chain": super_chain,',
    '           "cdo_summary": cdo_summary})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const reflectClassDescriptor: PyToolDescriptor<typeof reflectClassSchema.shape> = {
  name: 'reflect_class',
  description:
    'Describe a UClass: python superclass chain (MRO) and CDO default-object attribute names, with values included for simple scalar types (str/int/float/bool) — so agents stop guessing class shapes before spawning/editing. (Class flags/interfaces need C++ reflection — not exposed to python.)',
  cost: 'low',
  returns: '{ok, class, super_chain[], cdo_summary:[{name, value?}]}',
  schema: reflectClassSchema.shape,
  meta: readMeta,
  buildScript: reflectClassScript,
  timeoutMs: 30_000,
};

// ── Aggregate: all editor-domain PyToolDescriptors (spliced in index.ts) ────────
export const editorPyDescriptors: PyToolDescriptor[] = [
  editorGetCameraDescriptor,
  editorCvarGetDescriptor,
  editorCvarSetDescriptor,
  selectionGetDescriptor,
  assetInspectDescriptor,
  outlinerTreeDescriptor,
  objectInspectDescriptor,
  objectExistsDescriptor,
  contentBrowserSyncDescriptor,
  reflectSearchTypesDescriptor,
  reflectClassDescriptor,
] as unknown as PyToolDescriptor[];

/** Editor-domain factory tools that are non-idempotent. None: cvar_set is
 *  retry-safe (idempotent state) and content_browser_sync is a pure UI focus. */
export const EDITOR_NON_IDEMPOTENT: readonly string[] = [];
