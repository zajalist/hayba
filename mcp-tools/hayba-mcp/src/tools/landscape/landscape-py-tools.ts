// Landscape-and-terrain P0/P1 tools, generated as UE Python via the pyTemplate
// factory (see py-tool-factory.ts). Sibling of actor/actor-py-tools.ts,
// editor/editor-py-tools.ts and mesh/mesh-py-tools.ts — same PyToolDescriptor
// shape, same _emit/_err envelope (auto-prepended by runUePythonJson), same
// index.ts splice.
//
// Source of truth for the catalog: docs/plans/2026-06-28-mcp-supertooling-tools.json,
// domain "landscape-and-terrain". We ship the python-feasible, NET-NEW
// read/introspection subset plus the set-to-value reflection writers, and skip
// catalog entries whose only reliable path is the C++ landscape edit-data
// interface (FLandscapeEditDataInterface) or the render/job-envelope pipeline:
//
//   SHIPPED (9):
//     reads  — landscape_list, landscape_inspect, landscape_layer_list,
//              landscape_get_material, landscape_list_splines
//     writes — landscape_set_material (set-to-value), landscape_set_lod_settings
//              (set-to-value), landscape_set_nanite (set-to-value, UNCERTAIN),
//              landscape_add_layer (create-or-reuse LayerInfo → NON_IDEMPOTENT)
//
//   SKIPPED (why):
//     - landscape_import_heightmap / landscape_create_blank → the existing
//       C++ landscape_import handler (surfaced as hayba_import_landscape, and in
//       tool-executor's NON_IDEMPOTENT set) owns real ALandscape creation; python
//       eas.spawn gives a LandscapePlaceholder stub (MEMORY: 5.7 landscape spawn
//       is a placeholder). NET-NEW would be a C++ change, out of scope here.
//     - landscape_import_gaea_build / landscape_import_weightmaps /
//       landscape_export_heightmap / landscape_sculpt_apply_heightmap /
//       landscape_paint_by_rule → all require FLandscapeEditDataInterface
//       (Get/SetHeightData, Get/SetAlphaData); NOT exposed to python in 5.7.
//       C++ handlers, deferred.
//     - landscape_transaction → FScopedTransaction bundle is C++.
//     - landscape_validate / landscape_dry_run / landscape_capture_topdown →
//       validator-hook / render_camera / buffer-viz MIX tools, separate effort.
//     - landscape_enable_nanite (job-envelope build) → we ship the property
//       TOGGLE (landscape_set_nanite) but the async data rebuild through the
//       job envelope is a C++/pipeline concern; the toggle notes rebuild_needed.
//
//   OVERLAP: hayba_import_landscape (C++ landscape_import) is the importer; none
//   of the tools here import. The actor-domain tools cover generic transform/
//   selection/folder for any actor including landscapes — not re-implemented.
//
// UNCERTAIN-API flags for the next live-validation pass (each checked before use
// so they degrade to a structured value/error rather than a silent wrong
// answer):
//   - Component layout (ComponentSizeQuads / SubsectionSizeQuads / NumSubsections)
//     is read via get_editor_property when the class exports it; degrades to
//     null when the UPROPERTY is not python-exposed.
//   - Target/paint layers: get_target_layers() vs the editor_layer_settings
//     array vs get_editor_property('target_display_order_list') vary across 5.x;
//     all probed, degrades to [].
//   - landscape_set_nanite: the `enable_nanite` editor property exists in 5.x but
//     the data build to actually apply it is not triggered here (rebuild_needed).
//   - landscape_add_layer: LandscapeLayerInfoObject asset factory
//     (LandscapeLayerInfoObjectFactoryNew vs AssetTools.create_asset) is probed;
//     slot binding into the material's layer array may require an editor rebuild.

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

// ── Shared Python: enumerate + resolve landscape actors ───────────────────────
// A landscape "actor" is an ALandscape (primary) or an ALandscapeStreamingProxy
// (world-partition streaming tile); both derive from ALandscapeProxy. We resolve
// a caller ref against get_actor_label first, then get_path_name; an empty ref is
// allowed when the level holds exactly one primary landscape.
// No try/with in this block: native python_run policy HCR-TIME-001 refuses them,
// so _find_landscape returns (landscape, None) | (None, error) for explicit status.
// get/set_editor_property raise on a name the class does not export (hasattr only
// sees BlueprintVisible ones), so _has_prop reads the class docstring, which lists
// every exported property, inherited too, as "- ``name`` (Type):  [Read-Only|Read-Write]".
const PY_LANDSCAPE_HELPERS = [
  'def _eas():',
  '    return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
  'def _all_actors():',
  '    return _eas().get_all_level_actors()',
  'def _is_primary(a):',
  '    return isinstance(a, unreal.Landscape)',
  'def _all_landscapes():',
  '    return [a for a in _all_actors() if isinstance(a, unreal.LandscapeProxy)]',
  'def _has_prop(o, n, writable=False):',
  '    d = type(o).__doc__ or ""',
  '    i = d.find("- ``%s`` " % n)',
  '    if i < 0: return False',
  '    j = d.find("\\n", i)',
  '    return (not writable) or ("[Read-Write]" in d[i:(j if j >= 0 else len(d))])',
  'def _prop(o, n):',
  '    return o.get_editor_property(n) if _has_prop(o, n) else None',
  'def _vec(v):',
  '    return [v.x, v.y, v.z] if v is not None else None',
  'def _mat_path(m):',
  '    return m.get_path_name() if m else None',
  'def _find_landscape(ref):',
  '    lands = _all_landscapes()',
  '    if ref is None or ref == "":',
  '        prim = [a for a in lands if _is_primary(a)]',
  '        if len(prim) == 1: return prim[0], None',
  '        if len(lands) == 1: return lands[0], None',
  '        return None, "landscape ref required: %d landscapes in level" % len(lands)',
  '    for a in lands:',
  '        if a.get_actor_label() == ref or a.get_path_name() == ref: return a, None',
  '    sub = [a for a in lands if ref in a.get_actor_label()]',
  '    if len(sub) == 1: return sub[0], None',
  '    if len(sub) > 1: return None, "ambiguous landscape ref %r matches %d" % (ref, len(sub))',
  '    return None, "landscape not found: %s" % ref',
  'def _layers_of(a):',
  '    out = []',
  '    seen = set()',
  '    infos = a.get_target_layers() if hasattr(a, "get_target_layers") else None',
  '    if infos:',
  '        for k in infos:',
  '            nm = str(k)',
  '            if nm not in seen: seen.add(nm); out.append({"name": nm, "layer_info": None})',
  '    if not out:',
  '        for e in (_prop(a, "editor_layer_settings") or []):',
  '            li = _prop(e, "layer_info_obj")',
  '            nm = str(li.get_editor_property("layer_name")) if li and _has_prop(li, "layer_name") else None',
  '            if nm is None and _has_prop(e, "layer_name"): nm = str(e.get_editor_property("layer_name"))',
  '            if nm and nm not in seen:',
  '                seen.add(nm); out.append({"name": nm, "layer_info": _mat_path(li)})',
  '    return out',
  'def _layout(a):',
  '    return {',
  '        "component_size_quads": _prop(a, "component_size_quads"),',
  '        "subsection_size_quads": _prop(a, "subsection_size_quads"),',
  '        "num_subsections": _prop(a, "num_subsections"),',
  '    }',
].join('\n');

const readMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'inspecting landscapes/terrain before a sculpt, paint, or material write (the read half of the inspect-then-edit loop)',
  not_when: 'you already hold a fresh read-back from a prior call',
};

const writeMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['mutates_actor'],
  when: 'editing a landscape actor property (material, LOD, nanite, layer) and you want structured read-back in one call',
  not_when: 'importing or sculpting height/weight data — that is the C++ landscape_import / edit-data path',
};

// ── landscape_list ────────────────────────────────────────────────────────────
export const landscapeListSchema = z.object({
  name_filter: z.string().optional().describe('Case-insensitive substring match on the actor label'),
  limit: z.number().int().positive().optional().default(50).describe('Max landscapes returned (pagination)'),
  offset: z.number().int().nonnegative().optional().default(0).describe('Pagination offset'),
});
export type LandscapeListParams = z.infer<typeof landscapeListSchema>;

function listScript(p: LandscapeListParams): string {
  return [
    PY_LANDSCAPE_HELPERS,
    `_filter = ${p.name_filter !== undefined ? pyStr(p.name_filter) : 'None'}`,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'matched = []',
    'for a in _all_landscapes():',
    '    lbl = a.get_actor_label()',
    '    if _filter is not None and _filter.lower() not in lbl.lower(): continue',
    '    matched.append(a)',
    'total = len(matched)',
    'page = matched[_offset:_offset+_limit]',
    'out = []',
    'for a in page:',
    '    origin, ext = a.get_actor_bounds(False); bounds = {"origin": _vec(origin), "extent": _vec(ext)}',
    '    out.append({"actor_label": a.get_actor_label(), "path": a.get_path_name(),',
    '                "class": type(a).__name__, "is_primary": _is_primary(a),',
    '                "layout": _layout(a), "material": _mat_path(_prop(a, "landscape_material")),',
    '                "scale": _vec(a.get_actor_scale3d()), "world_bounds": bounds,',
    '                "layer_count": len(_layers_of(a))})',
    '_emit({"ok": True, "landscapes": out, "total": total, "has_more": (_offset+_limit) < total, "next_offset": _offset+_limit})',
  ].join('\n');
}

export const landscapeListDescriptor: PyToolDescriptor<typeof landscapeListSchema.shape> = {
  name: 'landscape_list',
  description:
    'Enumerate all landscape actors + streaming proxies in the level with component layout, scale, material, world bounds and paint-layer count. Paginated. The read entry point so agents stop guessing landscape actor names.',
  cost: 'low',
  returns:
    '{ok, landscapes:[{actor_label,path,class,is_primary,layout:{component_size_quads,subsection_size_quads,num_subsections},material,scale,world_bounds,layer_count}], total, has_more, next_offset}',
  schema: landscapeListSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: listScript,
  timeoutMs: 30_000,
};

// ── landscape_inspect ─────────────────────────────────────────────────────────
export const landscapeInspectSchema = z.object({
  actor_label: z.string().optional().describe('Landscape actor label or full path. Omit when the level has exactly one landscape.'),
});
export type LandscapeInspectParams = z.infer<typeof landscapeInspectSchema>;

function inspectScript(p: LandscapeInspectParams): string {
  return [
    PY_LANDSCAPE_HELPERS,
    `_ref = ${p.actor_label !== undefined ? pyStr(p.actor_label) : 'None'}`,
    'a, _msg = _find_landscape(_ref)',
    'if a is None:',
    '    _err(_msg)',
    'else:',
    '    warnings = []',
    '    layout = _layout(a)',
    '    if layout.get("component_size_quads") is None: warnings.append("component layout not python-exposed")',
    '    origin, ext = a.get_actor_bounds(False); bounds = {"origin": _vec(origin), "extent": _vec(ext)}',
    '    layers = _layers_of(a)',
    '    for ly in layers:',
    '        if ly.get("layer_info") is None: warnings.append("layer %s has no LayerInfo bound" % ly.get("name"))',
    '    proxies = []',
    '    for pr in _all_landscapes():',
    '        if pr is a: continue',
    '        if not _is_primary(pr):',
    '            proxies.append({"label": pr.get_actor_label(), "loaded": True})',
    '    _emit({"ok": True, "actor_label": a.get_actor_label(), "path": a.get_path_name(),',
    '           "class": type(a).__name__, "is_primary": _is_primary(a), "layout": layout,',
    '           "scale": _vec(a.get_actor_scale3d()), "location": _vec(a.get_actor_location()),',
    '           "world_bounds": bounds, "material": _mat_path(_prop(a, "landscape_material")),',
    '           "hole_material": _mat_path(_prop(a, "landscape_hole_material")),',
    '           "layers": layers, "proxies": proxies, "warnings": warnings})',
  ].join('\n');
}

export const landscapeInspectDescriptor: PyToolDescriptor<typeof landscapeInspectSchema.shape> = {
  name: 'landscape_inspect',
  description:
    'Deep brief of one landscape: component/subsection layout, XYZ scale, world bounds, material + hole material, paint layers with LayerInfo binding, streaming proxies, and a warnings[] list (missing layout/LayerInfo). The paired read for every landscape write op.',
  cost: 'low',
  returns:
    '{ok, actor_label, path, class, is_primary, layout, scale, location, world_bounds, material, hole_material, layers:[{name,layer_info}], proxies:[{label,loaded}], warnings[]}',
  schema: landscapeInspectSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: inspectScript,
  timeoutMs: 30_000,
};

// ── landscape_layer_list ──────────────────────────────────────────────────────
export const landscapeLayerListSchema = z.object({
  actor_label: z.string().optional().describe('Landscape actor label or full path. Omit when the level has exactly one landscape.'),
});
export type LandscapeLayerListParams = z.infer<typeof landscapeLayerListSchema>;

function layerListScript(p: LandscapeLayerListParams): string {
  return [
    PY_LANDSCAPE_HELPERS,
    `_ref = ${p.actor_label !== undefined ? pyStr(p.actor_label) : 'None'}`,
    'a, _msg = _find_landscape(_ref)',
    'if a is None:',
    '    _err(_msg)',
    'else:',
    '    layers = _layers_of(a)',
    '    for ly in layers:',
    '        ly["weightmap_present"] = ly.get("layer_info") is not None',
    '    warnings = []',
    '    if not layers:',
    '        warnings.append("both get_target_layers() and editor_layer_settings returned no layers — landscape may have no layer info, or probes may be failing")',
    '    result = {"ok": True, "actor_label": a.get_actor_label(), "layers": layers, "count": len(layers)}',
    '    if warnings: result["warnings"] = warnings',
    '    _emit(result)',
  ].join('\n');
}

export const landscapeLayerListDescriptor: PyToolDescriptor<typeof landscapeLayerListSchema.shape> = {
  name: 'landscape_layer_list',
  description:
    'List the paint layers on a landscape with their LayerInfo asset and whether a weightmap is bound — the read tool that exposes painting state before a paint/add-layer write. Includes a warnings[] list when both probes (get_target_layers/editor_layer_settings) return empty.',
  cost: 'low',
  returns: '{ok, actor_label, layers:[{name,layer_info,weightmap_present}], count, warnings?}',
  schema: landscapeLayerListSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: layerListScript,
  timeoutMs: 30_000,
};

// ── landscape_get_material ────────────────────────────────────────────────────
export const landscapeGetMaterialSchema = z.object({
  actor_label: z.string().optional().describe('Landscape actor label or full path. Omit when the level has exactly one landscape.'),
});
export type LandscapeGetMaterialParams = z.infer<typeof landscapeGetMaterialSchema>;

function getMaterialScript(p: LandscapeGetMaterialParams): string {
  return [
    PY_LANDSCAPE_HELPERS,
    `_ref = ${p.actor_label !== undefined ? pyStr(p.actor_label) : 'None'}`,
    'a, _msg = _find_landscape(_ref)',
    'if a is None:',
    '    _err(_msg)',
    'else:',
    '    _emit({"ok": True, "actor_label": a.get_actor_label(),',
    '           "material": _mat_path(_prop(a, "landscape_material")),',
    '           "hole_material": _mat_path(_prop(a, "landscape_hole_material"))})',
  ].join('\n');
}

export const landscapeGetMaterialDescriptor: PyToolDescriptor<typeof landscapeGetMaterialSchema.shape> = {
  name: 'landscape_get_material',
  description: 'Read the assigned landscape material and hole material asset paths.',
  cost: 'low',
  returns: '{ok, actor_label, material, hole_material}',
  schema: landscapeGetMaterialSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: getMaterialScript,
  timeoutMs: 30_000,
};

// ── landscape_list_splines ────────────────────────────────────────────────────
export const landscapeListSplinesSchema = z.object({
  actor_label: z.string().optional().describe('Landscape actor label or full path. Omit when the level has exactly one landscape.'),
});
export type LandscapeListSplinesParams = z.infer<typeof landscapeListSplinesSchema>;

function listSplinesScript(p: LandscapeListSplinesParams): string {
  return [
    PY_LANDSCAPE_HELPERS,
    `_ref = ${p.actor_label !== undefined ? pyStr(p.actor_label) : 'None'}`,
    'a, _msg = _find_landscape(_ref)',
    'if a is None:',
    '    _err(_msg)',
    'else:',
    '    out = []',
    '    for c in a.get_components_by_class(unreal.LandscapeSplinesComponent):',
    '        cps = _prop(c, "control_points")',
    '        segs = _prop(c, "segments")',
    '        out.append({"component": c.get_name(),',
    '                    "control_points": (len(cps) if cps is not None else None),',
    '                    "segments": (len(segs) if segs is not None else None)})',
    '    _emit({"ok": True, "actor_label": a.get_actor_label(), "spline_components": out, "count": len(out)})',
  ].join('\n');
}

export const landscapeListSplinesDescriptor: PyToolDescriptor<typeof landscapeListSplinesSchema.shape> = {
  name: 'landscape_list_splines',
  description:
    'List the LandscapeSplinesComponents on a landscape with control-point and segment counts — read tool for spline-driven roads/rivers before editing.',
  cost: 'low',
  returns: '{ok, actor_label, spline_components:[{component,control_points,segments}], count}',
  schema: landscapeListSplinesSchema.shape,
  meta: readMeta,
  readOnly: true,
  buildScript: listSplinesScript,
  timeoutMs: 30_000,
};

// ── landscape_set_material ────────────────────────────────────────────────────
export const landscapeSetMaterialSchema = z.object({
  actor_label: z.string().optional().describe('Landscape actor label or full path. Omit when the level has exactly one landscape.'),
  material_path: z.string().min(1).describe('Content path of the landscape material to assign, e.g. "/Game/Materials/M_Landscape"'),
});
export type LandscapeSetMaterialParams = z.infer<typeof landscapeSetMaterialSchema>;

function setMaterialScript(p: LandscapeSetMaterialParams): string {
  return [
    PY_LANDSCAPE_HELPERS,
    `_ref = ${p.actor_label !== undefined ? pyStr(p.actor_label) : 'None'}`,
    `_mat = ${pyStr(p.material_path)}`,
    'a, _msg = _find_landscape(_ref)',
    'mat = unreal.load_asset(_mat)',
    'if a is None:',
    '    _err(_msg)',
    'elif mat is None:',
    '    _err("material not found: %s" % _mat)',
    'elif not isinstance(mat, unreal.MaterialInterface):',
    '    _err("not a MaterialInterface: %s (%s)" % (_mat, type(mat).__name__))',
    'else:',
    '    a.set_editor_property("landscape_material", mat)',
    '    _rb = _mat_path(_prop(a, "landscape_material"))',
    '    _applied = (_rb == _mat)',
    '    _warnings = [] if _applied else ["landscape_material readback (%s) does not match assigned (%s) — write did not stick" % (_rb, _mat)]',
    '    _emit({"ok": _applied, "actor_label": a.get_actor_label(), "assigned": _mat,',
    '           "applied": _applied, "readback": _rb, "warnings": _warnings})',
  ].join('\n');
}

export const landscapeSetMaterialDescriptor: PyToolDescriptor<typeof landscapeSetMaterialSchema.shape> = {
  name: 'landscape_set_material',
  description:
    'Assign/swap the landscape material asset and read it back. Set-to-value (retry-safe). NOTE: after a material change with new layer slots, layer painting may need a rebuild; use landscape_inspect to check LayerInfo bindings.',
  cost: 'low',
  returns: '{ok, actor_label, assigned, applied, readback, warnings[]}',
  schema: landscapeSetMaterialSchema.shape,
  meta: writeMeta,
  buildScript: setMaterialScript,
  timeoutMs: 30_000,
};

// ── landscape_set_lod_settings ────────────────────────────────────────────────
export const landscapeSetLodSettingsSchema = z.object({
  actor_label: z.string().optional().describe('Landscape actor label or full path. Omit when the level has exactly one landscape.'),
  lod_distribution: z.number().positive().optional().describe('LODDistributionSetting (higher = LODs kick in nearer). Left unchanged when omitted.'),
  scalability_lod_bias: z.number().int().optional().describe('LODBias-style scalability bias. Left unchanged when omitted.'),
});
export type LandscapeSetLodSettingsParams = z.infer<typeof landscapeSetLodSettingsSchema>;

function setLodSettingsScript(p: LandscapeSetLodSettingsParams): string {
  return [
    PY_LANDSCAPE_HELPERS,
    `_ref = ${p.actor_label !== undefined ? pyStr(p.actor_label) : 'None'}`,
    `_dist = ${p.lod_distribution !== undefined ? String(p.lod_distribution) : 'None'}`,
    `_bias = ${p.scalability_lod_bias !== undefined ? String(p.scalability_lod_bias) : 'None'}`,
    'a, _msg = _find_landscape(_ref)',
    '# Both writes are checked before either is made, so a bad field never leaves a half-applied edit.',
    '_bias_prop = "lod_bias_scalar" if a is not None and _has_prop(a, "lod_bias_scalar", True) else "scalability_lod_bias"',
    'if _dist is None and _bias is None:',
    '    _err("provide at least one of lod_distribution / scalability_lod_bias")',
    'elif a is None:',
    '    _err(_msg)',
    'elif _dist is not None and not _has_prop(a, "lod_distribution_setting", True):',
    '    _err("lod_distribution_setting is not settable on %s" % type(a).__name__)',
    'elif _bias is not None and not _has_prop(a, _bias_prop, True):',
    '    _err("no settable LOD bias property (lod_bias_scalar / scalability_lod_bias) on %s" % type(a).__name__)',
    'else:',
    '    applied = {}',
    '    if _dist is not None:',
    '        a.set_editor_property("lod_distribution_setting", _dist); applied["lod_distribution"] = _dist',
    '    if _bias is not None:',
    '        a.set_editor_property(_bias_prop, _bias)',
    '        applied["scalability_lod_bias"] = _bias',
    '    _emit({"ok": True, "actor_label": a.get_actor_label(), "applied": applied,',
    '           "lod_distribution_readback": _prop(a, "lod_distribution_setting")})',
  ].join('\n');
}

export const landscapeSetLodSettingsDescriptor: PyToolDescriptor<typeof landscapeSetLodSettingsSchema.shape> = {
  name: 'landscape_set_lod_settings',
  description:
    'Set landscape LOD distribution and/or scalability bias (set-to-value, retry-safe). Omitted fields are left unchanged. Returns the applied values + read-back.',
  cost: 'low',
  returns: '{ok, actor_label, applied, lod_distribution_readback}',
  schema: landscapeSetLodSettingsSchema.shape,
  meta: writeMeta,
  buildScript: setLodSettingsScript,
  timeoutMs: 30_000,
};

// ── landscape_set_nanite ──────────────────────────────────────────────────────
export const landscapeSetNaniteSchema = z.object({
  actor_label: z.string().optional().describe('Landscape actor label or full path. Omit when the level has exactly one landscape.'),
  enable: z.boolean().describe('Enable or disable Nanite on the landscape'),
});
export type LandscapeSetNaniteParams = z.infer<typeof landscapeSetNaniteSchema>;

function setNaniteScript(p: LandscapeSetNaniteParams): string {
  return [
    PY_LANDSCAPE_HELPERS,
    `_ref = ${p.actor_label !== undefined ? pyStr(p.actor_label) : 'None'}`,
    `_enable = ${p.enable ? 'True' : 'False'}`,
    'a, _msg = _find_landscape(_ref)',
    'if a is None:',
    '    _err(_msg)',
    'elif not _has_prop(a, "enable_nanite", True):',
    '    _err("enable_nanite is not settable on %s" % type(a).__name__)',
    'else:',
    '    a.set_editor_property("enable_nanite", _enable)',
    '    _rb = bool(_prop(a, "enable_nanite"))',
    '    _applied = (_rb == _enable)',
    '    _emit({"ok": _applied, "actor_label": a.get_actor_label(),',
    '           "nanite_enabled": _rb, "applied": _applied,',
    '           "warnings": ([] if _applied else ["enable_nanite readback (%s) does not match requested (%s) — write did not stick" % (_rb, _enable)]),',
    '           "rebuild_needed": True,',
    '           "note": "Nanite data rebuild is not triggered from python; rebuild via Build > Build Nanite or the C++ job envelope."})',
  ].join('\n');
}

export const landscapeSetNaniteDescriptor: PyToolDescriptor<typeof landscapeSetNaniteSchema.shape> = {
  name: 'landscape_set_nanite',
  description:
    'Toggle the landscape enable_nanite property (set-to-value, retry-safe). Does NOT trigger the Nanite data rebuild (returns rebuild_needed:true). UNCERTAIN-API: the property exists in 5.x but the apply-build path is C++/pipeline.',
  cost: 'low',
  returns: '{ok, actor_label, nanite_enabled, applied, warnings[], rebuild_needed, note}',
  schema: landscapeSetNaniteSchema.shape,
  meta: writeMeta,
  buildScript: setNaniteScript,
  timeoutMs: 30_000,
};

// ── landscape_add_layer ───────────────────────────────────────────────────────
export const landscapeAddLayerSchema = z.object({
  layer_name: z.string().min(1).describe('Paint-layer name to author a LayerInfo for (matches the material Landscape Layer Blend slot)'),
  layer_info_path: z.string().min(1).describe('Content path for the LandscapeLayerInfoObject asset, e.g. "/Game/Landscape/LI_Rock"'),
  weight_blend: z.boolean().optional().default(true).describe('bNoWeightBlend=false (normal weight-blended layer) when true'),
});
export type LandscapeAddLayerParams = z.infer<typeof landscapeAddLayerSchema>;

function addLayerScript(p: LandscapeAddLayerParams): string {
  return [
    PY_LANDSCAPE_HELPERS,
    `_name = ${pyStr(p.layer_name)}`,
    `_path = ${pyStr(p.layer_info_path)}`,
    `_wb = ${p.weight_blend ? 'True' : 'False'}`,
    'pkg, _, asset_name = _path.rpartition("/")',
    'existing = unreal.load_asset(_path) if pkg else None',
    'li = existing',
    'created = False',
    '_msg = None',
    'if not pkg:',
    '    _msg = "layer_info_path must be a content path like /Game/Landscape/LI_Rock: %s" % _path',
    'elif existing is not None and not isinstance(existing, unreal.LandscapeLayerInfoObject):',
    '    _msg = "not a LandscapeLayerInfoObject: %s (%s)" % (_path, type(existing).__name__)',
    'elif existing is None and not hasattr(unreal, "LandscapeLayerInfoObjectFactory"):',
    '    _msg = "could not create LayerInfo %s: unreal.LandscapeLayerInfoObjectFactory is not available in this engine" % _path',
    'elif existing is None:',
    '    tools = unreal.AssetToolsHelpers.get_asset_tools()',
    '    factory = unreal.LandscapeLayerInfoObjectFactory()',
    '    li = tools.create_asset(asset_name, pkg, unreal.LandscapeLayerInfoObject, factory)',
    '    created = True',
    '    if li is None: _msg = "could not create/load LayerInfo: %s" % _path',
    'if _msg is not None:',
    '    _err(_msg)',
    'else:',
    '    # Each write is skipped when this engine exports the property read-only or not at all.',
    '    if _has_prop(li, "layer_name", True): li.set_editor_property("layer_name", unreal.Name(_name))',
    '    if _has_prop(li, "no_weight_blend", True): li.set_editor_property("no_weight_blend", (not _wb))',
    '    unreal.EditorAssetLibrary.save_loaded_asset(li)',
    '    _emit({"ok": True, "layer_name": _name, "layer_info_path": li.get_path_name(),',
    '           "created": created, "weight_blend": _wb})',
  ].join('\n');
}

export const landscapeAddLayerDescriptor: PyToolDescriptor<typeof landscapeAddLayerSchema.shape> = {
  name: 'landscape_add_layer',
  description:
    'Create (or reuse if present) a LandscapeLayerInfoObject asset for a named paint layer — the prerequisite for any painting. Reuses an existing asset at the path (retry-safe read-back), but is classified NON-IDEMPOTENT as an asset-create lifecycle op. UNCERTAIN-API: binding into the landscape material slot may require an editor rebuild.',
  cost: 'medium',
  returns: '{ok, layer_name, layer_info_path, created, weight_blend}',
  schema: landscapeAddLayerSchema.shape,
  meta: { ...writeMeta, cost: 'medium', effects: ['creates_asset'] },
  buildScript: addLayerScript,
  timeoutMs: 30_000,
};

// ── Aggregate: all landscape-domain PyToolDescriptors (spliced in index.ts) ────
export const landscapePyDescriptors: PyToolDescriptor[] = [
  landscapeListDescriptor,
  landscapeInspectDescriptor,
  landscapeLayerListDescriptor,
  landscapeGetMaterialDescriptor,
  landscapeListSplinesDescriptor,
  landscapeSetMaterialDescriptor,
  landscapeSetLodSettingsDescriptor,
  landscapeSetNaniteDescriptor,
  landscapeAddLayerDescriptor,
] as unknown as PyToolDescriptor[];

/** Names of landscape-domain factory tools that are non-idempotent (asset-create). */
export const LANDSCAPE_NON_IDEMPOTENT: readonly string[] = [landscapeAddLayerDescriptor.name];
