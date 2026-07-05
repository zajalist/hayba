// Niagara & VFX P0/P1 tools, generated as UE Python via the pyTemplate factory
// (see py-tool-factory.ts). Sibling of sequencer/sequencer-py-tools.ts and
// lighting/lighting-py-tools.ts — same PyToolDescriptor shape, same _emit/_err
// envelope, same defensive multi-name probing, same warnings[]+success-flag
// surfacing, same index.ts splice.
//
// Source of truth for the catalog: docs/plans/2026-06-28-mcp-supertooling-tools.json,
// domain "niagara-and-vfx".
//
// ── 3-SURFACE OVERLAP AUDIT (mandatory) ──────────────────────────────────────
// (a) src/legacy-commands/sidecar.json          → grep "niagara": ZERO entries.
// (b) src/tools/*.ts registered MCP tools        → ZERO python niagara tools
//     registered before this file; src/tools/code-mode/list-tool-categories.ts
//     declares domain 'niagara' with THREE commands (mirroring the C++ module).
// (c) unreal/HaybaMCPNiagara (satellite plugin) HaybaMCPNiagaraHandler.cpp
//     GetCommands() registers THREE compiled C++ commands:
//         niagara_list, niagara_spawn, niagara_set_param
//     reachable only by command string via the generic invoke path (satellite
//     plugin may not be loaded), NOT as first-class MCP tools.
//
// RESOLUTION (obeys the "pick non-colliding names" directive, exactly as the
// sequencer wave did): every tool here is named DISTINCTLY from those 3 C++
// commands so one name never has two behaviours. Mapping (catalog → shipped):
//     niagara_list      → niagara_systems           (list + pagination + prefix)
//     niagara_spawn     → niagara_spawn_transient   (transient auto-destroy)
//     niagara_set_param → niagara_param_set         (live-component user var)
//   (niagara_system_inspect, niagara_param_list, niagara_place_actor,
//    niagara_component_inspect, niagara_list_components, niagara_activate,
//    niagara_advance_simulation, niagara_validate, niagara_create_from_template,
//    niagara_set_user_param_default, niagara_capability_probe do NOT collide.)
// These python tools are the always-available surface; they call the unreal
// python API directly and do NOT delegate to the dormant C++ commands.
//
//   SHIPPED (14):
//     niagara_capability_probe, niagara_systems, niagara_system_inspect,
//     niagara_param_list, niagara_spawn_transient, niagara_place_actor,
//     niagara_param_set, niagara_set_user_param_default, niagara_component_inspect,
//     niagara_list_components, niagara_activate, niagara_advance_simulation,
//     niagara_validate, niagara_create_from_template.
//
// ── WRAP-AND-SKIP (not shipped this wave) ─────────────────────────────────────
//   * niagara_spawn_attached      — attach-to-socket needs reliable component/
//     socket resolution on the target actor; the python spawn_system_attached
//     overload set is version-fragile. Deferred to a live-validation pass.
//   * niagara_spawn_batch / niagara_set_params_batch — bulk loop variants; thin
//     value over calling the single tools N times this wave; defer once the
//     single ops are live-validated.
//   * niagara_capture_preview     — mixes spawn+advance+viewport-capture; the
//     capture leg belongs with the vision-loop screenshot path and carries the
//     same async-lifecycle risk we avoid from python_run. Deferred.
//
// ── SET-SUCCESS FLAGS (the W4T1 lesson: a set that can fail must surface a
//    boolean, never ok:true with an unapplied change) ───────────────────────────
//   UE's NiagaraComponent.set_variable_* setters return void, so we cannot read
//   back a confirmation value. Instead every set path tries a probe-chain of
//   setter entry points and reports applied:true ONLY if a setter ran without
//   raising; applied:false (with ok:false + a warning) if the value_type matched
//   nothing or every probe raised. niagara_param_set / niagara_activate /
//   niagara_set_user_param_default all surface an explicit applied/active flag.
//
// ── NON_IDEMPOTENT ───────────────────────────────────────────────────────────
//   niagara_spawn_transient (spawns a component), niagara_place_actor (spawns a
//   persistent actor), niagara_create_from_template (creates an asset). Added to
//   tool-executor's NON_IDEMPOTENT set AND re-exported as NIAGARA_NON_IDEMPOTENT.
//   niagara_param_set / niagara_set_user_param_default / niagara_activate are
//   set-to-value/state writes (idempotent per the house rule); the rest are reads.
//
// ── UNCERTAIN-API flags for the next live-validation pass (all wrapped
//    defensively → structured warning/error, never a silent wrong answer) ───────
//   - Emitter handles: NiagaraSystem.get_emitter_handles() is NOT reliably
//     python-exposed; probed via get_editor_property('emitter_handles') and the
//     emitter-handle enabled/sim_target readers degrade to warnings.
//   - Exposed user params: get_exposed_parameters()/editor_property
//     ('exposed_parameters') + parameter-store variable enumeration are all
//     probed; degrade to a warning if none resolve.
//   - Live setters: NiagaraComponent.set_variable_* vs
//     NiagaraFunctionLibrary.set_niagara_variable_* both probed per value_type.
//   - advance_simulation: NiagaraComponent.advance_simulation(tick_count,
//     tick_delta_seconds) arg order probed with a seconds/dt fallback.

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

// ── Shared Python helpers: load a NiagaraSystem asset, resolve a live component
//    by component_path or owning actor, param-store enumeration, typed setter
//    probe-chain (returns an "applied" boolean — never a silent partial set) ────
const PY_NIAGARA_HELPERS = [
  'import json',
  'def _load_system(path):',
  '    obj = unreal.EditorAssetLibrary.load_asset(path)',
  '    if obj is None: raise Exception("asset not found: %s" % path)',
  '    if not isinstance(obj, unreal.NiagaraSystem): raise Exception("not a NiagaraSystem: %s (%s)" % (path, type(obj).__name__))',
  '    return obj',
  'def _find_component(ref):',
  '    # ref is a component object path OR an actor label/path carrying a NiagaraComponent',
  '    try:',
  '        o = unreal.load_object(None, ref)',
  '        if isinstance(o, unreal.NiagaraComponent): return o',
  '        if isinstance(o, unreal.Actor):',
  '            c = o.get_component_by_class(unreal.NiagaraComponent)',
  '            if c is not None: return c',
  '    except Exception: pass',
  '    try:',
  '        eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
  '        acts = eas.get_all_level_actors() if eas is not None else []',
  '        for a in acts:',
  '            try:',
  '                if a.get_actor_label() == ref or a.get_path_name() == ref:',
  '                    c = a.get_component_by_class(unreal.NiagaraComponent)',
  '                    if c is not None: return c',
  '            except Exception: pass',
  '    except Exception: pass',
  '    return None',
  'def _world():',
  '    try:',
  '        return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()',
  '    except Exception:',
  '        try: return unreal.EditorLevelLibrary.get_editor_world()',
  '        except Exception: return None',
  'def _try(*calls):',
  '    # run probe-chain; return True on the first call that does not raise',
  '    for c in calls:',
  '        try:',
  '            c(); return True',
  '        except Exception: pass',
  '    return False',
  'def _apply_var(comp, name, vt, val):',
  '    # typed setter probe-chain -> (applied_bool). NEVER reports success unless a setter ran.',
  '    vt = (vt or "").lower()',
  '    nfl = unreal.NiagaraFunctionLibrary',
  '    if vt in ("float", "double"):',
  '        v = float(val)',
  '        return _try(lambda: comp.set_variable_float(name, v), lambda: nfl.set_niagara_variable_float(comp, name, v))',
  '    if vt in ("int", "int32", "integer"):',
  '        v = int(val)',
  '        return _try(lambda: comp.set_variable_int(name, v), lambda: nfl.set_niagara_variable_int(comp, name, v))',
  '    if vt in ("bool", "boolean"):',
  '        v = bool(val)',
  '        return _try(lambda: comp.set_variable_bool(name, v), lambda: nfl.set_niagara_variable_bool(comp, name, v))',
  '    if vt in ("vec2", "vector2", "vector2d"):',
  '        v = unreal.Vector2D(float(val[0]), float(val[1]))',
  '        return _try(lambda: comp.set_variable_vec2(name, v), lambda: nfl.set_niagara_variable_vec2(comp, name, v))',
  '    if vt in ("vec3", "vector"):',
  '        v = unreal.Vector(float(val[0]), float(val[1]), float(val[2]))',
  '        return _try(lambda: comp.set_variable_vec3(name, v), lambda: nfl.set_niagara_variable_vec3(comp, name, v))',
  '    if vt in ("position",):',
  '        v = unreal.Vector(float(val[0]), float(val[1]), float(val[2]))',
  '        return _try(lambda: comp.set_variable_position(name, v), lambda: comp.set_variable_vec3(name, v))',
  '    if vt in ("vec4", "vector4"):',
  '        v = unreal.Vector4(float(val[0]), float(val[1]), float(val[2]), float(val[3]))',
  '        return _try(lambda: comp.set_variable_vec4(name, v))',
  '    if vt in ("quat", "quaternion"):',
  '        v = unreal.Quat(float(val[0]), float(val[1]), float(val[2]), float(val[3]))',
  '        return _try(lambda: comp.set_variable_quaternion(name, v), lambda: comp.set_variable_quat(name, v))',
  '    if vt in ("color", "linearcolor"):',
  '        c = list(val) + [1.0]',
  '        v = unreal.LinearColor(float(c[0]), float(c[1]), float(c[2]), float(c[3]))',
  '        return _try(lambda: comp.set_variable_linear_color(name, v), lambda: nfl.set_niagara_variable_linear_color(comp, name, v))',
  '    if vt in ("object", "asset"):',
  '        obj = unreal.load_object(None, str(val))',
  '        if obj is None: raise Exception("object not found: %s" % val)',
  '        return _try(lambda: comp.set_variable_object(name, obj), lambda: comp.set_variable_material(name, obj))',
  '    raise Exception("unsupported value_type: %s" % vt)',
  'def _user_params(sys):',
  '    # UNCERTAIN-API: exposed-parameter enumeration probed defensively.',
  '    params = []; warns = []',
  '    store = None',
  '    for g in ("get_exposed_parameters",):',
  '        try:',
  '            store = getattr(sys, g)(); break',
  '        except Exception: pass',
  '    if store is None:',
  '        try: store = sys.get_editor_property("exposed_parameters")',
  '        except Exception: store = None',
  '    if store is None:',
  '        warns.append("exposed_parameters unavailable via python reflection (UNCERTAIN-API)"); return params, warns',
  '    names = None',
  '    for m in ("get_parameter_names", "get_all_variable_names", "get_variables"):',
  '        try:',
  '            names = getattr(store, m)(); break',
  '        except Exception: pass',
  '    if names is None:',
  '        warns.append("parameter-store enumeration unavailable (UNCERTAIN-API)"); return params, warns',
  '    for n in names:',
  '        pn = None; pt = None',
  '        try: pn = str(n.get_name()) if hasattr(n, "get_name") else str(n)',
  '        except Exception: pn = str(n)',
  '        try:',
  '            if hasattr(n, "get_type"): pt = str(n.get_type())',
  '        except Exception: pass',
  '        is_di = ("DataInterface" in (pt or "")) or (pn is not None and pn.startswith("User.DI"))',
  '        params.append({"name": pn, "type": pt, "is_data_interface": is_di})',
  '    return params, warns',
  'def _emitters(sys):',
  '    # UNCERTAIN-API: emitter handles are not reliably python-exposed.',
  '    out = []; warns = []',
  '    handles = None',
  '    for g in ("get_emitter_handles",):',
  '        try:',
  '            handles = getattr(sys, g)(); break',
  '        except Exception: pass',
  '    if handles is None:',
  '        try: handles = sys.get_editor_property("emitter_handles")',
  '        except Exception: handles = None',
  '    if handles is None:',
  '        warns.append("emitter_handles unavailable via python reflection (UNCERTAIN-API)"); return out, warns',
  '    for h in handles:',
  '        nm = None; en = None; st = None',
  '        try: nm = str(h.get_name()) if hasattr(h, "get_name") else str(getattr(h, "name", None))',
  '        except Exception: pass',
  '        try: en = bool(h.get_editor_property("is_enabled"))',
  '        except Exception: pass',
  '        try: st = str(h.get_editor_property("sim_target"))',
  '        except Exception: pass',
  '        out.append({"name": nm, "enabled": en, "sim_target": st})',
  '    return out, warns',
].join('\n');

const readMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'discovering or inspecting Niagara systems / live components before spawning or tuning VFX',
  not_when: 'spawning or mutating — use niagara_spawn_transient / niagara_place_actor / niagara_param_set',
};

const writeMeta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies-world'],
  when: 'placing or tuning a Niagara effect: spawning, activating, setting user params',
  not_when: 'reading state — use the niagara_*_inspect / niagara_param_list reads',
};

const assetWriteMeta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['writes-to-disk'],
  when: 'authoring a system asset: duplicating a template or persisting a user-param default',
  not_when: 'live runtime tuning — use niagara_param_set on a component',
};

// ── niagara_capability_probe ─────────────────────────────────────────────────
export const niagaraCapabilityProbeSchema = z.object({});
export type NiagaraCapabilityProbeParams = z.infer<typeof niagaraCapabilityProbeSchema>;

function niagaraCapabilityProbeScript(_p: NiagaraCapabilityProbeParams): string {
  return [
    PY_NIAGARA_HELPERS,
    'def _go():',
    '    caps = {}',
    '    caps["NiagaraSystem"] = hasattr(unreal, "NiagaraSystem")',
    '    caps["NiagaraComponent"] = hasattr(unreal, "NiagaraComponent")',
    '    caps["NiagaraFunctionLibrary"] = hasattr(unreal, "NiagaraFunctionLibrary")',
    '    caps["NiagaraActor"] = hasattr(unreal, "NiagaraActor")',
    '    caps["spawn_system_at_location"] = hasattr(unreal, "NiagaraFunctionLibrary") and hasattr(unreal.NiagaraFunctionLibrary, "spawn_system_at_location")',
    '    caps["spawn_system_attached"] = hasattr(unreal, "NiagaraFunctionLibrary") and hasattr(unreal.NiagaraFunctionLibrary, "spawn_system_attached")',
    '    setters = []',
    '    if hasattr(unreal, "NiagaraComponent"):',
    '        for s in ("set_variable_float","set_variable_int","set_variable_bool","set_variable_vec2","set_variable_vec3","set_variable_vec4","set_variable_linear_color","set_variable_position","set_variable_quaternion","set_variable_object","advance_simulation","activate"):',
    '            if hasattr(unreal.NiagaraComponent, s): setters.append(s)',
    '    caps["component_setters"] = setters',
    '    avail = caps.get("NiagaraSystem") and caps.get("NiagaraComponent") and caps.get("NiagaraFunctionLibrary")',
    '    _emit({"ok": True, "niagara_available": bool(avail), "capabilities": caps})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraCapabilityProbeDescriptor: PyToolDescriptor<typeof niagaraCapabilityProbeSchema.shape> = {
  name: 'niagara_capability_probe',
  description:
    'Probe whether the Niagara plugin and its python surface are available (NiagaraSystem/Component/FunctionLibrary classes, spawn entry points, and which set_variable_* setters exist). The cheap capability gate to call before any other niagara tool so an agent knows what will work in this editor build.',
  cost: 'low',
  returns: '{ok, niagara_available, capabilities:{NiagaraSystem,NiagaraComponent,NiagaraFunctionLibrary,NiagaraActor,spawn_system_at_location,spawn_system_attached,component_setters[]}}',
  schema: niagaraCapabilityProbeSchema.shape,
  meta: readMeta,
  buildScript: niagaraCapabilityProbeScript,
  timeoutMs: 30_000,
};

// ── niagara_systems (rename of C++ niagara_list) ─────────────────────────────
export const niagaraSystemsSchema = z.object({
  path_prefix: z.string().default('/Game').describe('Content root to search under, e.g. "/Game/VFX"'),
  limit: z.number().int().positive().default(50).describe('Max systems to return'),
  offset: z.number().int().nonnegative().default(0).describe('Offset for pagination'),
});
export type NiagaraSystemsParams = z.infer<typeof niagaraSystemsSchema>;

function niagaraSystemsScript(p: NiagaraSystemsParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_root = ${pyStr(p.path_prefix)}`,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'def _go():',
    '    ar = unreal.AssetRegistryHelpers.get_asset_registry()',
    '    ardata = ar.get_assets_by_path(unreal.Name(_root), recursive=True)',
    '    systems = []',
    '    for a in ardata:',
    '        try:',
    '            cn = str(a.asset_class_path.asset_name) if hasattr(a, "asset_class_path") else str(a.asset_class)',
    '        except Exception: cn = ""',
    '        if cn != "NiagaraSystem": continue',
    '        try:',
    '            pkg = str(a.package_name)',
    '            nm = str(a.asset_name)',
    '            systems.append({"path": pkg, "name": nm})',
    '        except Exception: pass',
    '    systems = sorted(systems, key=lambda x: x["path"])',
    '    total = len(systems)',
    '    page = systems[_offset:_offset + _limit]',
    '    nxt = _offset + len(page)',
    '    _emit({"ok": True, "systems": page, "count": total, "has_more": nxt < total, "next_offset": nxt})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraSystemsDescriptor: PyToolDescriptor<typeof niagaraSystemsSchema.shape> = {
  name: 'niagara_systems',
  description:
    'List/paginate NiagaraSystem assets (path + name) under a content root via the AssetRegistry — the entry read for VFX discovery. Named niagara_systems to avoid colliding with the dormant satellite-plugin C++ niagara_list command; adds prefix + limit/offset pagination.',
  cost: 'low',
  returns: '{ok, systems:[{path,name}], count, has_more, next_offset}',
  schema: niagaraSystemsSchema.shape,
  meta: readMeta,
  buildScript: niagaraSystemsScript,
  timeoutMs: 30_000,
};

// ── niagara_system_inspect ───────────────────────────────────────────────────
export const niagaraSystemInspectSchema = z.object({
  system_path: z.string().min(1).describe('Content path of the NiagaraSystem asset'),
});
export type NiagaraSystemInspectParams = z.infer<typeof niagaraSystemInspectSchema>;

function niagaraSystemInspectScript(p: NiagaraSystemInspectParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_path = ${pyStr(p.system_path)}`,
    'def _go():',
    '    sys = _load_system(_path)',
    '    emitters, ew = _emitters(sys)',
    '    params, pw = _user_params(sys)',
    '    warnings = ew + pw',
    '    effect_type = None; fixed_bounds = None; warmup = None',
    '    try:',
    '        et = sys.get_editor_property("effect_type")',
    '        if et is not None: effect_type = et.get_name()',
    '    except Exception: pass',
    '    try: fixed_bounds = bool(sys.get_editor_property("fixed_bounds"))',
    '    except Exception:',
    '        try: fixed_bounds = bool(sys.get_editor_property("bFixedBounds"))',
    '        except Exception: pass',
    '    try: warmup = float(sys.get_editor_property("warmup_time"))',
    '    except Exception: pass',
    '    data_interfaces = [pp for pp in params if pp.get("is_data_interface")]',
    '    _emit({"ok": True, "system_path": _path, "emitters": emitters, "user_params": params,',
    '           "data_interfaces": data_interfaces, "fixed_bounds": fixed_bounds,',
    '           "warmup_time": warmup, "effect_type": effect_type, "warnings": warnings})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraSystemInspectDescriptor: PyToolDescriptor<typeof niagaraSystemInspectSchema.shape> = {
  name: 'niagara_system_inspect',
  description:
    'Dump a NiagaraSystem asset\'s structure: emitter handles (name/enabled/sim-target), exposed USER parameters (name/type/is_data_interface), data interfaces, fixed-bounds flag, warmup time and effect type. The inspection-first paired read for the VFX authoring tools. Emitter-handle and exposed-parameter reflection is UNCERTAIN-API in 5.7 — anything unresolved is reported in warnings[] rather than guessed.',
  cost: 'low',
  returns: '{ok, system_path, emitters:[{name,enabled,sim_target}], user_params:[{name,type,is_data_interface}], data_interfaces[], fixed_bounds, warmup_time, effect_type, warnings[]}',
  schema: niagaraSystemInspectSchema.shape,
  meta: readMeta,
  buildScript: niagaraSystemInspectScript,
  timeoutMs: 30_000,
};

// ── niagara_param_list ───────────────────────────────────────────────────────
export const niagaraParamListSchema = z.object({
  system_path: z.string().min(1).describe('Content path of the NiagaraSystem asset'),
});
export type NiagaraParamListParams = z.infer<typeof niagaraParamListSchema>;

function niagaraParamListScript(p: NiagaraParamListParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_path = ${pyStr(p.system_path)}`,
    'def _go():',
    '    sys = _load_system(_path)',
    '    params, warns = _user_params(sys)',
    '    _emit({"ok": True, "system_path": _path, "user_params": params, "count": len(params), "warnings": warns})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraParamListDescriptor: PyToolDescriptor<typeof niagaraParamListSchema.shape> = {
  name: 'niagara_param_list',
  description:
    'List just the exposed USER parameters of a NiagaraSystem asset (name/type/is_data_interface) — the contract an agent needs before niagara_param_set. Cheaper focused variant of niagara_system_inspect. Exposed-parameter enumeration is UNCERTAIN-API; unresolved reflection is surfaced in warnings[].',
  cost: 'low',
  returns: '{ok, system_path, user_params:[{name,type,is_data_interface}], count, warnings[]}',
  schema: niagaraParamListSchema.shape,
  meta: readMeta,
  buildScript: niagaraParamListScript,
  timeoutMs: 30_000,
};

// ── niagara_spawn_transient (rename of C++ niagara_spawn) ─────────────────────
export const niagaraSpawnTransientSchema = z.object({
  system_path: z.string().min(1).describe('Content path of the NiagaraSystem to spawn'),
  location: z.array(z.number()).length(3).default([0, 0, 0]).describe('World location [x,y,z]'),
  rotation: z.array(z.number()).length(3).default([0, 0, 0]).describe('Rotation [roll,pitch,yaw] degrees'),
  scale: z.array(z.number()).length(3).default([1, 1, 1]).describe('Scale [x,y,z]'),
  auto_destroy: z.boolean().default(true).describe('Auto-destroy the component when the effect completes'),
  auto_activate: z.boolean().default(true).describe('Activate the effect immediately on spawn'),
  dry_run: z.boolean().default(false).describe('Resolve the system without spawning'),
});
export type NiagaraSpawnTransientParams = z.infer<typeof niagaraSpawnTransientSchema>;

function niagaraSpawnTransientScript(p: NiagaraSpawnTransientParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_path = ${pyStr(p.system_path)}`,
    `_loc = [${p.location.join(', ')}]`,
    `_rot = [${p.rotation.join(', ')}]`,
    `_scl = [${p.scale.join(', ')}]`,
    `_ad = ${p.auto_destroy ? 'True' : 'False'}`,
    `_aa = ${p.auto_activate ? 'True' : 'False'}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _go():',
    '    sys = _load_system(_path)',
    '    if _dry:',
    '        _emit({"ok": True, "dry_run": True, "system_path": _path}); return',
    '    world = _world()',
    '    if world is None: raise Exception("no editor world")',
    '    loc = unreal.Vector(_loc[0], _loc[1], _loc[2])',
    '    rot = unreal.Rotator(_rot[0], _rot[1], _rot[2])',
    '    scale = unreal.Vector(_scl[0], _scl[1], _scl[2])',
    '    comp = unreal.NiagaraFunctionLibrary.spawn_system_at_location(world, sys, loc, rot, scale, _ad, _aa)',
    '    if comp is None: raise Exception("spawn_system_at_location returned None")',
    '    cp = None; ap = None',
    '    try: cp = comp.get_path_name()',
    '    except Exception: pass',
    '    try:',
    '        owner = comp.get_owner()',
    '        if owner is not None: ap = owner.get_path_name()',
    '    except Exception: pass',
    '    _emit({"ok": True, "spawned_path": _path, "component_path": cp, "actor_path": ap,',
    '           "auto_destroy": _ad, "auto_activate": _aa})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraSpawnTransientDescriptor: PyToolDescriptor<typeof niagaraSpawnTransientSchema.shape> = {
  name: 'niagara_spawn_transient',
  description:
    'Spawn a TRANSIENT (auto-destroy) Niagara system at a world location/rotation/scale — the workhorse placement verb for one-shot VFX. Non-idempotent (each call spawns a new component). Named niagara_spawn_transient to avoid colliding with the dormant satellite-plugin C++ niagara_spawn command; adds scale, auto_activate and dry_run. For a persistent, savable effect use niagara_place_actor.',
  cost: 'medium',
  returns: '{ok, spawned_path, component_path, actor_path, auto_destroy, auto_activate, dry_run?}',
  schema: niagaraSpawnTransientSchema.shape,
  meta: writeMeta,
  buildScript: niagaraSpawnTransientScript,
  timeoutMs: 30_000,
};

// ── niagara_place_actor ──────────────────────────────────────────────────────
export const niagaraPlaceActorSchema = z.object({
  system_path: z.string().min(1).describe('Content path of the NiagaraSystem'),
  location: z.array(z.number()).length(3).default([0, 0, 0]).describe('World location [x,y,z]'),
  rotation: z.array(z.number()).length(3).default([0, 0, 0]).describe('Rotation [roll,pitch,yaw] degrees'),
  scale: z.array(z.number()).length(3).default([1, 1, 1]).describe('Scale [x,y,z]'),
  label: z.string().optional().describe('Optional actor label for the placed NiagaraActor'),
  dry_run: z.boolean().default(false).describe('Resolve the system without placing an actor'),
});
export type NiagaraPlaceActorParams = z.infer<typeof niagaraPlaceActorSchema>;

function niagaraPlaceActorScript(p: NiagaraPlaceActorParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_path = ${pyStr(p.system_path)}`,
    `_loc = [${p.location.join(', ')}]`,
    `_rot = [${p.rotation.join(', ')}]`,
    `_scl = [${p.scale.join(', ')}]`,
    `_label = ${p.label ? pyStr(p.label) : 'None'}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _go():',
    '    sys = _load_system(_path)',
    '    if _dry:',
    '        _emit({"ok": True, "dry_run": True, "system_path": _path}); return',
    '    loc = unreal.Vector(_loc[0], _loc[1], _loc[2])',
    '    rot = unreal.Rotator(_rot[0], _rot[1], _rot[2])',
    '    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    '    actor = eas.spawn_actor_from_class(unreal.NiagaraActor, loc, rot)',
    '    if actor is None: raise Exception("spawn_actor_from_class(NiagaraActor) returned None")',
    '    try: actor.set_actor_scale3d(unreal.Vector(_scl[0], _scl[1], _scl[2]))',
    '    except Exception: pass',
    '    warnings = []',
    '    comp = actor.get_component_by_class(unreal.NiagaraComponent)',
    '    asset_set = False',
    '    if comp is not None:',
    '        asset_set = _try(lambda: comp.set_asset(sys), lambda: comp.set_editor_property("asset", sys))',
    '        if not asset_set: warnings.append("could not assign NiagaraSystem asset to placed actor component")',
    '    else:',
    '        warnings.append("placed NiagaraActor has no NiagaraComponent")',
    '    if _label is not None:',
    '        try: actor.set_actor_label(_label)',
    '        except Exception: pass',
    '    ap = None; cp = None',
    '    try: ap = actor.get_path_name()',
    '    except Exception: pass',
    '    try:',
    '        if comp is not None: cp = comp.get_path_name()',
    '    except Exception: pass',
    '    _emit({"ok": bool(asset_set), "actor_path": ap, "component_path": cp,',
    '           "asset_assigned": asset_set, "warnings": warnings})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraPlaceActorDescriptor: PyToolDescriptor<typeof niagaraPlaceActorSchema.shape> = {
  name: 'niagara_place_actor',
  description:
    'Place a PERSISTENT NiagaraActor in the level (survives save, undoable, selectable) with a system assigned — for level-dressing VFX an author wants to keep and re-edit, vs the transient niagara_spawn_transient. Non-idempotent. Surfaces asset_assigned as a set-success flag (ok:false if the system asset could not be assigned).',
  cost: 'medium',
  returns: '{ok, actor_path, component_path, asset_assigned, warnings[], dry_run?}',
  schema: niagaraPlaceActorSchema.shape,
  meta: writeMeta,
  buildScript: niagaraPlaceActorScript,
  timeoutMs: 30_000,
};

// ── niagara_param_set (rename of C++ niagara_set_param) ───────────────────────
const VALUE_TYPES = ['float', 'int', 'bool', 'vec2', 'vec3', 'vec4', 'quat', 'color', 'position', 'object'] as const;
export const niagaraParamSetSchema = z.object({
  component: z.string().min(1).describe('NiagaraComponent object path OR an actor label/path carrying one'),
  param_name: z.string().min(1).describe('User parameter name (with or without the "User." prefix)'),
  value_type: z.enum(VALUE_TYPES).describe('Value type of the parameter'),
  value: z.any().describe('The value: number (float/int), bool, [x,y,z] arrays for vectors/color, or an object path string'),
});
export type NiagaraParamSetParams = z.infer<typeof niagaraParamSetSchema>;

function niagaraParamSetScript(p: NiagaraParamSetParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_ref = ${pyStr(p.component)}`,
    `_name = ${pyStr(p.param_name)}`,
    `_vt = ${pyStr(p.value_type)}`,
    `_val = json.loads(${pyStr(JSON.stringify(p.value ?? null))})`,
    'def _go():',
    '    comp = _find_component(_ref)',
    '    if comp is None: raise Exception("niagara component not found: %s" % _ref)',
    '    applied = _apply_var(comp, _name, _vt, _val)',
    '    try: comp.set_render_state_dirty()',
    '    except Exception:',
    '        try: comp.mark_render_state_dirty()',
    '        except Exception: pass',
    '    warnings = []',
    '    if not applied: warnings.append("no setter accepted the value for type %s (value NOT applied)" % _vt)',
    '    _emit({"ok": bool(applied), "component_path": _ref, "param_name": _name, "value_type": _vt,',
    '           "applied": bool(applied), "warnings": warnings})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraParamSetDescriptor: PyToolDescriptor<typeof niagaraParamSetSchema.shape> = {
  name: 'niagara_param_set',
  description:
    'Set one USER variable on a live NiagaraComponent (float/int/bool/vec2/vec3/vec4/quat/color/position/object) and mark render state dirty. Named niagara_param_set to avoid colliding with the dormant satellite-plugin C++ niagara_set_param command; broadens value_type coverage. SET-SUCCESS: UE setters return void, so applied:true is reported ONLY when a setter probe ran without raising — otherwise ok:false + applied:false + a warning (never ok:true with an unapplied change).',
  cost: 'medium',
  returns: '{ok, component_path, param_name, value_type, applied, warnings[]}',
  schema: niagaraParamSetSchema.shape,
  meta: writeMeta,
  buildScript: niagaraParamSetScript,
  timeoutMs: 30_000,
};

// ── niagara_set_user_param_default (write default ON the asset) ───────────────
export const niagaraSetUserParamDefaultSchema = z.object({
  system_path: z.string().min(1).describe('Content path of the NiagaraSystem asset'),
  param_name: z.string().min(1).describe('Exposed user parameter name'),
  value_type: z.enum(VALUE_TYPES).describe('Value type of the parameter'),
  value: z.any().describe('The default value (same encoding as niagara_param_set)'),
  save: z.boolean().default(false).describe('Save the asset after setting the default'),
});
export type NiagaraSetUserParamDefaultParams = z.infer<typeof niagaraSetUserParamDefaultSchema>;

function niagaraSetUserParamDefaultScript(p: NiagaraSetUserParamDefaultParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_path = ${pyStr(p.system_path)}`,
    `_name = ${pyStr(p.param_name)}`,
    `_vt = ${pyStr(p.value_type)}`,
    `_val = json.loads(${pyStr(JSON.stringify(p.value ?? null))})`,
    `_save = ${p.save ? 'True' : 'False'}`,
    'def _go():',
    '    sys = _load_system(_path)',
    '    # exposed-parameter default write goes through the same typed setters on the',
    '    # system\'s exposed-parameter store; the store object is UNCERTAIN-API so we',
    '    # probe it and report applied honestly.',
    '    store = None',
    '    for g in ("get_exposed_parameters",):',
    '        try:',
    '            store = getattr(sys, g)(); break',
    '        except Exception: pass',
    '    if store is None:',
    '        try: store = sys.get_editor_property("exposed_parameters")',
    '        except Exception: store = None',
    '    applied = False; warnings = []',
    '    if store is None:',
    '        warnings.append("exposed_parameters store unavailable via python reflection (UNCERTAIN-API) — default NOT applied)")',
    '    else:',
    '        try:',
    '            applied = _apply_var(store, _name, _vt, _val)',
    '        except Exception as _e2:',
    '            warnings.append("setter raised on exposed-parameter store: %s" % _e2)',
    '        if not applied: warnings.append("no setter accepted the value for type %s (default NOT applied)" % _vt)',
    '    saved = False',
    '    if applied and _save:',
    '        try:',
    '            unreal.EditorAssetLibrary.save_asset(_path, only_if_is_dirty=False); saved = True',
    '        except Exception: warnings.append("save_asset failed")',
    '    _emit({"ok": bool(applied), "system_path": _path, "param_name": _name, "value_type": _vt,',
    '           "applied": bool(applied), "saved": saved, "warnings": warnings})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraSetUserParamDefaultDescriptor: PyToolDescriptor<typeof niagaraSetUserParamDefaultSchema.shape> = {
  name: 'niagara_set_user_param_default',
  description:
    'Set the DEFAULT value of an exposed user parameter ON the system asset (persists to the saved asset), not just a live component — the param-pack vehicle for customizing instantiated templates. SET-SUCCESS: applied:true only when a setter ran on the exposed-parameter store; the store is UNCERTAIN-API so failures surface ok:false + applied:false + warnings, never a silent no-op. Optionally saves the asset.',
  cost: 'medium',
  returns: '{ok, system_path, param_name, value_type, applied, saved, warnings[]}',
  schema: niagaraSetUserParamDefaultSchema.shape,
  meta: assetWriteMeta,
  buildScript: niagaraSetUserParamDefaultScript,
  timeoutMs: 30_000,
};

// ── niagara_component_inspect ────────────────────────────────────────────────
export const niagaraComponentInspectSchema = z.object({
  component: z.string().min(1).describe('NiagaraComponent object path OR an actor label/path carrying one'),
});
export type NiagaraComponentInspectParams = z.infer<typeof niagaraComponentInspectSchema>;

function niagaraComponentInspectScript(p: NiagaraComponentInspectParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_ref = ${pyStr(p.component)}`,
    'def _go():',
    '    comp = _find_component(_ref)',
    '    if comp is None: raise Exception("niagara component not found: %s" % _ref)',
    '    active = None; paused = None; age = None; sys_path = None',
    '    try: active = bool(comp.is_active())',
    '    except Exception: pass',
    '    try: paused = bool(comp.is_paused())',
    '    except Exception: pass',
    '    try:',
    '        a = comp.get_asset()',
    '        if a is not None: sys_path = a.get_path_name()',
    '    except Exception:',
    '        try:',
    '            a = comp.get_editor_property("asset")',
    '            if a is not None: sys_path = a.get_path_name()',
    '        except Exception: pass',
    '    cp = None',
    '    try: cp = comp.get_path_name()',
    '    except Exception: pass',
    '    _emit({"ok": True, "component_path": cp, "active": active, "paused": paused,',
    '           "age": age, "system_path": sys_path})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraComponentInspectDescriptor: PyToolDescriptor<typeof niagaraComponentInspectSchema.shape> = {
  name: 'niagara_component_inspect',
  description:
    'Read a live NiagaraComponent\'s runtime state: active/paused flags and the system asset it plays — the read-back/verify tool for runtime control ops (pairs with niagara_activate / niagara_param_set).',
  cost: 'low',
  returns: '{ok, component_path, active, paused, age, system_path}',
  schema: niagaraComponentInspectSchema.shape,
  meta: readMeta,
  buildScript: niagaraComponentInspectScript,
  timeoutMs: 30_000,
};

// ── niagara_list_components ──────────────────────────────────────────────────
export const niagaraListComponentsSchema = z.object({
  system_filter: z.string().optional().describe('Only return components whose system path contains this substring'),
  active_only: z.boolean().default(false).describe('Only return currently-active components'),
  limit: z.number().int().positive().default(50).describe('Max components to return'),
  offset: z.number().int().nonnegative().default(0).describe('Offset for pagination'),
});
export type NiagaraListComponentsParams = z.infer<typeof niagaraListComponentsSchema>;

function niagaraListComponentsScript(p: NiagaraListComponentsParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_filter = ${p.system_filter ? pyStr(p.system_filter) : 'None'}`,
    `_active_only = ${p.active_only ? 'True' : 'False'}`,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'def _go():',
    '    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
    '    acts = eas.get_all_level_actors() if eas is not None else []',
    '    comps = []',
    '    for a in acts:',
    '        try: cs = a.get_components_by_class(unreal.NiagaraComponent)',
    '        except Exception: cs = []',
    '        for c in cs:',
    '            sp = None; act = None',
    '            try:',
    '                asset = c.get_asset()',
    '                if asset is not None: sp = asset.get_path_name()',
    '            except Exception: pass',
    '            if _filter is not None and (sp is None or _filter not in sp): continue',
    '            is_act = None',
    '            try: is_act = bool(c.is_active())',
    '            except Exception: pass',
    '            if _active_only and not is_act: continue',
    '            try: act = a.get_path_name()',
    '            except Exception: pass',
    '            cp = None',
    '            try: cp = c.get_path_name()',
    '            except Exception: pass',
    '            comps.append({"path": cp, "actor": act, "system": sp, "active": is_act})',
    '    total = len(comps)',
    '    page = comps[_offset:_offset + _limit]',
    '    nxt = _offset + len(page)',
    '    _emit({"ok": True, "components": page, "count": total, "has_more": nxt < total, "next_offset": nxt})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraListComponentsDescriptor: PyToolDescriptor<typeof niagaraListComponentsSchema.shape> = {
  name: 'niagara_list_components',
  description:
    'Enumerate Niagara components on placed actors in the editor world (system path + active flag), optionally filtered by system substring or active-only, paginated — the "what VFX is currently in the scene" read tool.',
  cost: 'low',
  returns: '{ok, components:[{path,actor,system,active}], count, has_more, next_offset}',
  schema: niagaraListComponentsSchema.shape,
  meta: readMeta,
  buildScript: niagaraListComponentsScript,
  timeoutMs: 30_000,
};

// ── niagara_activate ─────────────────────────────────────────────────────────
export const niagaraActivateSchema = z.object({
  component: z.string().min(1).describe('NiagaraComponent object path OR an actor label/path carrying one'),
  reset: z.boolean().default(true).describe('Reset the simulation when (re)activating'),
  deactivate: z.boolean().default(false).describe('Deactivate instead of activate'),
});
export type NiagaraActivateParams = z.infer<typeof niagaraActivateSchema>;

function niagaraActivateScript(p: NiagaraActivateParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_ref = ${pyStr(p.component)}`,
    `_reset = ${p.reset ? 'True' : 'False'}`,
    `_deact = ${p.deactivate ? 'True' : 'False'}`,
    'def _go():',
    '    comp = _find_component(_ref)',
    '    if comp is None: raise Exception("niagara component not found: %s" % _ref)',
    '    done = False',
    '    if _deact:',
    '        done = _try(lambda: comp.deactivate())',
    '    else:',
    '        done = _try(lambda: comp.activate(_reset), lambda: comp.activate())',
    '    active = None',
    '    try: active = bool(comp.is_active())',
    '    except Exception: pass',
    '    warnings = []',
    '    if not done: warnings.append("activate/deactivate call did not run (component API missing)")',
    '    _emit({"ok": bool(done), "component_path": _ref, "active": active, "applied": bool(done), "warnings": warnings})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraActivateDescriptor: PyToolDescriptor<typeof niagaraActivateSchema.shape> = {
  name: 'niagara_activate',
  description:
    'Activate (optionally reset) or deactivate a live NiagaraComponent to (re)start/stop the effect — needed because many template systems ship auto_activate=false. SET-SUCCESS: applied:true only when the activate/deactivate call ran; reports the resulting active flag. Idempotent set-to-state.',
  cost: 'medium',
  returns: '{ok, component_path, active, applied, warnings[]}',
  schema: niagaraActivateSchema.shape,
  meta: writeMeta,
  buildScript: niagaraActivateScript,
  timeoutMs: 30_000,
};

// ── niagara_advance_simulation ───────────────────────────────────────────────
export const niagaraAdvanceSimulationSchema = z.object({
  component: z.string().min(1).describe('NiagaraComponent object path OR an actor label/path carrying one'),
  seconds: z.number().positive().describe('How many seconds of simulation to advance'),
  tick_dt: z.number().positive().default(0.0167).describe('Fixed per-tick delta seconds (default ~60fps)'),
});
export type NiagaraAdvanceSimulationParams = z.infer<typeof niagaraAdvanceSimulationSchema>;

function niagaraAdvanceSimulationScript(p: NiagaraAdvanceSimulationParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_ref = ${pyStr(p.component)}`,
    `_secs = ${p.seconds}`,
    `_dt = ${p.tick_dt}`,
    'def _go():',
    '    comp = _find_component(_ref)',
    '    if comp is None: raise Exception("niagara component not found: %s" % _ref)',
    '    ticks = max(1, int(round(_secs / _dt)))',
    '    done = _try(lambda: comp.advance_simulation(ticks, _dt),',
    '                lambda: comp.advance_simulation_by_time(_secs, _dt))',
    '    warnings = []',
    '    if not done: warnings.append("advance_simulation call did not run (component API missing)")',
    '    _emit({"ok": bool(done), "component_path": _ref, "advanced_seconds": _secs, "ticks": ticks, "applied": bool(done), "warnings": warnings})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraAdvanceSimulationDescriptor: PyToolDescriptor<typeof niagaraAdvanceSimulationSchema.shape> = {
  name: 'niagara_advance_simulation',
  description:
    'Deterministically tick a live NiagaraComponent\'s sim by N seconds at a fixed dt (AdvanceSimulation) so a screenshot is reproducible — the deterministic-preview primitive the vision loop needs (a transient effect is invisible at t=0). SET-SUCCESS: applied:true only when the advance call ran; arg order probed defensively. NON-IDEMPOTENT: each call advances the sim cumulatively, so a repeat/retry compounds simulated time — re-run from a fresh spawn for a reproducible frame.',
  cost: 'medium',
  returns: '{ok, component_path, advanced_seconds, ticks, applied, warnings[]}',
  schema: niagaraAdvanceSimulationSchema.shape,
  meta: writeMeta,
  buildScript: niagaraAdvanceSimulationScript,
  timeoutMs: 30_000,
};

// ── niagara_validate (PLUMB-style read-only) ─────────────────────────────────
export const niagaraValidateSchema = z.object({
  system_path: z.string().min(1).describe('Content path of the NiagaraSystem to validate'),
});
export type NiagaraValidateParams = z.infer<typeof niagaraValidateSchema>;

function niagaraValidateScript(p: NiagaraValidateParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_path = ${pyStr(p.system_path)}`,
    'def _go():',
    '    sys = _load_system(_path)',
    '    emitters, ew = _emitters(sys)',
    '    issues = []',
    '    for w in ew: issues.append({"code": "reflection_unavailable", "severity": "info", "detail": w})',
    '    fixed_bounds = None',
    '    try: fixed_bounds = bool(sys.get_editor_property("fixed_bounds"))',
    '    except Exception:',
    '        try: fixed_bounds = bool(sys.get_editor_property("bFixedBounds"))',
    '        except Exception: pass',
    '    has_gpu = False',
    '    for e in emitters:',
    '        st = (e.get("sim_target") or "")',
    '        if "GPU" in st: has_gpu = True',
    '    if has_gpu and fixed_bounds is False:',
    '        issues.append({"code": "gpu_without_fixed_bounds", "severity": "warning", "detail": "GPU emitter(s) present but system has no fixed bounds — may cull incorrectly"})',
    '    effect_type = None',
    '    try:',
    '        et = sys.get_editor_property("effect_type")',
    '        if et is not None: effect_type = et.get_name()',
    '    except Exception: pass',
    '    if not effect_type:',
    '        issues.append({"code": "missing_effect_type", "severity": "warning", "detail": "no effect type set — scalability/budgeting will use defaults"})',
    '    if emitters is not None and len(emitters) == 0:',
    '        issues.append({"code": "no_emitters", "severity": "warning", "detail": "no emitter handles resolved (empty system or reflection gap)"})',
    '    errs = [i for i in issues if i.get("severity") == "error"]',
    '    _emit({"ok": len(errs) == 0, "system_path": _path, "violations": issues, "fixed": [],',
    '           "error_count": len(errs), "warning_count": len([i for i in issues if i.get("severity") == "warning"])})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraValidateDescriptor: PyToolDescriptor<typeof niagaraValidateSchema.shape> = {
  name: 'niagara_validate',
  description:
    'PLUMB-style read-only check of a NiagaraSystem: GPU emitters without fixed bounds, missing effect type, no emitters. Returns categorised violations with severity; ok:false only on errors. Emitter reflection is UNCERTAIN-API — gaps are reported as info-level violations rather than false positives. (autofix not implemented this wave — fixed:[] always.)',
  cost: 'low',
  returns: '{ok, system_path, violations:[{code,severity,detail}], fixed, error_count, warning_count}',
  schema: niagaraValidateSchema.shape,
  meta: readMeta,
  buildScript: niagaraValidateScript,
  timeoutMs: 30_000,
};

// ── niagara_create_from_template ─────────────────────────────────────────────
export const niagaraCreateFromTemplateSchema = z.object({
  template_path: z.string().min(1).describe('Content path of an existing NiagaraSystem to duplicate'),
  dest_path: z.string().min(1).describe('Destination content folder, e.g. "/Game/VFX"'),
  name: z.string().min(1).describe('Asset name for the new system'),
  dry_run: z.boolean().default(false).describe('Preview the target path without duplicating'),
});
export type NiagaraCreateFromTemplateParams = z.infer<typeof niagaraCreateFromTemplateSchema>;

function niagaraCreateFromTemplateScript(p: NiagaraCreateFromTemplateParams): string {
  return [
    PY_NIAGARA_HELPERS,
    `_tpl = ${pyStr(p.template_path)}`,
    `_dest = ${pyStr(p.dest_path)}`,
    `_name = ${pyStr(p.name)}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _go():',
    '    src = _load_system(_tpl)',
    '    full = _dest.rstrip("/") + "/" + _name',
    '    if _dry:',
    '        _emit({"ok": True, "dry_run": True, "new_system_path": full, "source_template": _tpl,',
    '               "note": "graph authoring is a UE Python limit — template duplication is the supported creation verb"}); return',
    '    existing = unreal.EditorAssetLibrary.load_asset(full)',
    '    if existing is not None:',
    '        _emit({"ok": True, "new_system_path": full, "source_template": _tpl, "created": False, "note": "already exists"}); return',
    '    dup = unreal.EditorAssetLibrary.duplicate_asset(_tpl, full)',
    '    if dup is None: raise Exception("duplicate_asset returned None")',
    '    unreal.EditorAssetLibrary.save_asset(full, only_if_is_dirty=False)',
    '    _emit({"ok": True, "new_system_path": full, "source_template": _tpl, "created": True,',
    '           "note": "graph authoring is a UE Python limit — template duplication is the supported creation verb"})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const niagaraCreateFromTemplateDescriptor: PyToolDescriptor<typeof niagaraCreateFromTemplateSchema.shape> = {
  name: 'niagara_create_from_template',
  description:
    'The HONEST authoring path: duplicate an existing template NiagaraSystem to a new content path and rename it. Since UE Python cannot build emitter graphs, template-instantiation is the supported creation verb (flagged with the engine-limit note). Non-idempotent (creates an asset); idempotent-by-path (returns created:false if the target exists).',
  cost: 'medium',
  returns: '{ok, new_system_path, source_template, created?, note, dry_run?}',
  schema: niagaraCreateFromTemplateSchema.shape,
  meta: assetWriteMeta,
  buildScript: niagaraCreateFromTemplateScript,
  timeoutMs: 30_000,
};

// ── Aggregate: all niagara-domain PyToolDescriptors (spliced in index.ts) ─────
export const niagaraPyDescriptors: PyToolDescriptor[] = [
  niagaraCapabilityProbeDescriptor,
  niagaraSystemsDescriptor,
  niagaraSystemInspectDescriptor,
  niagaraParamListDescriptor,
  niagaraSpawnTransientDescriptor,
  niagaraPlaceActorDescriptor,
  niagaraParamSetDescriptor,
  niagaraSetUserParamDefaultDescriptor,
  niagaraComponentInspectDescriptor,
  niagaraListComponentsDescriptor,
  niagaraActivateDescriptor,
  niagaraAdvanceSimulationDescriptor,
  niagaraValidateDescriptor,
  niagaraCreateFromTemplateDescriptor,
] as unknown as PyToolDescriptor[];

/**
 * Niagara-domain factory tools that are non-idempotent (spawn a component/actor
 * or create an asset — retry would duplicate state). Mirrored into
 * tool-executor's NON_IDEMPOTENT set (which also carries the legacy
 * `niagara_spawn` entry for the dormant C++ command). The set-to-value/state
 * writes (niagara_param_set, niagara_set_user_param_default, niagara_activate,
 * niagara_advance_simulation) are idempotent per the house rule; the rest read.
 */
export const NIAGARA_NON_IDEMPOTENT: readonly string[] = [
  niagaraSpawnTransientDescriptor.name,
  niagaraPlaceActorDescriptor.name,
  niagaraCreateFromTemplateDescriptor.name,
  // Cumulative: advances the sim forward, so a retry double-advances.
  niagaraAdvanceSimulationDescriptor.name,
];
