// Water system P0 tools, generated as UE Python via the pyTemplate factory
// (see py-tool-factory.ts). Sibling of niagara/niagara-py-tools.ts and
// sequencer/sequencer-py-tools.ts — same PyToolDescriptor shape, same _emit/_err
// envelope, same defensive multi-name probing, same warnings[]+success-flag
// surfacing, same index.ts splice.
//
// Source of truth for the catalog: docs/plans/2026-06-28-mcp-supertooling-tools.json,
// domain "water system".
//
// ── 3-SURFACE OVERLAP AUDIT (mandatory) ──────────────────────────────────────
// (a) src/legacy-commands/sidecar.json          → grep "water": ZERO entries.
// (b) src/tools/*.ts registered MCP tools + code-mode/list-tool-categories.ts
//     DOMAINS                                    → ZERO water tools/domain; no
//     `water_*` command anywhere. No python water tools registered before this
//     file.
// (c) unreal/* satellite plugins & HaybaMCPToolkit GetCommands()
//                                                → ZERO `water_*` compiled
//     commands. The only "water" tokens in unreal/ are cog-map SEMANTIC LABELS
//     (HaybaMCPCogMapBuilder.cpp maps class names River/Ocean/Water → the
//     "water" node bucket); those are graph-classification strings, NOT tool
//     names, so there is no collider.
//
// RESOLUTION: no rename needed — every `water_*` name here is net-new and
// unique across all three surfaces. (Contrast the niagara/sequencer waves, which
// had to dodge dormant C++ commands.)
//
//   SHIPPED (11):
//     water_check_plugin, water_body_list, water_body_inspect,
//     water_body_ocean_create, water_body_lake_create, water_body_river_create,
//     water_waves_inspect, water_waves_set_gerstner, water_zone_create,
//     water_zone_inspect, water_validate.
//
// ── CRITICAL: THE WATER PLUGIN MAY BE DISABLED ───────────────────────────────
//   The Water plugin is off by default in many templates, so EVERY WaterBody*
//   class is simply absent from `unreal.*`. water_check_plugin is the FIRST tool
//   and the honest gate: it probes hasattr(unreal, "WaterBodyOcean"/"WaterZone"/…)
//   + subsystem readiness and returns a STRUCTURED {enabled, version,
//   water_subsystem_ready, classes} result — it NEVER throws and never
//   fabricates. Every other water tool calls the same `_water_guard()` helper as
//   its first step: if the plugin is not enabled it emits a clean
//   {ok:false, enabled:false, error:"Water plugin not enabled …"} envelope and
//   returns — it does not raise an ImportError / AttributeError and does not
//   pretend to have done work. Degrading cleanly on plugin-absence is the whole
//   point of this domain.
//
// ── SET-SUCCESS FLAGS (the W4T1 lesson: a set that can fail must surface a
//    boolean, never ok:true with an unapplied change) ───────────────────────────
//   UE property setters return void, so we cannot read back a confirmation. Each
//   set path runs a probe-chain and reports applied:true ONLY if a setter ran
//   without raising; applied:false (+ ok:false + a warning) otherwise.
//   water_waves_set_gerstner binds `ok`/`applied` to whether the Gerstner
//   generator was resolved AND at least one parameter setter ran — it never
//   returns ok:true with an unapplied wave change. The *_create tools bind
//   ok to the actor spawn (and surface a `bound_zone`/`spline_applied` flag for
//   the best-effort secondary writes that are UNCERTAIN-API).
//
// ── NON_IDEMPOTENT ───────────────────────────────────────────────────────────
//   water_body_ocean_create / water_body_lake_create / water_body_river_create /
//   water_zone_create spawn a persistent actor — retry would duplicate it. Added
//   to tool-executor's NON_IDEMPOTENT set AND re-exported as
//   WATER_NON_IDEMPOTENT. water_waves_set_gerstner is a set-to-value write
//   (idempotent per the house rule); the rest are reads.
//
// ── WRAP-AND-SKIP (not shipped this wave — P1s / deferred) ────────────────────
//   * water_river_from_path / water_river_spline_get / water_river_spline_set_points
//     — WaterSplineComponent point + WaterSplineMetadata lockstep is version-
//     fragile UNCERTAIN-API; deferred to a live-validation pass. (river_create
//     ships a best-effort point setter that surfaces spline_applied honestly.)
//   * water_body_set_property / _set_material / _set_landscape_affecting /
//     water_brush_rebuild — P1 setters + the game-thread brush rebuild; deferred.
//   * water_zone_set_property, water_bodies_select/_batch_set,
//     water_body_delete, water_transaction_wrap (C++ seam), water_preview_capture
//     — P1s; deferred (delete/transaction/preview lean on other seams).
//
// ── UNCERTAIN-API flags for the next live-validation pass (all wrapped
//    defensively → structured warning/error, never a silent wrong answer) ───────
//   - Plugin version: no reliable python reflection for a plugin's version; the
//     enable-list (PluginBlueprintLibrary.get_enabled_plugin_names) is probed and
//     version stays null with a warning rather than being guessed.
//   - Water subsystem: WaterSubsystem/WaterEditorSubsystem existence + fetch is
//     probed; water_subsystem_ready degrades to false, never throws.
//   - Wave generator: WaterBody(Component).get_water_waves() +
//     GerstnerWaterWaveGeneratorSimple property names (num_waves / wavelengths /
//     steepness / wind angle / seed) are all probed with alternates; anything
//     unresolved surfaces in warnings[].
//   - River spline points + WaterSplineMetadata (width/depth/velocity) are
//     best-effort; spline_applied reports whether the point write actually ran.
//   - WaterZone extent/resolution property names are probed with alternates.

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

// ── Shared Python helpers: plugin probe + clean guard, actor/body/zone
//    resolution, defensive property readers, wave-generator resolution ─────────
const PY_WATER_HELPERS = [
  'import json',
  '_WATER_BODY_CLASSES = ("WaterBody", "WaterBodyOcean", "WaterBodyLake", "WaterBodyRiver")',
  '_WATER_PROBE_CLASSES = ("WaterBodyOcean", "WaterBodyLake", "WaterBodyRiver", "WaterBody", "WaterBodyComponent", "WaterZone")',
  'def _try(*calls):',
  '    # probe-chain; return True on the first call that does not raise',
  '    for c in calls:',
  '        try:',
  '            c(); return True',
  '        except Exception: pass',
  '    return False',
  'def _getp(obj, *names):',
  '    # defensive multi-name editor-property reader; None if none resolve',
  '    for n in names:',
  '        try:',
  '            return obj.get_editor_property(n)',
  '        except Exception: pass',
  '    return None',
  'def _plugin_status():',
  '    # NEVER throws. Structured probe of Water plugin availability.',
  '    warns = []',
  '    classes = {}',
  '    for c in _WATER_PROBE_CLASSES:',
  '        classes[c] = hasattr(unreal, c)',
  '    enabled = bool(classes.get("WaterBodyOcean") and classes.get("WaterZone"))',
  '    subsystem_ready = False',
  '    for sn in ("WaterSubsystem", "WaterEditorSubsystem"):',
  '        if hasattr(unreal, sn):',
  '            try:',
  '                ss = unreal.get_editor_subsystem(getattr(unreal, sn))',
  '                if ss is not None:',
  '                    subsystem_ready = True; break',
  '            except Exception: pass',
  '    plugin_present = None',
  '    try:',
  '        if hasattr(unreal, "PluginBlueprintLibrary"):',
  '            names = list(unreal.PluginBlueprintLibrary.get_enabled_plugin_names())',
  '            plugin_present = any(str(n) == "Water" for n in names)',
  '        else:',
  '            warns.append("plugin enable-list unavailable via python reflection (UNCERTAIN-API)")',
  '    except Exception:',
  '        warns.append("plugin enable-list probe raised (UNCERTAIN-API)")',
  '    # plugin version is not reliably exposed to python reflection',
  '    version = None',
  '    warns.append("plugin version not exposed via python reflection (UNCERTAIN-API)")',
  '    return {"enabled": enabled, "version": version, "water_subsystem_ready": subsystem_ready, "plugin_present": plugin_present, "classes": classes}, warns',
  'def _water_guard():',
  '    # First step of every non-probe tool. Emits a clean disabled envelope and',
  '    # returns (None, warns) if the plugin is off; else returns (status, warns).',
  '    st, warns = _plugin_status()',
  '    if not st["enabled"]:',
  '        _emit({"ok": False, "enabled": False,',
  '               "error": "Water plugin not enabled - enable it via Edit > Plugins > Water and restart the editor",',
  '               "water_status": st, "warnings": warns})',
  '        return None, warns',
  '    return st, warns',
  'def _world():',
  '    try:',
  '        return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()',
  '    except Exception:',
  '        try: return unreal.EditorLevelLibrary.get_editor_world()',
  '        except Exception: return None',
  'def _all_actors():',
  '    try:',
  '        eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
  '        return list(eas.get_all_level_actors()) if eas is not None else []',
  '    except Exception: return []',
  'def _find_actor(ref):',
  '    try:',
  '        o = unreal.load_object(None, ref)',
  '        if isinstance(o, unreal.Actor): return o',
  '    except Exception: pass',
  '    for a in _all_actors():',
  '        try:',
  '            if a.get_actor_label() == ref or a.get_path_name() == ref: return a',
  '        except Exception: pass',
  '    return None',
  'def _is_water_body(a):',
  '    for c in _WATER_BODY_CLASSES:',
  '        k = getattr(unreal, c, None)',
  '        if k is not None:',
  '            try:',
  '                if isinstance(a, k): return True',
  '            except Exception: pass',
  '    return False',
  'def _is_zone(a):',
  '    k = getattr(unreal, "WaterZone", None)',
  '    if k is None: return False',
  '    try: return isinstance(a, k)',
  '    except Exception: return False',
  'def _water_component(a):',
  '    k = getattr(unreal, "WaterBodyComponent", None)',
  '    if k is None: return None',
  '    try:',
  '        c = a.get_component_by_class(k)',
  '        if c is not None: return c',
  '    except Exception: pass',
  '    return None',
  'def _bounds(a):',
  '    try:',
  '        o, e = a.get_actor_bounds(False)',
  '        return {"origin": [o.x, o.y, o.z], "extent": [e.x, e.y, e.z]}',
  '    except Exception: return None',
  'def _covers(zone_b, body_b):',
  '    # AABB containment test in XY (zones bound bodies horizontally)',
  '    if zone_b is None or body_b is None: return None',
  '    try:',
  '        zo = zone_b["origin"]; ze = zone_b["extent"]; bo = body_b["origin"]; be = body_b["extent"]',
  '        for i in (0, 1):',
  '            if bo[i] - be[i] < zo[i] - ze[i]: return False',
  '            if bo[i] + be[i] > zo[i] + ze[i]: return False',
  '        return True',
  '    except Exception: return None',
  'def _get_waves(body):',
  '    comp = _water_component(body)',
  '    for src in (comp, body):',
  '        if src is None: continue',
  '        try:',
  '            w = src.get_water_waves()',
  '            if w is not None: return w',
  '        except Exception: pass',
  '        w = _getp(src, "water_waves", "WaterWaves", "waves")',
  '        if w is not None: return w',
  '    return None',
  'def _get_generator(waves):',
  '    if waves is None: return None',
  '    g = _getp(waves, "gerstner_wave_generator", "waves_generator", "GerstnerWaveGenerator", "generator")',
  '    if g is not None: return g',
  '    for m in ("get_gerstner_waves", "get_generator"):',
  '        try:',
  '            g = getattr(waves, m)()',
  '            if g is not None: return g',
  '        except Exception: pass',
  '    return waves',
  'def _mark_dirty(a):',
  '    _try(lambda: a.modify(), lambda: a.mark_package_dirty())',
].join('\n');

const readMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'discovering or inspecting water bodies / zones / waves before spawning or tuning water',
  not_when: 'spawning or mutating — use water_body_*_create / water_zone_create / water_waves_set_gerstner',
};

const writeMeta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies-world'],
  when: 'placing or tuning water: spawning bodies/zones, setting Gerstner waves',
  not_when: 'reading state — use the water_*_inspect / water_body_list reads',
};

// ── water_check_plugin (FIRST tool, the honest gate) ─────────────────────────
export const waterCheckPluginSchema = z.object({});
export type WaterCheckPluginParams = z.infer<typeof waterCheckPluginSchema>;

function waterCheckPluginScript(_p: WaterCheckPluginParams): string {
  return [
    PY_WATER_HELPERS,
    'def _go():',
    '    st, warns = _plugin_status()',
    '    hint = None',
    '    if not st["enabled"]:',
    '        hint = "Enable the Water plugin (Edit > Plugins > Water) and restart the editor; every water_* tool needs it."',
    '    _emit({"ok": True, "enabled": st["enabled"], "version": st["version"],',
    '           "water_subsystem_ready": st["water_subsystem_ready"],',
    '           "plugin_present": st["plugin_present"], "classes": st["classes"],',
    '           "hint": hint, "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const waterCheckPluginDescriptor: PyToolDescriptor<typeof waterCheckPluginSchema.shape> = {
  name: 'water_check_plugin',
  description:
    'THE honest gate for the water pack: probe whether the Water plugin is enabled (WaterBodyOcean/WaterZone classes present), whether its editor subsystem is ready, and report version/enable-list. Returns a STRUCTURED {enabled,...} result and NEVER throws — call this first so an agent gets an actionable enable hint instead of an AttributeError. Plugin version is UNCERTAIN-API (no python reflection) and stays null with a warning.',
  cost: 'low',
  returns: '{ok, enabled, version, water_subsystem_ready, plugin_present, classes, hint?, warnings[]}',
  schema: waterCheckPluginSchema.shape,
  meta: readMeta,
  buildScript: waterCheckPluginScript,
  timeoutMs: 30_000,
};

// ── water_body_list ──────────────────────────────────────────────────────────
export const waterBodyListSchema = z.object({
  class_filter: z.string().optional().describe('Only return bodies whose class name contains this substring (e.g. "Ocean")'),
  limit: z.number().int().positive().default(30).describe('Max bodies to return'),
  offset: z.number().int().nonnegative().default(0).describe('Offset for pagination'),
});
export type WaterBodyListParams = z.infer<typeof waterBodyListSchema>;

function waterBodyListScript(p: WaterBodyListParams): string {
  return [
    PY_WATER_HELPERS,
    `_filter = ${p.class_filter ? pyStr(p.class_filter) : 'None'}`,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'def _go():',
    '    st, warns = _water_guard()',
    '    if st is None: return',
    '    zones = [z for z in _all_actors() if _is_zone(z)]',
    '    zbounds = []',
    '    for z in zones:',
    '        try: zbounds.append((z.get_path_name(), _bounds(z)))',
    '        except Exception: pass',
    '    bodies = []',
    '    for a in _all_actors():',
    '        if not _is_water_body(a): continue',
    '        cn = type(a).__name__',
    '        if _filter is not None and _filter not in cn: continue',
    '        bb = _bounds(a)',
    '        zone = None',
    '        for zp, zbn in zbounds:',
    '            if _covers(zbn, bb): zone = zp; break',
    '        has_waves = _get_waves(a) is not None',
    '        path = None; label = None',
    '        try: path = a.get_path_name()',
    '        except Exception: pass',
    '        try: label = a.get_actor_label()',
    '        except Exception: pass',
    '        bodies.append({"path": path, "class": cn, "label": label, "zone": zone, "bounds": bb, "has_waves": has_waves})',
    '    bodies = sorted(bodies, key=lambda x: (x.get("path") or ""))',
    '    total = len(bodies)',
    '    page = bodies[_offset:_offset + _limit]',
    '    nxt = _offset + len(page)',
    '    _emit({"ok": True, "enabled": True, "bodies": page, "count": total,',
    '           "has_more": nxt < total, "next_offset": nxt, "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const waterBodyListDescriptor: PyToolDescriptor<typeof waterBodyListSchema.shape> = {
  name: 'water_body_list',
  description:
    'Paginated introspection of all water bodies in the level: class, label, owning-zone binding (AABB containment), bounds and whether waves are attached. The inspection-first read to call before any water mutate. Degrades cleanly to a plugin-disabled envelope if the Water plugin is off.',
  cost: 'low',
  returns: '{ok, enabled, bodies:[{path,class,label,zone,bounds,has_waves}], count, has_more, next_offset, warnings[]}',
  schema: waterBodyListSchema.shape,
  meta: readMeta,
  buildScript: waterBodyListScript,
  timeoutMs: 30_000,
};

// ── water_body_inspect ───────────────────────────────────────────────────────
export const waterBodyInspectSchema = z.object({
  body_path: z.string().min(1).describe('Actor path or label of the water body'),
});
export type WaterBodyInspectParams = z.infer<typeof waterBodyInspectSchema>;

function waterBodyInspectScript(p: WaterBodyInspectParams): string {
  return [
    PY_WATER_HELPERS,
    `_ref = ${pyStr(p.body_path)}`,
    'def _go():',
    '    st, warns = _water_guard()',
    '    if st is None: return',
    '    a = _find_actor(_ref)',
    '    if a is None: raise Exception("water body not found: %s" % _ref)',
    '    if not _is_water_body(a): raise Exception("actor is not a water body: %s (%s)" % (_ref, type(a).__name__))',
    '    comp = _water_component(a)',
    '    component_valid = comp is not None',
    '    if not component_valid: warns.append("no WaterBodyComponent resolved (possible placeholder-stub spawn)")',
    '    props = {}',
    '    src = comp if comp is not None else a',
    '    wz = _getp(src, "water_body_type", "target_wave_mask_depth", "water_height")',
    '    props["water_z"] = None',
    '    try: props["water_z"] = a.get_actor_location().z',
    '    except Exception: pass',
    '    affects = _getp(src, "affects_landscape", "b_affects_landscape")',
    '    materials = {}',
    '    materials["water"] = None; materials["underwater"] = None',
    '    try:',
    '        m = _getp(src, "water_material", "WaterMaterial")',
    '        if m is not None: materials["water"] = m.get_path_name()',
    '    except Exception: pass',
    '    try:',
    '        m = _getp(src, "underwater_material", "UnderwaterPostProcessMaterial")',
    '        if m is not None: materials["underwater"] = m.get_path_name()',
    '    except Exception: pass',
    '    waves = _get_waves(a) is not None',
    '    zone = None',
    '    bb = _bounds(a)',
    '    for z in _all_actors():',
    '        if _is_zone(z) and _covers(_bounds(z), bb): zone = z.get_path_name(); break',
    '    _emit({"ok": True, "enabled": True, "path": _ref, "class": type(a).__name__,',
    '           "component_valid": component_valid, "waves": waves, "materials": materials,',
    '           "affects_landscape": (bool(affects) if affects is not None else None),',
    '           "zone": zone, "bounds": bb, "properties": props, "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const waterBodyInspectDescriptor: PyToolDescriptor<typeof waterBodyInspectSchema.shape> = {
  name: 'water_body_inspect',
  description:
    'Deep read-back of one water body: component validity (catches placeholder-stub spawns), wave presence, water/underwater material refs, affects-landscape flag, owning zone and bounds. The paired read for validate-before/after-mutate. Property/material reflection is probed with alternate names; anything unresolved surfaces in warnings[].',
  cost: 'low',
  returns: '{ok, enabled, path, class, component_valid, waves, materials, affects_landscape, zone, bounds, properties, warnings[]}',
  schema: waterBodyInspectSchema.shape,
  meta: readMeta,
  buildScript: waterBodyInspectScript,
  timeoutMs: 30_000,
};

// ── spawn-body shared script builder (ocean/lake/river share the guard+spawn) ─
function spawnBodyPreamble(cls: string): string[] {
  return [
    PY_WATER_HELPERS,
    'def _bind_zone(actor, zone_ref):',
    '    # best-effort: WaterZone binding is largely automatic by overlap; if a',
    '    # zone_ref is given we just confirm it exists (UNCERTAIN-API for explicit set)',
    '    if zone_ref is None: return None',
    '    z = _find_actor(zone_ref)',
    '    if z is None or not _is_zone(z): return None',
    '    try: return z.get_path_name()',
    '    except Exception: return None',
    'def _spawn(cls_name, loc, rot):',
    '    k = getattr(unreal, cls_name, None)',
    '    if k is None: raise Exception("class unavailable: unreal.%s (Water plugin?)" % cls_name)',
    '    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    '    actor = eas.spawn_actor_from_class(k, unreal.Vector(loc[0], loc[1], loc[2]), unreal.Rotator(rot[0], rot[1], rot[2]))',
    '    if actor is None: raise Exception("spawn_actor_from_class(%s) returned None" % cls_name)',
    '    return actor',
    `_CLS = ${pyStr(cls)}`,
  ];
}

// ── water_body_ocean_create (NON_IDEMPOTENT) ─────────────────────────────────
export const waterBodyOceanCreateSchema = z.object({
  location: z.array(z.number()).length(3).default([0, 0, 0]).describe('World location [x,y,z]'),
  extent: z.array(z.number()).length(3).optional().describe('Optional actor scale [x,y,z] to size the ocean'),
  zone_path: z.string().optional().describe('Optional WaterZone to bind under (confirmed to exist; binding is by overlap)'),
  label: z.string().optional().describe('Optional actor label'),
  dry_run: z.boolean().default(false).describe('Plan without spawning'),
});
export type WaterBodyOceanCreateParams = z.infer<typeof waterBodyOceanCreateSchema>;

function waterBodyOceanCreateScript(p: WaterBodyOceanCreateParams): string {
  return [
    ...spawnBodyPreamble('WaterBodyOcean'),
    `_loc = [${p.location.join(', ')}]`,
    `_extent = ${p.extent ? `[${p.extent.join(', ')}]` : 'None'}`,
    `_zone = ${p.zone_path ? pyStr(p.zone_path) : 'None'}`,
    `_label = ${p.label ? pyStr(p.label) : 'None'}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _go():',
    '    st, warns = _water_guard()',
    '    if st is None: return',
    '    if _dry:',
    '        _emit({"ok": True, "enabled": True, "planned": {"class": _CLS, "location": _loc, "zone": _zone, "label": _label}}); return',
    '    actor = _spawn(_CLS, _loc, [0, 0, 0])',
    '    extent_applied = None',
    '    if _extent is not None:',
    '        extent_applied = bool(_try(lambda: actor.set_actor_scale3d(unreal.Vector(_extent[0], _extent[1], _extent[2]))))',
    '        if not extent_applied: warns.append("extent scale not applied (set_actor_scale3d failed)")',
    '    if _label is not None:',
    '        _try(lambda: actor.set_actor_label(_label))',
    '    bound = _bind_zone(actor, _zone)',
    '    if _zone is not None and bound is None: warns.append("zone_path not found or not a WaterZone; body still spawned (zones bind by overlap)")',
    '    _mark_dirty(actor)',
    '    bp = None',
    '    try: bp = actor.get_path_name()',
    '    except Exception: pass',
    '    _emit({"ok": True, "enabled": True, "body_path": bp, "class": _CLS, "zone": bound, "extent_applied": extent_applied, "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const waterBodyOceanCreateDescriptor: PyToolDescriptor<typeof waterBodyOceanCreateSchema.shape> = {
  name: 'water_body_ocean_create',
  description:
    'Spawn an AWaterBodyOcean at a world location with an optional scale and label, and confirm an optional owning WaterZone (zones bind bodies by overlap). The single most common worldbuilding water op — an outcome verb over raw actor_spawn. NON_IDEMPOTENT (each call spawns a new actor); supports dry_run. Degrades to a plugin-disabled envelope if Water is off.',
  cost: 'medium',
  returns: '{ok, enabled, body_path, class, zone, extent_applied, warnings[], planned?}',
  schema: waterBodyOceanCreateSchema.shape,
  meta: writeMeta,
  buildScript: waterBodyOceanCreateScript,
  timeoutMs: 30_000,
};

// ── water_body_lake_create (NON_IDEMPOTENT) ──────────────────────────────────
export const waterBodyLakeCreateSchema = z.object({
  location: z.array(z.number()).length(3).describe('World location [x,y,z] of the lake center'),
  radius: z.number().positive().optional().describe('Optional footprint radius (applied as uniform actor scale hint)'),
  water_z: z.number().optional().describe('Optional water surface Z (defaults to location Z)'),
  zone_path: z.string().optional().describe('Optional WaterZone to bind under'),
  label: z.string().optional().describe('Optional actor label'),
  dry_run: z.boolean().default(false).describe('Plan without spawning'),
});
export type WaterBodyLakeCreateParams = z.infer<typeof waterBodyLakeCreateSchema>;

function waterBodyLakeCreateScript(p: WaterBodyLakeCreateParams): string {
  return [
    ...spawnBodyPreamble('WaterBodyLake'),
    `_loc = [${p.location.join(', ')}]`,
    `_radius = ${p.radius !== undefined ? p.radius : 'None'}`,
    `_water_z = ${p.water_z !== undefined ? p.water_z : 'None'}`,
    `_zone = ${p.zone_path ? pyStr(p.zone_path) : 'None'}`,
    `_label = ${p.label ? pyStr(p.label) : 'None'}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _go():',
    '    st, warns = _water_guard()',
    '    if st is None: return',
    '    loc = list(_loc)',
    '    if _water_z is not None: loc[2] = _water_z',
    '    if _dry:',
    '        _emit({"ok": True, "enabled": True, "planned": {"class": _CLS, "location": loc, "radius": _radius, "zone": _zone, "label": _label}}); return',
    '    actor = _spawn(_CLS, loc, [0, 0, 0])',
    '    radius_applied = None',
    '    if _radius is not None:',
    '        s = float(_radius) / 100.0',
    '        radius_applied = bool(_try(lambda: actor.set_actor_scale3d(unreal.Vector(s, s, 1.0))))',
    '        if not radius_applied: warns.append("radius scale not applied (set_actor_scale3d failed)")',
    '    if _label is not None:',
    '        _try(lambda: actor.set_actor_label(_label))',
    '    bound = _bind_zone(actor, _zone)',
    '    if _zone is not None and bound is None: warns.append("zone_path not found or not a WaterZone; body still spawned")',
    '    warns.append("lake shoreline spline shaping is UNCERTAIN-API and not applied this wave (default footprint)")',
    '    _mark_dirty(actor)',
    '    bp = None',
    '    try: bp = actor.get_path_name()',
    '    except Exception: pass',
    '    _emit({"ok": True, "enabled": True, "body_path": bp, "class": _CLS, "zone": bound, "radius_applied": radius_applied, "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const waterBodyLakeCreateDescriptor: PyToolDescriptor<typeof waterBodyLakeCreateSchema.shape> = {
  name: 'water_body_lake_create',
  description:
    'Spawn an AWaterBodyLake at a water level with an optional footprint radius and label. Lakes are a core terrain-water feature. NON_IDEMPOTENT; supports dry_run. NOTE: closed-spline shoreline shaping is UNCERTAIN-API and deferred — the body spawns with its default footprint and a warning is surfaced. Degrades cleanly if Water is off.',
  cost: 'medium',
  returns: '{ok, enabled, body_path, class, zone, radius_applied, warnings[], planned?}',
  schema: waterBodyLakeCreateSchema.shape,
  meta: writeMeta,
  buildScript: waterBodyLakeCreateScript,
  timeoutMs: 30_000,
};

// ── water_body_river_create (NON_IDEMPOTENT) ─────────────────────────────────
export const waterBodyRiverCreateSchema = z.object({
  points: z.array(z.array(z.number()).length(3)).min(2).describe('Ordered world-space path [[x,y,z],...] (>=2 points)'),
  width: z.number().positive().default(512).describe('Default river width'),
  depth: z.number().positive().default(256).describe('Default river depth'),
  velocity: z.number().default(125).describe('Default flow velocity'),
  zone_path: z.string().optional().describe('Optional WaterZone to bind under'),
  label: z.string().optional().describe('Optional actor label'),
  dry_run: z.boolean().default(false).describe('Plan without spawning'),
});
export type WaterBodyRiverCreateParams = z.infer<typeof waterBodyRiverCreateSchema>;

function waterBodyRiverCreateScript(p: WaterBodyRiverCreateParams): string {
  return [
    ...spawnBodyPreamble('WaterBodyRiver'),
    `_points = json.loads(${pyStr(JSON.stringify(p.points))})`,
    `_width = ${p.width}`,
    `_depth = ${p.depth}`,
    `_velocity = ${p.velocity}`,
    `_zone = ${p.zone_path ? pyStr(p.zone_path) : 'None'}`,
    `_label = ${p.label ? pyStr(p.label) : 'None'}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _apply_points(actor, pts):',
    '    # best-effort spline write via WaterSplineComponent; returns applied bool',
    '    k = getattr(unreal, "WaterSplineComponent", None)',
    '    spline = None',
    '    if k is not None:',
    '        try: spline = actor.get_component_by_class(k)',
    '        except Exception: spline = None',
    '    if spline is None:',
    '        try: spline = actor.get_component_by_class(unreal.SplineComponent)',
    '        except Exception: spline = None',
    '    if spline is None: return False',
    '    ok = _try(lambda: spline.clear_spline_points(True))',
    '    added = False',
    '    for pt in pts:',
    '        v = unreal.Vector(pt[0], pt[1], pt[2])',
    '        if _try(lambda: spline.add_spline_point(v, unreal.SplineCoordinateSpace.WORLD, True)):',
    '            added = True',
    '    return bool(added)',
    'def _go():',
    '    st, warns = _water_guard()',
    '    if st is None: return',
    '    if _dry:',
    '        _emit({"ok": True, "enabled": True, "planned": {"class": _CLS, "point_count": len(_points), "width": _width, "depth": _depth, "zone": _zone, "label": _label}}); return',
    '    origin = _points[0]',
    '    actor = _spawn(_CLS, origin, [0, 0, 0])',
    '    if _label is not None:',
    '        _try(lambda: actor.set_actor_label(_label))',
    '    spline_applied = _apply_points(actor, _points)',
    '    if not spline_applied: warns.append("river spline point write did not run (WaterSplineComponent UNCERTAIN-API); default 2-point spline in place")',
    '    warns.append("per-point width/depth/velocity metadata (WaterSplineMetadata) is UNCERTAIN-API and not applied this wave")',
    '    bound = _bind_zone(actor, _zone)',
    '    if _zone is not None and bound is None: warns.append("zone_path not found or not a WaterZone; body still spawned")',
    '    _mark_dirty(actor)',
    '    bp = None',
    '    try: bp = actor.get_path_name()',
    '    except Exception: pass',
    '    _emit({"ok": True, "enabled": True, "body_path": bp, "class": _CLS, "point_count": len(_points),',
    '           "spline_applied": spline_applied, "zone": bound, "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const waterBodyRiverCreateDescriptor: PyToolDescriptor<typeof waterBodyRiverCreateSchema.shape> = {
  name: 'water_body_river_create',
  description:
    'Spawn an AWaterBodyRiver following a world-space path (>=2 points). Rivers are the hardest water body to author by hand — this hides the spline wiring. NON_IDEMPOTENT; supports dry_run. SET-SUCCESS: surfaces spline_applied (whether the WaterSplineComponent point write actually ran — UNCERTAIN-API); per-point width/depth/velocity metadata is deferred with a warning. Degrades cleanly if Water is off.',
  cost: 'medium',
  returns: '{ok, enabled, body_path, class, point_count, spline_applied, zone, warnings[], planned?}',
  schema: waterBodyRiverCreateSchema.shape,
  meta: writeMeta,
  buildScript: waterBodyRiverCreateScript,
  timeoutMs: 30_000,
};

// ── water_waves_inspect ──────────────────────────────────────────────────────
export const waterWavesInspectSchema = z.object({
  body_path: z.string().min(1).describe('Actor path or label of the water body'),
});
export type WaterWavesInspectParams = z.infer<typeof waterWavesInspectSchema>;

function waterWavesInspectScript(p: WaterWavesInspectParams): string {
  return [
    PY_WATER_HELPERS,
    `_ref = ${pyStr(p.body_path)}`,
    'def _go():',
    '    st, warns = _water_guard()',
    '    if st is None: return',
    '    a = _find_actor(_ref)',
    '    if a is None: raise Exception("water body not found: %s" % _ref)',
    '    waves = _get_waves(a)',
    '    if waves is None:',
    '        warns.append("no WaterWaves resolved on body (none set or reflection gap — UNCERTAIN-API)")',
    '        _emit({"ok": True, "enabled": True, "path": _ref, "generator": None, "warnings": warns}); return',
    '    gen = _get_generator(waves)',
    '    gen_type = None',
    '    try: gen_type = type(gen).__name__',
    '    except Exception: pass',
    '    def _num(o, *ns):',
    '        v = _getp(o, *ns)',
    '        try: return float(v) if v is not None else None',
    '        except Exception: return None',
    '    num_waves = _getp(gen, "num_waves", "NumWaves")',
    '    try: num_waves = int(num_waves) if num_waves is not None else None',
    '    except Exception: num_waves = None',
    '    min_wl = _num(gen, "min_wavelength", "MinWavelength")',
    '    max_wl = _num(gen, "max_wavelength", "MaxWavelength")',
    '    steepness = _num(gen, "steepness", "Steepness")',
    '    seed = _getp(gen, "seed", "RandomSeed")',
    '    try: seed = int(seed) if seed is not None else None',
    '    except Exception: seed = None',
    '    direction = _num(gen, "wind_angle_deg", "WindAngleDeg", "dominant_wave_direction")',
    '    asset = None',
    '    try:',
    '        if not isinstance(waves, type(gen)): asset = waves.get_path_name()',
    '    except Exception: pass',
    '    _emit({"ok": True, "enabled": True, "path": _ref, "generator": gen_type,',
    '           "num_waves": num_waves, "min_wavelength": min_wl, "max_wavelength": max_wl,',
    '           "steepness": steepness, "seed": seed, "direction": direction, "asset": asset, "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const waterWavesInspectDescriptor: PyToolDescriptor<typeof waterWavesInspectSchema.shape> = {
  name: 'water_waves_inspect',
  description:
    "Read a body's wave setup: generator type, num_waves, wavelength range, steepness, seed, wind direction and attached WaterWavesAsset. The paired read for the most-tuned water parameter. Generator + property reflection is UNCERTAIN-API in 5.7 — probed with alternate names; anything unresolved is null with a warning, never guessed.",
  cost: 'low',
  returns: '{ok, enabled, path, generator, num_waves, min_wavelength, max_wavelength, steepness, seed, direction, asset?, warnings[]}',
  schema: waterWavesInspectSchema.shape,
  meta: readMeta,
  buildScript: waterWavesInspectScript,
  timeoutMs: 30_000,
};

// ── water_waves_set_gerstner (applied set-success flag) ──────────────────────
export const waterWavesSetGerstnerSchema = z.object({
  body_path: z.string().min(1).describe('Actor path or label of the water body'),
  num_waves: z.number().int().positive().optional().describe('Number of Gerstner waves'),
  min_wavelength: z.number().positive().optional().describe('Minimum wavelength'),
  max_wavelength: z.number().positive().optional().describe('Maximum wavelength'),
  steepness: z.number().min(0).max(1).optional().describe('Wave steepness [0..1]'),
  wind_dir: z.number().optional().describe('Dominant wind/wave direction (degrees)'),
  seed: z.number().int().optional().describe('Random seed'),
  dry_run: z.boolean().default(false).describe('Resolve the generator without applying'),
});
export type WaterWavesSetGerstnerParams = z.infer<typeof waterWavesSetGerstnerSchema>;

function waterWavesSetGerstnerScript(p: WaterWavesSetGerstnerParams): string {
  return [
    PY_WATER_HELPERS,
    `_ref = ${pyStr(p.body_path)}`,
    `_num = ${p.num_waves !== undefined ? p.num_waves : 'None'}`,
    `_min = ${p.min_wavelength !== undefined ? p.min_wavelength : 'None'}`,
    `_max = ${p.max_wavelength !== undefined ? p.max_wavelength : 'None'}`,
    `_steep = ${p.steepness !== undefined ? p.steepness : 'None'}`,
    `_wind = ${p.wind_dir !== undefined ? p.wind_dir : 'None'}`,
    `_seed = ${p.seed !== undefined ? p.seed : 'None'}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _setp(obj, val, *names):',
    '    if val is None: return None',
    '    for n in names:',
    '        if _try(lambda: obj.set_editor_property(n, val)): return True',
    '    return False',
    'def _go():',
    '    st, warns = _water_guard()',
    '    if st is None: return',
    '    a = _find_actor(_ref)',
    '    if a is None: raise Exception("water body not found: %s" % _ref)',
    '    waves = _get_waves(a)',
    '    gen = _get_generator(waves)',
    '    if gen is None:',
    '        warns.append("no Gerstner wave generator resolved (WaterWaves UNCERTAIN-API) - value NOT applied")',
    '        _emit({"ok": False, "enabled": True, "path": _ref, "applied": False, "fields_applied": {}, "warnings": warns}); return',
    '    if _dry:',
    '        _emit({"ok": True, "enabled": True, "path": _ref, "applied": False, "planned": {"generator": type(gen).__name__}}); return',
    '    fields = {}',
    '    fields["num_waves"] = _setp(gen, (int(_num) if _num is not None else None), "num_waves", "NumWaves")',
    '    fields["min_wavelength"] = _setp(gen, (float(_min) if _min is not None else None), "min_wavelength", "MinWavelength")',
    '    fields["max_wavelength"] = _setp(gen, (float(_max) if _max is not None else None), "max_wavelength", "MaxWavelength")',
    '    fields["steepness"] = _setp(gen, (float(_steep) if _steep is not None else None), "steepness", "Steepness")',
    '    fields["wind_dir"] = _setp(gen, (float(_wind) if _wind is not None else None), "wind_angle_deg", "WindAngleDeg", "dominant_wave_direction")',
    '    fields["seed"] = _setp(gen, (int(_seed) if _seed is not None else None), "seed", "RandomSeed")',
    '    requested = {k: v for k, v in fields.items() if v is not None}',
    '    applied = any(v is True for v in fields.values())',
    '    failed = [k for k, v in fields.items() if v is False]',
    '    if failed: warns.append("setters did not run for: %s (UNCERTAIN-API property names)" % ", ".join(failed))',
    '    if not requested: warns.append("no wave parameters supplied to set")',
    '    _try(lambda: a.modify(), lambda: a.mark_package_dirty())',
    '    comp = _water_component(a)',
    '    if comp is not None: _try(lambda: comp.mark_render_state_dirty(), lambda: comp.set_render_state_dirty())',
    '    _emit({"ok": bool(applied), "enabled": True, "path": _ref, "applied": bool(applied),',
    '           "fields_applied": requested, "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const waterWavesSetGerstnerDescriptor: PyToolDescriptor<typeof waterWavesSetGerstnerSchema.shape> = {
  name: 'water_waves_set_gerstner',
  description:
    "Configure a body's GerstnerWaterWaveGeneratorSimple (num_waves, wavelength range, steepness, wind direction, seed) — the primary knob for ocean look, with sane-range arg validation. SET-SUCCESS: the generator + every property setter is UNCERTAIN-API and returns void, so applied:true is reported ONLY when the generator resolved AND at least one setter ran without raising; otherwise ok:false + applied:false + a warning (never ok:true with an unapplied change). fields_applied lists exactly which knobs took. Idempotent set-to-value.",
  cost: 'medium',
  returns: '{ok, enabled, path, applied, fields_applied, warnings[], planned?}',
  schema: waterWavesSetGerstnerSchema.shape,
  meta: writeMeta,
  buildScript: waterWavesSetGerstnerScript,
  timeoutMs: 30_000,
};

// ── water_zone_create (NON_IDEMPOTENT) ───────────────────────────────────────
export const waterZoneCreateSchema = z.object({
  location: z.array(z.number()).length(3).default([0, 0, 0]).describe('World location [x,y,z]'),
  extent: z.array(z.number()).length(2).optional().describe('Zone XY extent [x,y] in world units'),
  resolution: z.array(z.number()).length(2).optional().describe('Water-info render-target resolution [x,y]'),
  label: z.string().optional().describe('Optional actor label'),
  dry_run: z.boolean().default(false).describe('Plan without spawning'),
});
export type WaterZoneCreateParams = z.infer<typeof waterZoneCreateSchema>;

function waterZoneCreateScript(p: WaterZoneCreateParams): string {
  return [
    PY_WATER_HELPERS,
    `_loc = [${p.location.join(', ')}]`,
    `_extent = ${p.extent ? `[${p.extent.join(', ')}]` : 'None'}`,
    `_res = ${p.resolution ? `[${p.resolution.join(', ')}]` : 'None'}`,
    `_label = ${p.label ? pyStr(p.label) : 'None'}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _setp(obj, val, *names):',
    '    if val is None: return None',
    '    for n in names:',
    '        if _try(lambda: obj.set_editor_property(n, val)): return True',
    '    return False',
    'def _go():',
    '    st, warns = _water_guard()',
    '    if st is None: return',
    '    k = getattr(unreal, "WaterZone", None)',
    '    if k is None: raise Exception("unreal.WaterZone unavailable (Water plugin?)")',
    '    if _dry:',
    '        _emit({"ok": True, "enabled": True, "planned": {"class": "WaterZone", "location": _loc, "extent": _extent, "resolution": _res, "label": _label}}); return',
    '    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    '    actor = eas.spawn_actor_from_class(k, unreal.Vector(_loc[0], _loc[1], _loc[2]), unreal.Rotator(0, 0, 0))',
    '    if actor is None: raise Exception("spawn_actor_from_class(WaterZone) returned None")',
    '    if _label is not None: _try(lambda: actor.set_actor_label(_label))',
    '    ext_applied = None',
    '    if _extent is not None:',
    '        ev = unreal.Vector2D(_extent[0], _extent[1])',
    '        ext_applied = _setp(actor, ev, "zone_extent", "ZoneExtent", "tessellated_water_mesh_extent_in_tiles")',
    '        if ext_applied is False: warns.append("zone extent setter did not run (UNCERTAIN-API property name)")',
    '    res_applied = None',
    '    if _res is not None:',
    '        rv = unreal.IntPoint(int(_res[0]), int(_res[1]))',
    '        res_applied = _setp(actor, rv, "render_target_resolution", "RenderTargetResolution")',
    '        if res_applied is False: warns.append("zone resolution setter did not run (UNCERTAIN-API property name)")',
    '    _mark_dirty(actor)',
    '    zp = None',
    '    try: zp = actor.get_path_name()',
    '    except Exception: pass',
    '    _emit({"ok": True, "enabled": True, "zone_path": zp, "extent_applied": ext_applied,',
    '           "resolution_applied": res_applied, "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const waterZoneCreateDescriptor: PyToolDescriptor<typeof waterZoneCreateSchema.shape> = {
  name: 'water_zone_create',
  description:
    'Spawn an AWaterZone (optionally sized + render-target resolution) to bound water bodies — bodies do NOT render without a covering zone (5.7 bounded zones). NON_IDEMPOTENT; supports dry_run. SET-SUCCESS: surfaces extent_applied/resolution_applied for the UNCERTAIN-API property writes. Degrades cleanly if Water is off.',
  cost: 'medium',
  returns: '{ok, enabled, zone_path, extent_applied, resolution_applied, warnings[], planned?}',
  schema: waterZoneCreateSchema.shape,
  meta: writeMeta,
  buildScript: waterZoneCreateScript,
  timeoutMs: 30_000,
};

// ── water_zone_inspect ───────────────────────────────────────────────────────
export const waterZoneInspectSchema = z.object({
  zone_path: z.string().min(1).describe('Actor path or label of the WaterZone'),
});
export type WaterZoneInspectParams = z.infer<typeof waterZoneInspectSchema>;

function waterZoneInspectScript(p: WaterZoneInspectParams): string {
  return [
    PY_WATER_HELPERS,
    `_ref = ${pyStr(p.zone_path)}`,
    'def _go():',
    '    st, warns = _water_guard()',
    '    if st is None: return',
    '    z = _find_actor(_ref)',
    '    if z is None: raise Exception("zone not found: %s" % _ref)',
    '    if not _is_zone(z): raise Exception("actor is not a WaterZone: %s (%s)" % (_ref, type(z).__name__))',
    '    zb = _bounds(z)',
    '    res = _getp(z, "render_target_resolution", "RenderTargetResolution")',
    '    resolution = None',
    '    try:',
    '        if res is not None: resolution = [int(res.x), int(res.y)]',
    '    except Exception: pass',
    '    far = _getp(z, "far_distance_mesh_extent", "lod0_max_water_level", "FarDistanceMeshExtent")',
    '    try: far = float(far) if far is not None else None',
    '    except Exception: far = None',
    '    covered = []; orphaned = []',
    '    for a in _all_actors():',
    '        if not _is_water_body(a): continue',
    '        bp = None',
    '        try: bp = a.get_path_name()',
    '        except Exception: pass',
    '        if _covers(zb, _bounds(a)): covered.append(bp)',
    '    # orphaned = bodies covered by NO zone at all',
    '    zones_b = [(_bounds(zz)) for zz in _all_actors() if _is_zone(zz)]',
    '    for a in _all_actors():',
    '        if not _is_water_body(a): continue',
    '        bb = _bounds(a)',
    '        if not any(_covers(zbn, bb) for zbn in zones_b):',
    '            try: orphaned.append(a.get_path_name())',
    '            except Exception: pass',
    '    _emit({"ok": True, "enabled": True, "zone_path": _ref, "bounds": zb, "resolution": resolution,',
    '           "far_distance": far, "covered_bodies": covered, "orphaned_bodies": orphaned, "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const waterZoneInspectDescriptor: PyToolDescriptor<typeof waterZoneInspectSchema.shape> = {
  name: 'water_zone_inspect',
  description:
    'Read a WaterZone: bounds, water-info render-target resolution, LOD far distance, which bodies it covers (AABB containment) and which bodies in the level are orphaned (covered by NO zone — the silent "body outside zone" rendering drop). Property reflection is UNCERTAIN-API; probed with alternate names.',
  cost: 'low',
  returns: '{ok, enabled, zone_path, bounds, resolution, far_distance, covered_bodies[], orphaned_bodies[], warnings[]}',
  schema: waterZoneInspectSchema.shape,
  meta: readMeta,
  buildScript: waterZoneInspectScript,
  timeoutMs: 30_000,
};

// ── water_validate (PLUMB-style read-only) ───────────────────────────────────
export const waterValidateSchema = z.object({
  scope: z.enum(['level']).default('level').describe('Validation scope (only level supported this wave)'),
});
export type WaterValidateParams = z.infer<typeof waterValidateSchema>;

function waterValidateScript(_p: WaterValidateParams): string {
  return [
    PY_WATER_HELPERS,
    'def _go():',
    '    st, warns = _water_guard()',
    '    if st is None: return',
    '    zones = [z for z in _all_actors() if _is_zone(z)]',
    '    zbounds = [_bounds(z) for z in zones]',
    '    bodies = [a for a in _all_actors() if _is_water_body(a)]',
    '    findings = []',
    '    if bodies and not zones:',
    '        findings.append({"rule": "no_water_zone", "severity": "error", "body": None,',
    '                         "detail": "water bodies exist but the level has NO WaterZone - bodies will not render", "fix": "water_zone_create"})',
    '    for a in bodies:',
    '        bp = None',
    '        try: bp = a.get_path_name()',
    '        except Exception: pass',
    '        bb = _bounds(a)',
    '        covered = any(_covers(zbn, bb) for zbn in zbounds) if zbounds else False',
    '        if zones and not covered:',
    '            findings.append({"rule": "body_outside_zone", "severity": "error", "body": bp,',
    '                             "detail": "body is not covered by any WaterZone (will not render)", "fix": "resize/move a WaterZone to cover it"})',
    '        waves = _get_waves(a)',
    '        gen = _get_generator(waves) if waves is not None else None',
    '        if gen is not None:',
    '            sv = _getp(gen, "steepness", "Steepness")',
    '            try:',
    '                if sv is not None and float(sv) > 1.0:',
    '                    findings.append({"rule": "steepness_out_of_range", "severity": "warning", "body": bp,',
    '                                     "detail": "wave steepness %s exceeds physical [0..1] range" % sv, "fix": "water_waves_set_gerstner steepness<=1"})',
    '            except Exception: pass',
    '            mn = _getp(gen, "min_wavelength", "MinWavelength")',
    '            mx = _getp(gen, "max_wavelength", "MaxWavelength")',
    '            try:',
    '                if mn is not None and mx is not None and float(mn) > float(mx):',
    '                    findings.append({"rule": "wavelength_inverted", "severity": "warning", "body": bp,',
    '                                     "detail": "min_wavelength > max_wavelength", "fix": "water_waves_set_gerstner"})',
    '            except Exception: pass',
    '    oceans = [a for a in bodies if type(a).__name__ == "WaterBodyOcean"]',
    '    if len(oceans) > 1:',
    '        findings.append({"rule": "multiple_oceans", "severity": "warning", "body": None,',
    '                         "detail": "%d WaterBodyOcean actors in the level (usually one)" % len(oceans), "fix": "water_body_list"})',
    '    errs = [f for f in findings if f.get("severity") == "error"]',
    '    warncnt = [f for f in findings if f.get("severity") == "warning"]',
    '    status = "green" if not errs else "red"',
    '    _emit({"ok": len(errs) == 0, "enabled": True, "status": status, "findings": findings,',
    '           "error_count": len(errs), "warning_count": len(warncnt),',
    '           "body_count": len(bodies), "zone_count": len(zones), "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const waterValidateDescriptor: PyToolDescriptor<typeof waterValidateSchema.shape> = {
  name: 'water_validate',
  description:
    'PLUMB-style quantified check of the water scene: bodies present but no WaterZone, bodies outside every zone (silent render drop), wave steepness out of [0..1], inverted wavelength range, multiple oceans. Returns green/red status + categorised findings with severity + a fix hint; ok:false only on errors. The closed-loop correctness engine for water (the worldbuilding moat). autofix not implemented this wave.',
  cost: 'low',
  returns: '{ok, enabled, status, findings:[{rule,severity,body,detail,fix?}], error_count, warning_count, body_count, zone_count, warnings[]}',
  schema: waterValidateSchema.shape,
  meta: readMeta,
  buildScript: waterValidateScript,
  timeoutMs: 30_000,
};

// ── Aggregate: all water-domain PyToolDescriptors (spliced in index.ts) ───────
export const waterPyDescriptors: PyToolDescriptor[] = [
  waterCheckPluginDescriptor,
  waterBodyListDescriptor,
  waterBodyInspectDescriptor,
  waterBodyOceanCreateDescriptor,
  waterBodyLakeCreateDescriptor,
  waterBodyRiverCreateDescriptor,
  waterWavesInspectDescriptor,
  waterWavesSetGerstnerDescriptor,
  waterZoneCreateDescriptor,
  waterZoneInspectDescriptor,
  waterValidateDescriptor,
] as unknown as PyToolDescriptor[];

/**
 * Water-domain factory tools that are non-idempotent (spawn a persistent actor —
 * retry would duplicate it). Mirrored into tool-executor's NON_IDEMPOTENT set.
 * water_waves_set_gerstner is a set-to-value write (idempotent per the house
 * rule); the rest read.
 */
export const WATER_NON_IDEMPOTENT: readonly string[] = [
  waterBodyOceanCreateDescriptor.name,
  waterBodyLakeCreateDescriptor.name,
  waterBodyRiverCreateDescriptor.name,
  waterZoneCreateDescriptor.name,
];
