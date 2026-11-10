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
// UNCERTAIN-API flags for the next live-validation pass. No template uses
// try/with or getattr (native python_run policy refuses them): optional APIs are
// probed with hasattr, expected misses go through _err, anything else propagates
// and runUePythonJson reports it.
//   - editor_get_camera: get_level_viewport_camera_info() return arity varies by
//     engine build ((loc,rot) vs (bool,loc,rot)) — both shapes handled.
//   - content_browser_sync: sync_browser_to_objects vs AssetTools
//     sync_browser_to_assets — both probed; degrades to error if neither exists.
//   - reflect_class: python exposes no clean UClass flag/interface reflection;
//     we walk the python type mro() + CDO defaults and report what we can.
//   - object_inspect / reflect_class read values with get_editor_property for the
//     names the type docstring lists as ``name`` properties (no getattr).
//   - reflect_search_types: without getattr the type objects are unreachable, so
//     kind (class/struct/enum) is None.

import { z } from 'zod';
import { AssetPreparationPolicySchema } from '../workflows/contracts.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

// ── Shared Python helpers (editor subsystems) ─────────────────────────────────
// No try/with/getattr here: native python_run policy refuses try/with
// (HCR-TIME-001) and getattr (HCR-DYNAMIC-001), and this block is prepended to
// every editor tool. Callers pass the subsystem class directly.
const PY_EDITOR_HELPERS = [
  'def _sub(cls):',
  '    return unreal.get_editor_subsystem(cls)',
  'def _vec(v):',
  '    return [v.x, v.y, v.z] if v is not None else None',
  'def _rot(r):',
  '    return [r.roll, r.pitch, r.yaw] if r is not None else None',
].join('\n');

// Reflection resolve, only reflect_class needs it. getattr is refused, so the
// class name (and its E-stripped enum form) is emitted as a static unreal.<Name>
// read; only CamelCase identifiers qualify, so caller text never becomes code.
function pyResolveType(cp: string): string {
  const names = [cp, cp.length > 1 && cp.startsWith('E') ? cp.slice(1) : '']
    .filter((n) => /^[A-Z][A-Za-z0-9_]*$/.test(n) && !['None', 'True', 'False'].includes(n));
  return [
    'def _resolve_type(nm):',
    ...names.map((n) => `    if hasattr(unreal, "${n}"): return unreal.${n}`),
    '    if nm.startswith("/"): return unreal.load_class(None, nm)',
    '    return None',
  ].join('\n');
}

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
    'ues = _sub(unreal.UnrealEditorSubsystem)',
    'info = ues.get_level_viewport_camera_info() if ues is not None else None',
    'loc = None; rot = None',
    'if isinstance(info, tuple):',
    '    # ((loc,rot)) or (bool, loc, rot) depending on engine build',
    '    parts = [x for x in info if not isinstance(x, bool)]',
    '    if len(parts) >= 2: loc, rot = parts[0], parts[1]',
    'if ues is None:',
    '    _err("UnrealEditorSubsystem unavailable")',
    'elif loc is None:',
    '    _err("get_level_viewport_camera_info returned no transform")',
    'else:',
    '    _emit({"ok": True, "location": _vec(loc), "rotation": _rot(rot)})',
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
  readOnly: true,
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
    'if _type == "int":',
    '    val = unreal.SystemLibrary.get_console_variable_int_value(_name)',
    'elif _type == "bool":',
    '    val = unreal.SystemLibrary.get_console_variable_bool_value(_name)',
    'else:',
    '    val = unreal.SystemLibrary.get_console_variable_float_value(_name)',
    '# Existence probe: prefer the string getter when this engine build has one.',
    'verified = False; str_val = None',
    'note = "no cvar-existence probe available on this engine build; value may be a type-default for an unknown/mistyped name"',
    'if hasattr(unreal.SystemLibrary, "get_console_variable_string_value"):',
    '    str_val = unreal.SystemLibrary.get_console_variable_string_value(_name)',
    '    verified = bool(str_val is not None and str(str_val) != "")',
    '    note = None if verified else "cvar not found (empty string readback) — value is a type-default, not a real reading"',
    '_emit({"ok": True, "name": _name, "type": _type, "type_assumed": _type_assumed,',
    '       "value": val, "verified": verified, "string_value": str_val, "note": note})',
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
  readOnly: true,
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
    'unreal.SystemLibrary.execute_console_command(None, "%s %s" % (_name, _val))',
    '# Read back (float getter is the most forgiving) to confirm the applied value.',
    'applied = unreal.SystemLibrary.get_console_variable_float_value(_name)',
    '# Same existence caveat as editor_cvar_get: the float getter returns 0.0 for a',
    '# nonexistent cvar, so a typo would otherwise look like a successful set-to-0.',
    'verified = False; _ok = True',
    'note = "no cvar-existence probe available on this engine build; applied may be a type-default if the name is wrong"',
    'if hasattr(unreal.SystemLibrary, "get_console_variable_string_value"):',
    '    sv = unreal.SystemLibrary.get_console_variable_string_value(_name)',
    '    verified = bool(sv is not None and str(sv) != "")',
    '    note = None',
    '    if not verified:',
    '        note = "cvar not found after set (empty string readback) — the name is likely mistyped"',
    '        _ok = False',  // definitive not-found → honest failure, not a silent set-to-0
    '_emit({"ok": _ok, "name": _name, "requested": _val, "applied": applied, "verified": verified, "note": note})',
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
    'eas = _sub(unreal.EditorActorSubsystem)',
    'actors = []',
    'if eas is not None:',
    '    for a in eas.get_selected_level_actors():',
    '        actors.append({"actor_id": a.get_actor_label(), "path": a.get_path_name(), "class": type(a).__name__})',
    'assets = [asset.get_path_name() for asset in unreal.EditorUtilityLibrary.get_selected_assets()]',
    'comps = []',
    'if hasattr(unreal.EditorUtilityLibrary, "get_selected_components"):',
    '    for c in unreal.EditorUtilityLibrary.get_selected_components():',
    '        comps.append({"class": type(c).__name__, "name": c.get_name()})',
    '_emit({"ok": True, "actors": actors, "assets": assets, "components": comps,',
    '       "actor_count": len(actors), "asset_count": len(assets)})',
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
  readOnly: true,
  buildScript: selectionGetScript,
  timeoutMs: 30_000,
};

// ── asset_inspect ─────────────────────────────────────────────────────────────
export const assetInspectSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the asset, e.g. "/Game/Meshes/SM_Rock"'),
  preparation_policy: AssetPreparationPolicySchema.optional().describe('Inspect preparation decisions and native evidence for a StaticMesh'),
});
export type AssetInspectParams = z.infer<typeof assetInspectSchema>;

function assetInspectScript(p: AssetInspectParams): string {
  return [
    PY_EDITOR_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    'if not unreal.EditorAssetLibrary.does_asset_exist(_path):',
    '    _err("asset not found: %s" % _path)',
    'else:',
    '    ar = unreal.AssetRegistryHelpers.get_asset_registry()',
    '    obj = unreal.EditorAssetLibrary.load_asset(_path)',
    '    cls = type(obj).__name__ if obj is not None else None',
    '    pkg = obj.get_outermost() if obj is not None else None',
    '    dirty = bool(pkg.is_dirty()) if pkg is not None and hasattr(pkg, "is_dirty") else False',
    '    pn = unreal.Name(_path.split(".")[0])',
    '    # get_dependencies/get_referencers take the options struct as a required argument.',
    '    opts = unreal.AssetRegistryDependencyOptions()',
    '    deps = ar.get_dependencies(pn, opts)',
    '    refs = ar.get_referencers(pn, opts)',
    '    dep_count = len(deps) if deps is not None else 0',
    '    ref_count = len(refs) if refs is not None else 0',
    '    disk = unreal.EditorAssetLibrary.get_metadata_tag(obj, "DiskSize") if obj is not None else None',
    '    _emit({"ok": True, "asset_path": _path, "class": cls, "dirty": dirty,',
    '           "dep_count": dep_count, "ref_count": ref_count, "disk_size": disk})',
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
  readOnly: true,
  buildScript: assetInspectScript,
  timeoutMs: 30_000,
};

// ── outliner_tree ─────────────────────────────────────────────────────────────
export const outlinerTreeSchema = z.object({
  folder: z.string().optional().describe('Actors in this outliner folder and its descendants, e.g. "Buildings"'),
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
    'if _folder is not None: _folder = _folder.replace("\\\\", "/").strip("/")',
    `_cls = ${p.class_filter !== undefined ? pyStr(p.class_filter) : 'None'}`,
    `_name = ${p.name_filter !== undefined ? pyStr(p.name_filter) : 'None'}`,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'eas = _sub(unreal.EditorActorSubsystem)',
    'nodes = []',
    'for a in eas.get_all_level_actors():',
    '    lbl = a.get_actor_label()',
    '    if _name is not None and _name.lower() not in lbl.lower(): continue',
    '    if _cls is not None and type(a).__name__ != _cls: continue',
    '    fld = str(a.get_folder_path())',
    '    fld = fld.replace("\\\\", "/").strip("/")',
    '    if _folder is not None and _folder and fld != _folder and not fld.startswith(_folder + "/"): continue',
    '    pa = a.get_attach_parent_actor()',
    '    parent = pa.get_actor_label() if pa else None',
    '    nodes.append({"actor_id": lbl, "path": a.get_path_name(),',
    '                  "class": type(a).__name__, "folder": fld, "attach_parent": parent})',
    'total = len(nodes)',
    'page = nodes[_offset:_offset+_limit]',
    '_emit({"ok": True, "nodes": page, "total": total,',
    '       "has_more": (_offset+_limit) < total, "next_offset": _offset+_limit})',
  ].join('\n');
}

export const outlinerTreeDescriptor: PyToolDescriptor<typeof outlinerTreeSchema.shape> = {
  name: 'outliner_tree',
  description:
    'Paginated world outliner: level actors with label, class, folder, and attachment parent — the agent\'s map of the level without dumping the whole world. Folder filters include descendants.',
  cost: 'low',
  returns: '{ok, nodes:[{actor_id,path,class,folder,attach_parent}], total, has_more, next_offset}',
  schema: outlinerTreeSchema.shape,
  meta: readMeta,
  readOnly: true,
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
    'obj = None',
    '# Object and asset paths start with "/"; a level-actor label never does.',
    'if _target.startswith("/"):',
    '    obj = unreal.load_object(None, _target)',
    '    if obj is None: obj = unreal.EditorAssetLibrary.load_asset(_target)',
    'if obj is None:',
    '    eas = _sub(unreal.EditorActorSubsystem)',
    '    for a in (eas.get_all_level_actors() if eas else []):',
    '        if a.get_actor_label() == _target or a.get_path_name() == _target: obj = a; break',
    'if obj is None:',
    '    _err("object not found: %s" % _target)',
    'else:',
    '    # Dynamic attribute reads are refused, so values come from get_editor_property, for the names the',
    '    # type docstring lists as ``name`` properties (methods are never listed there).',
    '    doc = type(obj).__doc__ or ""',
    '    props = []',
    '    for nm in dir(obj):',
    '        if nm.startswith("_"): continue',
    '        if _filter is not None and _filter.lower() not in nm.lower(): continue',
    '        if ("``%s``" % nm) not in doc: continue',
    '        attr = obj.get_editor_property(nm)',
    '        props.append({"name": nm, "type": type(attr).__name__, "value": str(attr)[:200]})',
    '    total = len(props)',
    '    page = props[_offset:_offset+_limit]',
    '    _emit({"ok": True, "object": obj.get_path_name(), "class": type(obj).__name__,',
    '           "properties": page, "total": total,',
    '           "has_more": (_offset+_limit) < total, "next_offset": _offset+_limit})',
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
  readOnly: true,
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
    'found = False; kind = None; path = None',
    '# Object and asset paths start with "/"; a level-actor label never does.',
    'if _target.startswith("/"):',
    '    if unreal.EditorAssetLibrary.does_asset_exist(_target): found = True; kind = "asset"; path = _target',
    '    if not found:',
    '        o = unreal.load_object(None, _target)',
    '        if o is not None: found = True; kind = "object"; path = o.get_path_name()',
    'if not found:',
    '    eas = _sub(unreal.EditorActorSubsystem)',
    '    for a in (eas.get_all_level_actors() if eas else []):',
    '        if a.get_actor_label() == _target or a.get_path_name() == _target:',
    '            found = True; kind = "actor"; path = a.get_path_name(); break',
    '_emit({"ok": True, "exists": found, "kind": kind, "path": path})',
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
  readOnly: true,
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
    'objs = []',
    'missing = []',
    'for pth in _paths:',
    '    o = unreal.EditorAssetLibrary.load_asset(pth) if unreal.EditorAssetLibrary.does_asset_exist(pth) else None',
    '    if o is not None: objs.append(o)',
    '    else: missing.append(pth)',
    'synced = False',
    'if objs:',
    '    if hasattr(unreal.EditorAssetLibrary, "sync_browser_to_objects"):',
    '        unreal.EditorAssetLibrary.sync_browser_to_objects([o.get_path_name() for o in objs])',
    '        synced = True',
    '    else:',
    '        tools = unreal.AssetToolsHelpers.get_asset_tools()',
    '        if hasattr(tools, "sync_browser_to_assets"):',
    '            tools.sync_browser_to_assets(objs)',
    '            synced = True',
    'if not objs:',
    '    _err("no loadable assets to sync")',
    'elif not synced:',
    '    _err("no available content-browser sync API in this build")',
    'else:',
    '    _emit({"ok": True, "synced": synced, "count": len(objs), "missing": missing})',
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
    'q = _q.lower()',
    '# Dynamic attribute reads are refused, so the type objects behind dir() names are out of reach: the',
    '# CamelCase names are the module types, and class/struct/enum is reported as None.',
    'matches = [{"name": nm, "kind": None} for nm in dir(unreal) if nm[:1].isupper() and q in nm.lower()]',
    'total = len(matches)',
    'page = matches[:_limit]',
    '_emit({"ok": True, "matches": page, "total": total, "has_more": total > _limit})',
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
  readOnly: true,
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
    pyResolveType(p.class_path),
    `_cp = ${pyStr(p.class_path)}`,
    'o = _resolve_type(_cp)',
    'if o is None:',
    '    _err("class not found: %s" % _cp)',
    'else:',
    '    # load_class returns a Class object, not a python type: it has no superclass chain here.',
    '    super_chain = [b.__name__ for b in o.mro()[1:] if b.__name__ != "object"] if isinstance(o, type) else []',
    '    cdo_summary = None',
    '    if hasattr(o, "get_default_object"):',
    '        cdo = o.get_default_object()',
    '        # Values via get_editor_property, only for documented ``name`` properties.',
    '        doc = type(cdo).__doc__ or ""',
    '        summary = []',
    '        for k in [k for k in dir(cdo) if not k.startswith("_")][:40]:',
    '            entry = {"name": k}',
    '            if ("``%s``" % k) in doc:',
    '                v = cdo.get_editor_property(k)',
    '                if isinstance(v, (str, int, float, bool)): entry["value"] = v',
    '            summary.append(entry)',
    '        cdo_summary = summary',
    '    _emit({"ok": True, "class": o.__name__ if isinstance(o, type) else _cp, "super_chain": super_chain,',
    '           "cdo_summary": cdo_summary})',
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
  readOnly: true,
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
