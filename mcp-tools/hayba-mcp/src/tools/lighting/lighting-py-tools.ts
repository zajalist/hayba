// Lighting & post-process P0/P1 tools, generated as UE Python via the pyTemplate
// factory (see py-tool-factory.ts). Sibling of landscape/landscape-py-tools.ts and
// foliage/foliage-py-tools.ts (the closest Wave-3 pattern) — same PyToolDescriptor
// shape, same _emit/_err envelope (auto-prepended by runUePythonJson), same
// index.ts splice, same _prop()/_set()/_call() multi-name defensive reflection
// idiom, same warnings[] surfacing.
//
// Source of truth for the catalog: docs/plans/2026-06-28-mcp-supertooling-tools.json,
// domain "lighting-postprocess-and-rendering". We ship the python-feasible,
// confident, NET-NEW subset that AUTHORS lights + post-process directly (spawn,
// read, set, configure). We SKIP catalog entries whose only reliable path is the
// render / job-envelope / vision-loop pipeline, a project-settings/RHI toggle, or
// the PLUMB validator loop (shipping an always-erroring tool is worse than not
// shipping it):
//
//   SHIPPED (14):
//     reads  — lighting_capability_probe, light_list, light_get,
//              postprocess_list_volumes, postprocess_get
//     writes — light_set, postprocess_set, exposure_set, lumen_configure,
//              color_grading_set, fog_configure  (all set-to-value / retry-safe)
//     non-idempotent — light_spawn (actor-create), postprocess_spawn_volume
//              (actor-create), sky_setup (spawns SkyAtmosphere+SkyLight+Sun triad)
//
//   SKIPPED (why):
//     - buffer_visualization_capture / orbit_capture / auto_frame_actor /
//       thumbnail_generate / before_after_capture / high_res_screenshot /
//       movie_render → render_camera / SceneCapture / MovieRenderQueue job-envelope
//       + vision-loop effort (a separate 4B surface; the RenderHandler already owns
//       render_camera). Not stateless-python-feasible here.
//     - viewport_set_view_mode → extends the existing C++ 4-mode viewport switch;
//       belongs beside that handler, not a net-new python verb.
//     - reflection_method_set / shadow_configure → partially subsumed
//       (reflection method is covered by lumen_configure.reflections_enabled;
//       shadow method / VSM / cascades are largely project-level or need a
//       reflection-capture BUILD step behind the job envelope) — deferred to avoid
//       speculative always-erroring knobs.
//     - nanite_set / render_cvar_set → mesh-asset build-setting + console-variable
//       escape hatch; a distinct perf/cvar surface, not lighting authoring.
//     - lighting_preset_apply / lighting_validate → the transaction/undo + PLUMB
//       validator differentiators; compose the verbs below, built on the validator
//       loop (world_generate/plumb surface), not raw python.
//
//   3-SURFACE OVERLAP AUDIT (checked before naming — the W3T2 lesson):
//     (a) sidecar.json (src/legacy-commands/sidecar.json): no light_*/postprocess_*/
//         exposure_*/sky_*/lumen_*/fog_* commands.
//     (b) index.ts registered tools: none in these namespaces.
//     (c) compiled C++ handlers (unreal/.../Private/handlers/*.cpp): no light/
//         postprocess/exposure/sky/lumen/fog GetCommands entries; the only nearby
//         handler is HaybaMCPRenderHandler (render_camera) — different namespace.
//     => every name below is collision-free across all three surfaces.
//
// KEY GOTCHA — FPostProcessSettings bOverride_ flags: PostProcessVolume.settings is
// an FPostProcessSettings struct where each field (e.g. BloomIntensity) is IGNORED
// unless its paired bOverride_<Field> bool is true. Setting the value WITHOUT the
// flag is a silent no-op. Every PP set-tool here sets the override flag alongside
// the value (via _pp_apply → override_<field>) AND writes the whole struct back to
// the actor (per the pcg_set_prop nested-struct lesson: get struct → mutate →
// set_editor_property("settings", struct)), because the returned struct is a copy.
//
// UNCERTAIN-API flags for the next live-validation pass (all wrapped defensively so
// they degrade to a structured value/error/warning, never a silent wrong answer):
//   - Light-component property spellings (intensity, light_color as FColor,
//     temperature/use_temperature, attenuation_radius, cast_shadows, mobility as
//     ComponentMobility) are probed via _prop/_set multi-name; unknown keys land in
//     unchanged_keys[] not silently lost.
//   - FPostProcessSettings value + override property names (override_<field>) are
//     probed per field; a field whose value-or-override set fails is reported in
//     unchanged_keys[].
//   - Lumen enums (DynamicGlobalIlluminationMethod / ReflectionMethod) and
//     AutoExposureMethod are getattr-probed; absence degrades to a warning.
//   - Spawn classes (DirectionalLight/PointLight/SpotLight/RectLight/SkyLight,
//     PostProcessVolume, SkyAtmosphere, ExponentialHeightFog) are getattr-probed
//     and error clearly when not python-exposed.

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

// ── Shared Python: world/actor resolution + light-component + PP-settings probes ─
const PY_LIGHTING_HELPERS = [
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
  'def _resolve_actor(ref):',
  '    acts = _all_actors()',
  '    for a in acts:',
  '        try:',
  '            if a.get_actor_label() == ref or a.get_path_name() == ref: return a',
  '        except Exception: pass',
  '    sub = []',
  '    for a in acts:',
  '        try:',
  '            if ref in a.get_actor_label(): sub.append(a)',
  '        except Exception: pass',
  '    if len(sub) == 1: return sub[0]',
  '    if len(sub) > 1: raise Exception("ambiguous actor ref %r matches %d actors" % (ref, len(sub)))',
  '    raise Exception("actor not found: %s" % ref)',
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
  'def _call(obj, names, *args):',
  '    for n in names:',
  '        fn = getattr(obj, n, None)',
  '        if fn is None: continue',
  '        try: return (True, fn(*args))',
  '        except Exception: pass',
  '    return (False, None)',
  'def _enum_str(v):',
  '    try: return str(v)',
  '    except Exception: return None',
  '_LIGHT_COMP_NAMES = ("DirectionalLightComponent","PointLightComponent","SpotLightComponent","RectLightComponent","SkyLightComponent","LightComponentBase","LightComponent")',
  'def _light_comp(a):',
  '    for cn in _LIGHT_COMP_NAMES:',
  '        cls = getattr(unreal, cn, None)',
  '        if cls is None: continue',
  '        try:',
  '            comps = a.get_components_by_class(cls)',
  '            if comps: return comps[0]',
  '        except Exception: pass',
  '    return None',
  'def _color_list(c):',
  '    try: return [c.r, c.g, c.b]',
  '    except Exception: return None',
  'def _mk_color(rgb):',
  '    return unreal.Color(int(rgb[0]), int(rgb[1]), int(rgb[2]), 255)',
  'def _light_read(comp):',
  '    return {"intensity": _prop(comp, "intensity"),',
  '            "light_color": _color_list(_prop(comp, "light_color")),',
  '            "temperature": _prop(comp, "temperature"),',
  '            "use_temperature": _prop(comp, "use_temperature"),',
  '            "attenuation_radius": _prop(comp, "attenuation_radius"),',
  '            "cast_shadows": _prop(comp, "cast_shadows", "casts_dynamic_shadows"),',
  '            "mobility": _enum_str(_prop(comp, "mobility"))}',
  'def _ppvs():',
  '    out = []',
  '    cls = getattr(unreal, "PostProcessVolume", None)',
  '    if cls is None: return out',
  '    for a in _all_actors():',
  '        try:',
  '            if isinstance(a, cls): out.append(a)',
  '        except Exception: pass',
  '    return out',
  'def _resolve_ppv(ref):',
  '    if ref:',
  '        a = _resolve_actor(ref)',
  '        cls = getattr(unreal, "PostProcessVolume", None)',
  '        if cls is not None and not isinstance(a, cls):',
  '            raise Exception("actor %s is not a PostProcessVolume" % ref)',
  '        return a',
  '    vs = _ppvs()',
  '    if not vs: raise Exception("no PostProcessVolume in level (postprocess_spawn_volume first)")',
  '    for v in vs:',
  '        try:',
  '            if v.get_editor_property("unbound"): return v',
  '        except Exception: pass',
  '    return vs[0]',
  'def _pp_settings(ppv):',
  '    return ppv.get_editor_property("settings")',
  'def _pp_write(ppv, s):',
  '    ppv.set_editor_property("settings", s)',
  'def _pp_apply(s, value, vprop, oprop):',
  '    okv = _set(s, value, vprop)',
  '    oko = _set(s, True, oprop)',
  '    return okv and oko',
].join('\n');

const readMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'inspecting lights or post-process volumes before tuning them (the read half of the inspect-then-edit loop)',
  not_when: 'you already hold a fresh read-back from a prior call',
};

const writeMeta: HaybaToolMeta = {
  cost: 'low',
  effects: ['mutates_actor'],
  when: 'tuning a light or post-process volume in the active level and you want structured read-back in one call',
  not_when: 'applying a named lighting look or running the PLUMB lighting validator — those are separate outcome/validator surfaces',
};

const numLit = (v: number | undefined): string => (v !== undefined ? String(v) : 'None');
const boolLit = (v: boolean | undefined): string => (v === undefined ? 'None' : v ? 'True' : 'False');

// ── lighting_capability_probe ─────────────────────────────────────────────────
export const lightingCapabilityProbeSchema = z.object({});
export type LightingCapabilityProbeParams = z.infer<typeof lightingCapabilityProbeSchema>;

function capabilityProbeScript(_p: LightingCapabilityProbeParams): string {
  return [
    PY_LIGHTING_HELPERS,
    'try:',
    '    def _has(n): return hasattr(unreal, n)',
    '    caps = {',
    '        "has_directional_light": _has("DirectionalLight"),',
    '        "has_point_light": _has("PointLight"),',
    '        "has_spot_light": _has("SpotLight"),',
    '        "has_rect_light": _has("RectLight"),',
    '        "has_sky_light": _has("SkyLight"),',
    '        "has_sky_atmosphere": _has("SkyAtmosphere"),',
    '        "has_exponential_height_fog": _has("ExponentialHeightFog"),',
    '        "has_post_process_volume": _has("PostProcessVolume"),',
    '        "has_lumen_gi_enum": _has("DynamicGlobalIlluminationMethod"),',
    '        "has_reflection_method_enum": _has("ReflectionMethod"),',
    '        "has_auto_exposure_enum": _has("AutoExposureMethod"),',
    '    }',
    '    lights = 0',
    '    for a in _all_actors():',
    '        if _light_comp(a) is not None: lights += 1',
    '    try: ev = unreal.SystemLibrary.get_engine_version()',
    '    except Exception: ev = None',
    '    _emit({"ok": True, "capabilities": caps, "engine_version": ev,',
    '           "light_actor_count": lights, "post_process_volumes": len(_ppvs())})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const lightingCapabilityProbeDescriptor: PyToolDescriptor<typeof lightingCapabilityProbeSchema.shape> = {
  name: 'lighting_capability_probe',
  description:
    'Report which UE Python lighting/post-process bindings are available (light actor classes, SkyAtmosphere, ExponentialHeightFog, PostProcessVolume, Lumen/reflection/auto-exposure enums) plus engine version, light-actor count and PPV count — the graceful-degradation gate to call BEFORE any spawn/set op.',
  cost: 'low',
  returns:
    '{ok, capabilities:{has_directional_light,has_point_light,has_spot_light,has_rect_light,has_sky_light,has_sky_atmosphere,has_exponential_height_fog,has_post_process_volume,has_lumen_gi_enum,has_reflection_method_enum,has_auto_exposure_enum}, engine_version, light_actor_count, post_process_volumes}',
  schema: lightingCapabilityProbeSchema.shape,
  meta: readMeta,
  buildScript: capabilityProbeScript,
  timeoutMs: 30_000,
};

// ── light_list ────────────────────────────────────────────────────────────────
export const lightListSchema = z.object({
  limit: z.number().int().positive().optional().default(100).describe('Max lights returned (pagination)'),
  offset: z.number().int().nonnegative().optional().default(0).describe('Pagination offset'),
});
export type LightListParams = z.infer<typeof lightListSchema>;

function lightListScript(p: LightListParams): string {
  return [
    PY_LIGHTING_HELPERS,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'try:',
    '    found = []',
    '    for a in _all_actors():',
    '        comp = _light_comp(a)',
    '        if comp is None: continue',
    '        found.append((a, comp))',
    '    total = len(found)',
    '    page = found[_offset:_offset+_limit]',
    '    out = []',
    '    for a, comp in page:',
    '        row = {"actor_id": a.get_actor_label(), "path": a.get_path_name(),',
    '               "class": type(a).__name__, "component": type(comp).__name__}',
    '        row.update(_light_read(comp))',
    '        out.append(row)',
    '    _emit({"ok": True, "lights": out, "total": total,',
    '           "has_more": (_offset+_limit) < total, "next_offset": _offset+_limit})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const lightListDescriptor: PyToolDescriptor<typeof lightListSchema.shape> = {
  name: 'light_list',
  description:
    'Enumerate every light actor in the level with its light component class and key properties (intensity, color, temperature, attenuation radius, cast-shadows, mobility). Paginated. The read entry point so agents tune lights from real values, not guesses.',
  cost: 'low',
  returns:
    '{ok, lights:[{actor_id,path,class,component,intensity,light_color,temperature,use_temperature,attenuation_radius,cast_shadows,mobility}], total, has_more, next_offset}',
  schema: lightListSchema.shape,
  meta: readMeta,
  buildScript: lightListScript,
  timeoutMs: 30_000,
};

// ── light_get ─────────────────────────────────────────────────────────────────
export const lightGetSchema = z.object({
  actor_id: z.string().min(1).describe('Light actor label (outliner name) or full path'),
});
export type LightGetParams = z.infer<typeof lightGetSchema>;

function lightGetScript(p: LightGetParams): string {
  return [
    PY_LIGHTING_HELPERS,
    `_ref = ${pyStr(p.actor_id)}`,
    'try:',
    '    a = _resolve_actor(_ref)',
    '    comp = _light_comp(a)',
    '    if comp is None: raise Exception("actor %s has no light component" % _ref)',
    '    row = {"ok": True, "actor_id": a.get_actor_label(), "path": a.get_path_name(),',
    '           "class": type(a).__name__, "component": type(comp).__name__}',
    '    row.update(_light_read(comp))',
    '    _emit(row)',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const lightGetDescriptor: PyToolDescriptor<typeof lightGetSchema.shape> = {
  name: 'light_get',
  description:
    'Read all key properties of a single light (intensity, color, temperature, attenuation radius, cast-shadows, mobility) — the paired read for verify/diff before a light_set write.',
  cost: 'low',
  returns:
    '{ok, actor_id, path, class, component, intensity, light_color, temperature, use_temperature, attenuation_radius, cast_shadows, mobility}',
  schema: lightGetSchema.shape,
  meta: readMeta,
  buildScript: lightGetScript,
  timeoutMs: 30_000,
};

// ── light_set ─────────────────────────────────────────────────────────────────
export const lightSetSchema = z.object({
  actor_id: z.string().min(1).describe('Light actor label or full path'),
  intensity: z.number().nonnegative().optional().describe('Light intensity (units depend on light type)'),
  color: z.array(z.number()).length(3).optional().describe('[r,g,b] 0-255 light color'),
  temperature: z.number().positive().optional().describe('Color temperature in Kelvin (also enables use_temperature)'),
  attenuation_radius: z.number().positive().optional().describe('Attenuation radius (point/spot/rect lights)'),
  cast_shadows: z.boolean().optional().describe('Whether the light casts shadows'),
  mobility: z.enum(['static', 'stationary', 'movable']).optional().describe('Component mobility'),
});
export type LightSetParams = z.infer<typeof lightSetSchema>;

function lightSetScript(p: LightSetParams): string {
  return [
    PY_LIGHTING_HELPERS,
    `_ref = ${pyStr(p.actor_id)}`,
    `_intensity = ${numLit(p.intensity)}`,
    `_color = ${p.color !== undefined ? JSON.stringify(p.color) : 'None'}`,
    `_temp = ${numLit(p.temperature)}`,
    `_atten = ${numLit(p.attenuation_radius)}`,
    `_cast = ${boolLit(p.cast_shadows)}`,
    `_mobility = ${p.mobility !== undefined ? pyStr(p.mobility) : 'None'}`,
    'try:',
    '    provided = [x for x in [_intensity,_color,_temp,_atten,_cast,_mobility] if x is not None]',
    '    if not provided: raise Exception("provide at least one property to set")',
    '    a = _resolve_actor(_ref)',
    '    comp = _light_comp(a)',
    '    if comp is None: raise Exception("actor %s has no light component" % _ref)',
    '    changed = []',
    '    unchanged = []',
    '    def _apply(key, ok):',
    '        (changed if ok else unchanged).append(key)',
    '    if _intensity is not None: _apply("intensity", _set(comp, _intensity, "intensity"))',
    '    if _color is not None: _apply("light_color", _set(comp, _mk_color(_color), "light_color"))',
    '    if _temp is not None:',
    '        okt = _set(comp, _temp, "temperature")',
    '        _set(comp, True, "use_temperature")',
    '        _apply("temperature", okt)',
    '    if _atten is not None: _apply("attenuation_radius", _set(comp, _atten, "attenuation_radius"))',
    '    if _cast is not None: _apply("cast_shadows", _set(comp, _cast, "cast_shadows", "casts_dynamic_shadows"))',
    '    if _mobility is not None:',
    '        _mm = {"static": "STATIC", "stationary": "STATIONARY", "movable": "MOVABLE"}[_mobility]',
    '        mob = getattr(unreal.ComponentMobility, _mm, None)',
    '        _apply("mobility", mob is not None and _set(comp, mob, "mobility"))',
    '    _emit({"ok": True, "actor_id": a.get_actor_label(), "changed_keys": changed,',
    '           "unchanged_keys": unchanged, "readback": _light_read(comp)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const lightSetDescriptor: PyToolDescriptor<typeof lightSetSchema.shape> = {
  name: 'light_set',
  description:
    'Set core properties on an existing light — intensity, RGB color, color temperature (auto-enables use_temperature), attenuation radius, cast-shadows, mobility — then read back. Set-to-value (retry-safe); omitted fields untouched. UNCERTAIN-API: property spellings are probed and land in unchanged_keys[] rather than being silently lost.',
  cost: 'low',
  returns: '{ok, actor_id, changed_keys[], unchanged_keys[], readback}',
  schema: lightSetSchema.shape,
  meta: writeMeta,
  buildScript: lightSetScript,
  timeoutMs: 30_000,
};

// ── postprocess_list_volumes ──────────────────────────────────────────────────
export const postprocessListVolumesSchema = z.object({});
export type PostprocessListVolumesParams = z.infer<typeof postprocessListVolumesSchema>;

function ppListScript(_p: PostprocessListVolumesParams): string {
  return [
    PY_LIGHTING_HELPERS,
    'try:',
    '    out = []',
    '    for v in _ppvs():',
    '        out.append({"actor_id": v.get_actor_label(), "path": v.get_path_name(),',
    '                    "unbound": _prop(v, "unbound"), "priority": _prop(v, "priority"),',
    '                    "blend_weight": _prop(v, "blend_weight"), "enabled": _prop(v, "enabled")})',
    '    _emit({"ok": True, "volumes": out, "total": len(out)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const postprocessListVolumesDescriptor: PyToolDescriptor<typeof postprocessListVolumesSchema.shape> = {
  name: 'postprocess_list_volumes',
  description:
    'Enumerate every PostProcessVolume in the level with unbound/priority/blend-weight/enabled — the read entry point so agents target the right volume (or discover none exists) before a postprocess_set / exposure_set / lumen_configure write.',
  cost: 'low',
  returns: '{ok, volumes:[{actor_id,path,unbound,priority,blend_weight,enabled}], total}',
  schema: postprocessListVolumesSchema.shape,
  meta: readMeta,
  buildScript: ppListScript,
  timeoutMs: 30_000,
};

// ── postprocess_get ───────────────────────────────────────────────────────────
export const postprocessGetSchema = z.object({
  volume: z.string().optional().describe('PostProcessVolume label/path; omit to target the unbound (global) volume'),
});
export type PostprocessGetParams = z.infer<typeof postprocessGetSchema>;

function ppGetScript(p: PostprocessGetParams): string {
  return [
    PY_LIGHTING_HELPERS,
    `_ref = ${p.volume !== undefined ? pyStr(p.volume) : 'None'}`,
    'try:',
    '    ppv = _resolve_ppv(_ref)',
    '    s = _pp_settings(ppv)',
    '    fields = ["bloom_intensity","vignette_intensity","film_grain_intensity","scene_fringe_intensity",',
    '              "motion_blur_amount","ambient_occlusion_intensity","auto_exposure_bias",',
    '              "auto_exposure_min_brightness","auto_exposure_max_brightness","depth_of_field_fstop",',
    '              "white_temp","white_tint","lumen_final_gather_quality","lumen_max_trace_distance",',
    '              "color_saturation","color_contrast","color_gamma","color_gain"]',
    '    values = {}',
    '    overrides = {}',
    '    for f in fields:',
    '        v = _prop(s, f)',
    '        if v is not None: values[f] = v',
    '        ov = _prop(s, "override_" + f)',
    '        if ov is not None: overrides[f] = bool(ov)',
    '    gi = _enum_str(_prop(s, "dynamic_global_illumination_method"))',
    '    refl = _enum_str(_prop(s, "reflection_method"))',
    '    ae = _enum_str(_prop(s, "auto_exposure_method"))',
    '    _emit({"ok": True, "volume": ppv.get_actor_label(), "path": ppv.get_path_name(),',
    '           "unbound": _prop(ppv, "unbound"), "priority": _prop(ppv, "priority"),',
    '           "values": values, "overrides": overrides,',
    '           "dynamic_global_illumination_method": gi, "reflection_method": refl,',
    '           "auto_exposure_method": ae})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const postprocessGetDescriptor: PyToolDescriptor<typeof postprocessGetSchema.shape> = {
  name: 'postprocess_get',
  description:
    'Read back PostProcessSettings values AND which bOverride_* flags are active on a PostProcessVolume (a value with its override false is inert) plus the Lumen GI / reflection / auto-exposure methods — the paired read so agents see what is actually overridden before a postprocess_set / lumen_configure / exposure_set write.',
  cost: 'low',
  returns:
    '{ok, volume, path, unbound, priority, values:{...}, overrides:{field:bool}, dynamic_global_illumination_method, reflection_method, auto_exposure_method}',
  schema: postprocessGetSchema.shape,
  meta: readMeta,
  buildScript: ppGetScript,
  timeoutMs: 30_000,
};

// ── postprocess_set ───────────────────────────────────────────────────────────
export const postprocessSetSchema = z.object({
  volume: z.string().optional().describe('PostProcessVolume label/path; omit to target the unbound (global) volume'),
  bloom_intensity: z.number().nonnegative().optional().describe('Bloom intensity'),
  vignette_intensity: z.number().nonnegative().optional().describe('Vignette intensity'),
  film_grain_intensity: z.number().nonnegative().optional().describe('Film grain intensity'),
  chromatic_aberration: z.number().nonnegative().optional().describe('Chromatic aberration (scene fringe intensity)'),
  motion_blur_amount: z.number().nonnegative().optional().describe('Motion blur amount'),
  ambient_occlusion_intensity: z.number().nonnegative().optional().describe('Ambient occlusion intensity'),
  depth_of_field_fstop: z.number().positive().optional().describe('Depth-of-field aperture (f-stop)'),
});
export type PostprocessSetParams = z.infer<typeof postprocessSetSchema>;

function ppSetScript(p: PostprocessSetParams): string {
  return [
    PY_LIGHTING_HELPERS,
    `_ref = ${p.volume !== undefined ? pyStr(p.volume) : 'None'}`,
    `_bloom = ${numLit(p.bloom_intensity)}`,
    `_vignette = ${numLit(p.vignette_intensity)}`,
    `_grain = ${numLit(p.film_grain_intensity)}`,
    `_fringe = ${numLit(p.chromatic_aberration)}`,
    `_mblur = ${numLit(p.motion_blur_amount)}`,
    `_ao = ${numLit(p.ambient_occlusion_intensity)}`,
    `_dof = ${numLit(p.depth_of_field_fstop)}`,
    'try:',
    '    spec = [("bloom_intensity", _bloom), ("vignette_intensity", _vignette),',
    '            ("film_grain_intensity", _grain), ("scene_fringe_intensity", _fringe),',
    '            ("motion_blur_amount", _mblur), ("ambient_occlusion_intensity", _ao),',
    '            ("depth_of_field_fstop", _dof)]',
    '    provided = [x for x in spec if x[1] is not None]',
    '    if not provided: raise Exception("provide at least one post-process field to set")',
    '    ppv = _resolve_ppv(_ref)',
    '    s = _pp_settings(ppv)',
    '    changed = []',
    '    unchanged = []',
    '    for f, val in provided:',
    '        # bOverride_ gotcha: set the override flag alongside the value or it is a silent no-op',
    '        if _pp_apply(s, val, f, "override_" + f): changed.append(f)',
    '        else: unchanged.append(f)',
    '    _pp_write(ppv, s)  # struct is a copy — write it back whole',
    '    _emit({"ok": True, "volume": ppv.get_actor_label(), "changed_keys": changed,',
    '           "unchanged_keys": unchanged})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const postprocessSetDescriptor: PyToolDescriptor<typeof postprocessSetSchema.shape> = {
  name: 'postprocess_set',
  description:
    'Set PostProcessSettings on a PostProcessVolume — bloom, vignette, film-grain, chromatic-aberration, motion-blur, ambient-occlusion, depth-of-field f-stop — with the correct bOverride_* flag set alongside each value (a value without its override is a silent no-op) and the whole settings struct written back. Set-to-value (retry-safe); omitted fields untouched. UNCERTAIN-API: a field whose value/override set fails lands in unchanged_keys[].',
  cost: 'low',
  returns: '{ok, volume, changed_keys[], unchanged_keys[]}',
  schema: postprocessSetSchema.shape,
  meta: writeMeta,
  buildScript: ppSetScript,
  timeoutMs: 30_000,
};

// ── exposure_set ──────────────────────────────────────────────────────────────
export const exposureSetSchema = z.object({
  volume: z.string().optional().describe('PostProcessVolume label/path; omit to target the unbound (global) volume'),
  method: z.enum(['manual', 'histogram', 'basic']).optional().describe('Auto-exposure method'),
  bias: z.number().optional().describe('Exposure compensation (EV bias)'),
  min_ev: z.number().optional().describe('Auto-exposure minimum brightness (EV100)'),
  max_ev: z.number().optional().describe('Auto-exposure maximum brightness (EV100)'),
});
export type ExposureSetParams = z.infer<typeof exposureSetSchema>;

function exposureSetScript(p: ExposureSetParams): string {
  return [
    PY_LIGHTING_HELPERS,
    `_ref = ${p.volume !== undefined ? pyStr(p.volume) : 'None'}`,
    `_method = ${p.method !== undefined ? pyStr(p.method) : 'None'}`,
    `_bias = ${numLit(p.bias)}`,
    `_min = ${numLit(p.min_ev)}`,
    `_max = ${numLit(p.max_ev)}`,
    'try:',
    '    if _method is None and _bias is None and _min is None and _max is None:',
    '        raise Exception("provide method/bias/min_ev/max_ev")',
    '    ppv = _resolve_ppv(_ref)',
    '    s = _pp_settings(ppv)',
    '    changed = []',
    '    unchanged = []',
    '    warnings = []',
    '    if _method is not None:',
    '        _em = {"manual": "AEM_MANUAL", "histogram": "AEM_HISTOGRAM", "basic": "AEM_BASIC"}[_method]',
    '        aem = getattr(getattr(unreal, "AutoExposureMethod", None), _em, None)',
    '        if aem is None: warnings.append("AutoExposureMethod enum not exposed")',
    '        elif _pp_apply(s, aem, "auto_exposure_method", "override_auto_exposure_method"): changed.append("auto_exposure_method")',
    '        else: unchanged.append("auto_exposure_method")',
    '    if _bias is not None:',
    '        (changed if _pp_apply(s, _bias, "auto_exposure_bias", "override_auto_exposure_bias") else unchanged).append("auto_exposure_bias")',
    '    if _min is not None:',
    '        (changed if _pp_apply(s, _min, "auto_exposure_min_brightness", "override_auto_exposure_min_brightness") else unchanged).append("auto_exposure_min_brightness")',
    '    if _max is not None:',
    '        (changed if _pp_apply(s, _max, "auto_exposure_max_brightness", "override_auto_exposure_max_brightness") else unchanged).append("auto_exposure_max_brightness")',
    '    _pp_write(ppv, s)',
    '    _emit({"ok": True, "volume": ppv.get_actor_label(), "changed_keys": changed,',
    '           "unchanged_keys": unchanged, "warnings": warnings})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const exposureSetDescriptor: PyToolDescriptor<typeof exposureSetSchema.shape> = {
  name: 'exposure_set',
  description:
    'Set auto-exposure on a PostProcessVolume — method (manual/histogram/basic), EV bias, min/max EV100 — each with its bOverride_* flag set and the struct written back. The single most-asked PP knob as a focused verb. Set-to-value (retry-safe). UNCERTAIN-API: AutoExposureMethod enum absence degrades to a warning.',
  cost: 'low',
  returns: '{ok, volume, changed_keys[], unchanged_keys[], warnings[]}',
  schema: exposureSetSchema.shape,
  meta: writeMeta,
  buildScript: exposureSetScript,
  timeoutMs: 30_000,
};

// ── lumen_configure ───────────────────────────────────────────────────────────
export const lumenConfigureSchema = z.object({
  volume: z.string().optional().describe('PostProcessVolume label/path; omit to target the unbound (global) volume'),
  gi_enabled: z.boolean().optional().describe('Enable Lumen dynamic global illumination (false = None)'),
  reflections_enabled: z.boolean().optional().describe('Enable Lumen reflections (false = None)'),
  final_gather_quality: z.number().positive().optional().describe('Lumen final-gather quality scale'),
  max_trace_distance: z.number().positive().optional().describe('Lumen max trace distance (world units)'),
});
export type LumenConfigureParams = z.infer<typeof lumenConfigureSchema>;

function lumenConfigureScript(p: LumenConfigureParams): string {
  return [
    PY_LIGHTING_HELPERS,
    `_ref = ${p.volume !== undefined ? pyStr(p.volume) : 'None'}`,
    `_gi = ${boolLit(p.gi_enabled)}`,
    `_refl = ${boolLit(p.reflections_enabled)}`,
    `_fgq = ${numLit(p.final_gather_quality)}`,
    `_mtd = ${numLit(p.max_trace_distance)}`,
    'try:',
    '    if _gi is None and _refl is None and _fgq is None and _mtd is None:',
    '        raise Exception("provide gi_enabled/reflections_enabled/final_gather_quality/max_trace_distance")',
    '    ppv = _resolve_ppv(_ref)',
    '    s = _pp_settings(ppv)',
    '    changed = []',
    '    unchanged = []',
    '    warnings = []',
    '    if _gi is not None:',
    '        gie = getattr(unreal, "DynamicGlobalIlluminationMethod", None)',
    '        val = getattr(gie, "LUMEN" if _gi else "NONE", None) if gie is not None else None',
    '        if val is None: warnings.append("DynamicGlobalIlluminationMethod enum not exposed")',
    '        elif _pp_apply(s, val, "dynamic_global_illumination_method", "override_dynamic_global_illumination_method"): changed.append("dynamic_global_illumination_method")',
    '        else: unchanged.append("dynamic_global_illumination_method")',
    '    if _refl is not None:',
    '        rme = getattr(unreal, "ReflectionMethod", None)',
    '        val = getattr(rme, "LUMEN" if _refl else "NONE", None) if rme is not None else None',
    '        if val is None: warnings.append("ReflectionMethod enum not exposed")',
    '        elif _pp_apply(s, val, "reflection_method", "override_reflection_method"): changed.append("reflection_method")',
    '        else: unchanged.append("reflection_method")',
    '    if _fgq is not None:',
    '        (changed if _pp_apply(s, _fgq, "lumen_final_gather_quality", "override_lumen_final_gather_quality") else unchanged).append("lumen_final_gather_quality")',
    '    if _mtd is not None:',
    '        (changed if _pp_apply(s, _mtd, "lumen_max_trace_distance", "override_lumen_max_trace_distance") else unchanged).append("lumen_max_trace_distance")',
    '    _pp_write(ppv, s)',
    '    _emit({"ok": True, "volume": ppv.get_actor_label(), "changed_keys": changed,',
    '           "unchanged_keys": unchanged, "warnings": warnings})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const lumenConfigureDescriptor: PyToolDescriptor<typeof lumenConfigureSchema.shape> = {
  name: 'lumen_configure',
  description:
    'Enable/disable Lumen GI and reflections (false = None) and set final-gather quality + max-trace-distance on a PostProcessVolume, each with its bOverride_* flag and the struct written back — the headline UE5 lighting verb. Set-to-value (retry-safe). UNCERTAIN-API: Lumen enums are probed and their absence degrades to a warning.',
  cost: 'low',
  returns: '{ok, volume, changed_keys[], unchanged_keys[], warnings[]}',
  schema: lumenConfigureSchema.shape,
  meta: writeMeta,
  buildScript: lumenConfigureScript,
  timeoutMs: 30_000,
};

// ── color_grading_set ─────────────────────────────────────────────────────────
export const colorGradingSetSchema = z.object({
  volume: z.string().optional().describe('PostProcessVolume label/path; omit to target the unbound (global) volume'),
  white_temp: z.number().positive().optional().describe('White-balance temperature (Kelvin)'),
  white_tint: z.number().optional().describe('White-balance tint (-1..1)'),
  saturation: z.number().nonnegative().optional().describe('Global color saturation (applied to R/G/B, alpha=1)'),
  contrast: z.number().nonnegative().optional().describe('Global color contrast (applied to R/G/B, alpha=1)'),
  gamma: z.number().nonnegative().optional().describe('Global color gamma (applied to R/G/B, alpha=1)'),
  gain: z.number().nonnegative().optional().describe('Global color gain (applied to R/G/B, alpha=1)'),
});
export type ColorGradingSetParams = z.infer<typeof colorGradingSetSchema>;

function colorGradingSetScript(p: ColorGradingSetParams): string {
  return [
    PY_LIGHTING_HELPERS,
    `_ref = ${p.volume !== undefined ? pyStr(p.volume) : 'None'}`,
    `_wtemp = ${numLit(p.white_temp)}`,
    `_wtint = ${numLit(p.white_tint)}`,
    `_sat = ${numLit(p.saturation)}`,
    `_con = ${numLit(p.contrast)}`,
    `_gam = ${numLit(p.gamma)}`,
    `_gain = ${numLit(p.gain)}`,
    'try:',
    '    if all(x is None for x in [_wtemp,_wtint,_sat,_con,_gam,_gain]):',
    '        raise Exception("provide at least one color-grading field")',
    '    ppv = _resolve_ppv(_ref)',
    '    s = _pp_settings(ppv)',
    '    changed = []',
    '    unchanged = []',
    '    warnings = []',
    '    def _v4(x):',
    '        c = getattr(unreal, "Vector4", None)',
    '        if c is None: return None',
    '        try: return c(x, x, x, 1.0)',
    '        except Exception: return None',
    '    if _wtemp is not None:',
    '        (changed if _pp_apply(s, _wtemp, "white_temp", "override_white_temp") else unchanged).append("white_temp")',
    '    if _wtint is not None:',
    '        (changed if _pp_apply(s, _wtint, "white_tint", "override_white_tint") else unchanged).append("white_tint")',
    '    for key, val in [("color_saturation", _sat), ("color_contrast", _con), ("color_gamma", _gam), ("color_gain", _gain)]:',
    '        if val is None: continue',
    '        v4 = _v4(val)',
    '        if v4 is None: warnings.append("Vector4 not exposed for " + key); unchanged.append(key); continue',
    '        (changed if _pp_apply(s, v4, key, "override_" + key) else unchanged).append(key)',
    '    _pp_write(ppv, s)',
    '    _emit({"ok": True, "volume": ppv.get_actor_label(), "changed_keys": changed,',
    '           "unchanged_keys": unchanged, "warnings": warnings})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const colorGradingSetDescriptor: PyToolDescriptor<typeof colorGradingSetSchema.shape> = {
  name: 'color_grading_set',
  description:
    'Set cinematic color grading on a PostProcessVolume — white-balance temp/tint and global saturation/contrast/gamma/gain (each a Vector4 with alpha=1) — with the correct bOverride_* flags and the struct written back. Set-to-value (retry-safe). UNCERTAIN-API: Vector4 absence degrades a field to a warning + unchanged_keys[].',
  cost: 'low',
  returns: '{ok, volume, changed_keys[], unchanged_keys[], warnings[]}',
  schema: colorGradingSetSchema.shape,
  meta: writeMeta,
  buildScript: colorGradingSetScript,
  timeoutMs: 30_000,
};

// ── fog_configure ─────────────────────────────────────────────────────────────
export const fogConfigureSchema = z.object({
  actor_id: z.string().optional().describe('ExponentialHeightFog actor label/path; omit to target the first fog actor in the level'),
  density: z.number().nonnegative().optional().describe('Fog density'),
  height_falloff: z.number().nonnegative().optional().describe('Fog height falloff'),
  start_distance: z.number().nonnegative().optional().describe('Fog start distance (world units)'),
  color: z.array(z.number()).length(3).optional().describe('[r,g,b] 0-1 fog inscattering color'),
  volumetric: z.boolean().optional().describe('Enable volumetric fog'),
});
export type FogConfigureParams = z.infer<typeof fogConfigureSchema>;

function fogConfigureScript(p: FogConfigureParams): string {
  return [
    PY_LIGHTING_HELPERS,
    `_ref = ${p.actor_id !== undefined ? pyStr(p.actor_id) : 'None'}`,
    `_density = ${numLit(p.density)}`,
    `_falloff = ${numLit(p.height_falloff)}`,
    `_start = ${numLit(p.start_distance)}`,
    `_color = ${p.color !== undefined ? JSON.stringify(p.color) : 'None'}`,
    `_vol = ${boolLit(p.volumetric)}`,
    'try:',
    '    if all(x is None for x in [_density,_falloff,_start,_color,_vol]):',
    '        raise Exception("provide at least one fog field")',
    '    fcls = getattr(unreal, "ExponentialHeightFog", None)',
    '    if fcls is None: raise Exception("ExponentialHeightFog not python-exposed")',
    '    fog = None',
    '    if _ref is not None: fog = _resolve_actor(_ref)',
    '    else:',
    '        for a in _all_actors():',
    '            try:',
    '                if isinstance(a, fcls): fog = a; break',
    '            except Exception: pass',
    '    if fog is None: raise Exception("no ExponentialHeightFog in level")',
    '    comp = None',
    '    ccls = getattr(unreal, "ExponentialHeightFogComponent", None)',
    '    if ccls is not None:',
    '        try:',
    '            comps = fog.get_components_by_class(ccls)',
    '            if comps: comp = comps[0]',
    '        except Exception: pass',
    '    # fallback to the actor itself when no component object is found is intentional and safe:',
    '    # UE forwards SetEditorProperty calls made on an actor to its root component',
    '    if comp is None: comp = _prop(fog, "component", "fog_component") or fog',
    '    changed = []',
    '    unchanged = []',
    '    def _apply(key, ok): (changed if ok else unchanged).append(key)',
    '    if _density is not None: _apply("fog_density", _set(comp, _density, "fog_density"))',
    '    if _falloff is not None: _apply("fog_height_falloff", _set(comp, _falloff, "fog_height_falloff"))',
    '    if _start is not None: _apply("start_distance", _set(comp, _start, "start_distance"))',
    '    if _color is not None:',
    '        lc = unreal.LinearColor(_color[0], _color[1], _color[2], 1.0)',
    '        _apply("fog_inscattering_color", _set(comp, lc, "fog_inscattering_color"))',
    '    if _vol is not None: _apply("volumetric_fog", _set(comp, _vol, "volumetric_fog"))',
    '    _emit({"ok": True, "actor_id": fog.get_actor_label(), "changed_keys": changed,',
    '           "unchanged_keys": unchanged})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const fogConfigureDescriptor: PyToolDescriptor<typeof fogConfigureSchema.shape> = {
  name: 'fog_configure',
  description:
    'Configure an ExponentialHeightFog actor — density, height falloff, start distance, inscattering color, volumetric-fog toggle — on its fog component. Set-to-value (retry-safe); omitted fields untouched. UNCERTAIN-API: component/property spellings are probed and land in unchanged_keys[].',
  cost: 'low',
  returns: '{ok, actor_id, changed_keys[], unchanged_keys[]}',
  schema: fogConfigureSchema.shape,
  meta: writeMeta,
  buildScript: fogConfigureScript,
  timeoutMs: 30_000,
};

// ── light_spawn ───────────────────────────────────────────────────────────────
export const lightSpawnSchema = z.object({
  light_type: z.enum(['directional', 'point', 'spot', 'rect', 'sky']).describe('Type of light actor to spawn'),
  location: z.array(z.number()).length(3).optional().describe('[x,y,z] spawn location (default [0,0,0])'),
  rotation: z.array(z.number()).length(3).optional().describe('[roll,pitch,yaw] spawn rotation (default [0,0,0])'),
  label: z.string().optional().describe('Optional actor label'),
  intensity: z.number().nonnegative().optional().describe('Optional initial intensity'),
  color: z.array(z.number()).length(3).optional().describe('Optional [r,g,b] 0-255 color'),
  temperature: z.number().positive().optional().describe('Optional color temperature in Kelvin'),
  mobility: z.enum(['static', 'stationary', 'movable']).optional().describe('Optional component mobility (default movable)'),
});
export type LightSpawnParams = z.infer<typeof lightSpawnSchema>;

function lightSpawnScript(p: LightSpawnParams): string {
  const loc = p.location ?? [0, 0, 0];
  const rot = p.rotation ?? [0, 0, 0];
  return [
    PY_LIGHTING_HELPERS,
    `_type = ${pyStr(p.light_type)}`,
    `_loc = ${JSON.stringify(loc)}`,
    `_rot = ${JSON.stringify(rot)}`,
    `_label = ${p.label !== undefined ? pyStr(p.label) : 'None'}`,
    `_intensity = ${numLit(p.intensity)}`,
    `_color = ${p.color !== undefined ? JSON.stringify(p.color) : 'None'}`,
    `_temp = ${numLit(p.temperature)}`,
    `_mobility = ${p.mobility !== undefined ? pyStr(p.mobility) : 'None'}`,
    'try:',
    '    _cls_name = {"directional": "DirectionalLight", "point": "PointLight", "spot": "SpotLight",',
    '                "rect": "RectLight", "sky": "SkyLight"}[_type]',
    '    cls = getattr(unreal, _cls_name, None)',
    '    if cls is None: raise Exception("%s not python-exposed" % _cls_name)',
    '    loc = unreal.Vector(_loc[0], _loc[1], _loc[2])',
    '    rot = unreal.Rotator(_rot[0], _rot[1], _rot[2])',
    '    actor = _eas().spawn_actor_from_class(cls, loc, rot)',
    '    if actor is None: raise Exception("spawn failed for %s" % _cls_name)',
    '    if _label is not None: actor.set_actor_label(_label)',
    '    comp = _light_comp(actor)',
    '    if comp is not None:',
    '        if _intensity is not None: _set(comp, _intensity, "intensity")',
    '        if _color is not None: _set(comp, _mk_color(_color), "light_color")',
    '        if _temp is not None:',
    '            _set(comp, _temp, "temperature"); _set(comp, True, "use_temperature")',
    '        if _mobility is not None:',
    '            _mm = {"static": "STATIC", "stationary": "STATIONARY", "movable": "MOVABLE"}[_mobility]',
    '            mob = getattr(unreal.ComponentMobility, _mm, None)',
    '            if mob is not None: _set(comp, mob, "mobility")',
    '    _emit({"ok": True, "actor_id": actor.get_actor_label(), "path": actor.get_path_name(),',
    '           "class": type(actor).__name__, "readback": (_light_read(comp) if comp is not None else None)})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const lightSpawnDescriptor: PyToolDescriptor<typeof lightSpawnSchema.shape> = {
  name: 'light_spawn',
  description:
    'Spawn a directional/point/spot/rect/sky light with optional intensity, color, temperature and mobility in one call — the primary way to lay down scene lighting. NON-IDEMPOTENT (actor-create). UNCERTAIN-API: the light actor class is probed and errors clearly when not python-exposed.',
  cost: 'medium',
  returns: '{ok, actor_id, path, class, readback}',
  schema: lightSpawnSchema.shape,
  meta: { ...writeMeta, cost: 'medium', effects: ['mutates_actor'] },
  buildScript: lightSpawnScript,
  timeoutMs: 30_000,
};

// ── postprocess_spawn_volume ──────────────────────────────────────────────────
export const postprocessSpawnVolumeSchema = z.object({
  location: z.array(z.number()).length(3).optional().describe('[x,y,z] spawn location (default [0,0,0])'),
  label: z.string().optional().describe('Optional actor label'),
  unbound: z.boolean().optional().default(true).describe('Unbound = affects the whole scene (global). false = box-bounded'),
  priority: z.number().optional().describe('Optional blend priority'),
  blend_weight: z.number().min(0).max(1).optional().describe('Optional blend weight (0..1)'),
});
export type PostprocessSpawnVolumeParams = z.infer<typeof postprocessSpawnVolumeSchema>;

function ppSpawnScript(p: PostprocessSpawnVolumeParams): string {
  const loc = p.location ?? [0, 0, 0];
  return [
    PY_LIGHTING_HELPERS,
    `_loc = ${JSON.stringify(loc)}`,
    `_label = ${p.label !== undefined ? pyStr(p.label) : 'None'}`,
    `_unbound = ${p.unbound ? 'True' : 'False'}`,
    `_priority = ${numLit(p.priority)}`,
    `_bw = ${numLit(p.blend_weight)}`,
    'try:',
    '    cls = getattr(unreal, "PostProcessVolume", None)',
    '    if cls is None: raise Exception("PostProcessVolume not python-exposed")',
    '    loc = unreal.Vector(_loc[0], _loc[1], _loc[2])',
    '    actor = _eas().spawn_actor_from_class(cls, loc, unreal.Rotator(0, 0, 0))',
    '    if actor is None: raise Exception("spawn failed for PostProcessVolume")',
    '    if _label is not None: actor.set_actor_label(_label)',
    '    _set(actor, _unbound, "unbound")',
    '    if _priority is not None: _set(actor, _priority, "priority")',
    '    if _bw is not None: _set(actor, _bw, "blend_weight")',
    '    _emit({"ok": True, "actor_id": actor.get_actor_label(), "path": actor.get_path_name(),',
    '           "unbound": _prop(actor, "unbound"), "priority": _prop(actor, "priority"),',
    '           "blend_weight": _prop(actor, "blend_weight")})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const postprocessSpawnVolumeDescriptor: PyToolDescriptor<typeof postprocessSpawnVolumeSchema.shape> = {
  name: 'postprocess_spawn_volume',
  description:
    'Spawn a PostProcessVolume (unbound/global by default, or box-bounded) with optional priority and blend-weight — the container every postprocess_set / exposure_set / lumen_configure / color_grading_set tweak targets. NON-IDEMPOTENT (actor-create). UNCERTAIN-API: PostProcessVolume class is probed and errors clearly when not python-exposed.',
  cost: 'medium',
  returns: '{ok, actor_id, path, unbound, priority, blend_weight}',
  schema: postprocessSpawnVolumeSchema.shape,
  meta: { ...writeMeta, cost: 'medium', effects: ['mutates_actor'] },
  buildScript: ppSpawnScript,
  timeoutMs: 30_000,
};

// ── sky_setup ─────────────────────────────────────────────────────────────────
export const skySetupSchema = z.object({
  sun_rotation: z.array(z.number()).length(3).optional().describe('[roll,pitch,yaw] of the sun DirectionalLight (default [0,-45,0])'),
  sun_intensity: z.number().nonnegative().optional().describe('Optional sun (directional light) intensity'),
  skylight_intensity: z.number().nonnegative().optional().describe('Optional SkyLight intensity'),
  label_prefix: z.string().optional().default('Sky').describe('Prefix for the spawned actor labels'),
});
export type SkySetupParams = z.infer<typeof skySetupSchema>;

function skySetupScript(p: SkySetupParams): string {
  const sunRot = p.sun_rotation ?? [0, -45, 0];
  return [
    PY_LIGHTING_HELPERS,
    `_sun_rot = ${JSON.stringify(sunRot)}`,
    `_sun_i = ${numLit(p.sun_intensity)}`,
    `_sky_i = ${numLit(p.skylight_intensity)}`,
    `_prefix = ${pyStr(p.label_prefix ?? 'Sky')}`,
    'try:',
    '    warnings = []',
    '    spawned = {}',
    '    def _spawn(cls_name, loc, rot, label):',
    '        cls = getattr(unreal, cls_name, None)',
    '        if cls is None: warnings.append("%s not python-exposed" % cls_name); return None',
    '        a = _eas().spawn_actor_from_class(cls, loc, rot)',
    '        if a is None: warnings.append("spawn failed for %s" % cls_name); return None',
    '        try: a.set_actor_label(label)',
    '        except Exception: pass',
    '        return a',
    '    z = unreal.Vector(0, 0, 0)',
    '    sun = _spawn("DirectionalLight", z, unreal.Rotator(_sun_rot[0], _sun_rot[1], _sun_rot[2]), _prefix + "_Sun")',
    '    if sun is not None:',
    '        spawned["sun"] = sun.get_actor_label()',
    '        if _sun_i is not None:',
    '            c = _light_comp(sun)',
    '            if c is not None: _set(c, _sun_i, "intensity")',
    '    skyl = _spawn("SkyLight", z, unreal.Rotator(0, 0, 0), _prefix + "_SkyLight")',
    '    if skyl is not None:',
    '        spawned["sky_light"] = skyl.get_actor_label()',
    '        if _sky_i is not None:',
    '            c = _light_comp(skyl)',
    '            if c is not None: _set(c, _sky_i, "intensity")',
    '    atm = _spawn("SkyAtmosphere", z, unreal.Rotator(0, 0, 0), _prefix + "_Atmosphere")',
    '    if atm is not None: spawned["sky_atmosphere"] = atm.get_actor_label()',
    '    _emit({"ok": True, "spawned": spawned, "warnings": warnings})',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const skySetupDescriptor: PyToolDescriptor<typeof skySetupSchema.shape> = {
  name: 'sky_setup',
  description:
    'Spawn a complete daytime sky triad — SkyAtmosphere + SkyLight + a directional-light Sun — with an optional sun angle/intensity and skylight intensity in one call. NON-IDEMPOTENT (spawns three actors; re-running adds duplicates). UNCERTAIN-API: each class is probed and a missing one degrades to a warning while the rest still spawn.',
  cost: 'medium',
  returns: '{ok, spawned:{sun,sky_light,sky_atmosphere}, warnings[]}',
  schema: skySetupSchema.shape,
  meta: { ...writeMeta, cost: 'medium', effects: ['mutates_actor'] },
  buildScript: skySetupScript,
  timeoutMs: 30_000,
};

// ── Aggregate: all lighting-domain PyToolDescriptors (spliced in index.ts) ──────
export const lightingPyDescriptors: PyToolDescriptor[] = [
  lightingCapabilityProbeDescriptor,
  lightListDescriptor,
  lightGetDescriptor,
  postprocessListVolumesDescriptor,
  postprocessGetDescriptor,
  lightSetDescriptor,
  postprocessSetDescriptor,
  exposureSetDescriptor,
  lumenConfigureDescriptor,
  colorGradingSetDescriptor,
  fogConfigureDescriptor,
  lightSpawnDescriptor,
  postprocessSpawnVolumeDescriptor,
  skySetupDescriptor,
] as unknown as PyToolDescriptor[];

/** Names of lighting-domain factory tools that are non-idempotent (actor-create /
 *  multi-actor spawn). Mirrors FOLIAGE_NON_IDEMPOTENT / LANDSCAPE_NON_IDEMPOTENT;
 *  added to tool-executor's NON_IDEMPOTENT set so the transport-retry gate skips
 *  them. */
export const LIGHTING_NON_IDEMPOTENT: readonly string[] = [
  lightSpawnDescriptor.name,
  postprocessSpawnVolumeDescriptor.name,
  skySetupDescriptor.name,
];
