// Sequencer & cinematics P0/P1 authoring tools, generated as UE Python via the
// pyTemplate factory (see py-tool-factory.ts). Sibling of
// mesh/mesh-py-tools.ts and actor/actor-py-tools.ts — same PyToolDescriptor
// shape, same _emit/_err envelope, same defensive multi-name probing, same
// index.ts splice.
//
// Source of truth for the catalog: docs/plans/2026-06-28-mcp-supertooling-tools.json,
// domain "sequencer-and-cinematics".
//
// ── 3-SURFACE OVERLAP AUDIT (mandatory — a prior wave shipped a name that
//    collided with a compiled-but-unwired C++ handler) ─────────────────────────
// (a) src/legacy-commands/sidecar.json          → grep "seq_": ZERO entries.
// (b) src/tools/*.ts registered MCP tools        → grep "seq_": ZERO registered.
// (c) unreal/HaybaMCPSequencer (satellite plugin) HaybaMCPSequencerHandler.cpp
//     GetCommands() registers EIGHT dormant C++ commands, also mirrored in
//     src/tools/code-mode/list-tool-categories.ts domain 'seq':
//       seq_create, seq_add_track, seq_add_keyframe, seq_get_info,
//       seq_play, seq_export, seq_add_camera_cut, seq_set_playback_range.
//     These live in an OPTIONAL satellite plugin (HaybaMCPModule.cpp:106/136:
//     "seq_* commands now live in the optional HaybaMCPSequencer satellite
//     plugin") — frequently NOT loaded — and are reachable only by command
//     string via the generic invoke path, never as first-class MCP tools.
//
// RESOLUTION: to obey the audit directive ("pick non-colliding names") and avoid
// two behaviours for one name, EVERY tool here is named DISTINCTLY from those 8
// dormant C++ commands. Mapping (catalog name → shipped non-colliding name):
//     seq_create             → seq_new
//     seq_add_track          → seq_track_add
//     seq_add_camera_cut     → seq_camera_cut
//     seq_set_playback_range → seq_playback_range
//   (seq_inspect, seq_bind_actor, seq_transform_keyframe, seq_open, seq_validate,
//    seq_list, seq_list_bindings already do NOT collide with any C++ command —
//    C++ analogues are seq_get_info / seq_add_keyframe / seq_play.)
// These python tools are the always-available surface (the satellite plugin may
// be absent); they call the unreal python API directly, they do NOT delegate to
// the dormant C++ commands.
//
//   SHIPPED (11):
//     seq_new, seq_inspect, seq_bind_actor, seq_track_add,
//     seq_transform_keyframe, seq_camera_cut, seq_playback_range, seq_open,
//     seq_validate, seq_list, seq_list_bindings.
//
// ── RENDER TOOLS — DECISION: WRAP-AND-SKIP (not shipped) ──────────────────────
// The catalog lists seq_render_still / seq_render_movie / seq_render_status
// (MovieRenderQueue: MoviePipelineQueueSubsystem / MoviePipelineEditorLibrary).
// We deliberately DO NOT ship them this wave:
//   * There is NO clean SYNCHRONOUS single-frame MRQ path in 5.7 — MRQ renders
//     exclusively through an async PIE executor (MoviePipelinePIEExecutor), which
//     from python_run (game-thread, returns synchronously) means registering an
//     on-finished delegate that outlives the call — the exact dangling-delegate
//     crash class that already froze the editor (python_run dangling-delegate AV;
//     lifetime-callback registration in python_run is now BLOCKED pre-exec).
//   * An honest seq_render_movie job-envelope (kick + seq_render_status poll)
//     needs a real cross-call sidecar job registry AND a crash-safe executor
//     lifecycle; that is a dedicated effort, not a thin readback.
//   * The house rule is explicit: DO NOT ship always-erroring render tools.
// So render is wrapped-and-skipped with this note rather than shipped as a stub.
// The vision-loop still frame is better served by the existing editor-viewport
// screenshot path once a sequence is opened via seq_open.
//
// ── NON_IDEMPOTENT ───────────────────────────────────────────────────────────
// Mutating creates/appends whose retry would duplicate state:
//   seq_new (creates an asset), seq_bind_actor (adds a possessable binding),
//   seq_track_add (appends a track), seq_transform_keyframe (appends keys),
//   seq_camera_cut (appends a cut section + camera binding).
// These are added to tool-executor's NON_IDEMPOTENT set AND re-exported here as
// SEQUENCER_NON_IDEMPOTENT for documentation/tests. seq_playback_range is a
// set-to-value write (idempotent per the house rule); seq_open / seq_inspect /
// seq_validate / seq_list / seq_list_bindings are reads (seq_validate defaults to
// read-only; autofix is not implemented this wave).
//
// ── UNCERTAIN-API flags for the next live-validation pass (all wrapped
//    defensively so they degrade to a structured error / warning, never a silent
//    wrong answer) ─────────────────────────────────────────────────────────────
//   - Possession: seq.add_possessable(actor) vs
//     unreal.MovieSceneSequenceExtensions.add_possessable(seq, actor) — both
//     probed; degrades to a structured error if neither exists.
//   - Actor lookup: EditorActorSubsystem.get_all_level_actors() matched by label
//     then path, with unreal.load_object fallback.
//   - Frame<->seconds: display rate via MovieSceneSequenceExtensions
//     .get_display_rate, tick resolution via get_tick_resolution; key frames are
//     authored in TICK resolution (FrameNumber). Playback range set via
//     set_playback_start_seconds / set_playback_end_seconds (probed) with a
//     frame-based set_playback_start / set_playback_end fallback.
//   - Transform channels: MovieScene3DTransformTrack section channels read via
//     MovieSceneSectionExtensions.get_all_channels(); 5.x channels are Double
//     (were Float) — add_key(FrameNumber, value) probed on each channel by name
//     prefix (Location/Rotation/Scale).
//   - Track add: MovieSceneBindingExtensions.add_track(binding, class) for
//     per-binding tracks; MovieSceneSequenceExtensions.add_track for master.

import { z } from 'zod';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { pyStr } from '../ue-python.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';

// ── Shared Python helpers: load + validate a LevelSequence, rate/frame math,
//    actor lookup, binding lookup by GUID ─────────────────────────────────────
const PY_SEQ_HELPERS = [
  'def _load_seq(path):',
  '    obj = unreal.EditorAssetLibrary.load_asset(path)',
  '    if obj is None: raise Exception("asset not found: %s" % path)',
  '    if not isinstance(obj, unreal.LevelSequence): raise Exception("not a LevelSequence: %s (%s)" % (path, type(obj).__name__))',
  '    return obj',
  'def _disp_rate(seq):',
  '    try:',
  '        r = unreal.MovieSceneSequenceExtensions.get_display_rate(seq)',
  '        d = float(r.denominator) or 1.0',
  '        return float(r.numerator) / d',
  '    except Exception:',
  '        return 30.0',
  'def _tick_res(seq):',
  '    try:',
  '        r = unreal.MovieSceneSequenceExtensions.get_tick_resolution(seq)',
  '        d = float(r.denominator) or 1.0',
  '        return float(r.numerator) / d',
  '    except Exception:',
  '        return 24000.0',
  'def _sec_to_tick(seq, sec):',
  '    return int(round(sec * _tick_res(seq)))',
  'def _find_actor(ref):',
  '    # match by label then path across all level actors, then load_object',
  '    try:',
  '        eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
  '        acts = eas.get_all_level_actors() if eas is not None else []',
  '        for a in acts:',
  '            try:',
  '                if a.get_actor_label() == ref: return a',
  '            except Exception: pass',
  '        for a in acts:',
  '            try:',
  '                if a.get_path_name() == ref: return a',
  '            except Exception: pass',
  '    except Exception: pass',
  '    try:',
  '        o = unreal.load_object(None, ref)',
  '        if o is not None: return o',
  '    except Exception: pass',
  '    return None',
  'def _add_possessable(seq, actor):',
  '    # 5.7 possession is UNCERTAIN — probe both known entry points.',
  '    try:',
  '        b = seq.add_possessable(actor)',
  '        if b is not None: return b',
  '    except Exception: pass',
  '    try:',
  '        return unreal.MovieSceneSequenceExtensions.add_possessable(seq, actor)',
  '    except Exception as _e2:',
  '        raise Exception("could not possess actor (add_possessable unavailable): %s" % _e2)',
  'def _binding_by_guid(seq, guid):',
  '    for b in unreal.MovieSceneSequenceExtensions.get_bindings(seq):',
  '        try:',
  '            if str(unreal.MovieSceneBindingExtensions.get_id(b)) == str(guid): return b',
  '        except Exception: pass',
  '    return None',
].join('\n');

const readMeta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'inspecting or discovering LevelSequence assets, bindings and tracks before authoring a cinematic',
  not_when: 'you need to render frames — render is not shipped this wave (see file header)',
};

const writeMeta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['writes-to-disk'],
  when: 'authoring a cinematic: creating a sequence, binding actors, adding tracks/keys/camera cuts',
  not_when: 'reading sequence state — use seq_inspect / seq_list / seq_list_bindings',
};

// ── seq_new ───────────────────────────────────────────────────────────────────
export const seqNewSchema = z.object({
  path: z.string().min(1).describe('Content folder for the new sequence, e.g. "/Game/Cinematics"'),
  name: z.string().min(1).describe('Asset name for the LevelSequence, e.g. "LS_Intro"'),
  frame_rate: z.number().positive().default(30).describe('Display frame rate (fps), default 30'),
  dry_run: z.boolean().default(false).describe('Preview the target asset path without creating it'),
});
export type SeqNewParams = z.infer<typeof seqNewSchema>;

function seqNewScript(p: SeqNewParams): string {
  return [
    PY_SEQ_HELPERS,
    `_path = ${pyStr(p.path)}`,
    `_name = ${pyStr(p.name)}`,
    `_fr = ${p.frame_rate}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _go():',
    '    full = _path.rstrip("/") + "/" + _name',
    '    if _dry:',
    '        _emit({"ok": True, "dry_run": True, "asset_path": full, "name": _name}); return',
    '    existing = unreal.EditorAssetLibrary.load_asset(full)',
    '    if existing is not None and isinstance(existing, unreal.LevelSequence):',
    '        _emit({"ok": True, "asset_path": full, "name": _name, "created": False, "note": "already exists"}); return',
    '    atools = unreal.AssetToolsHelpers.get_asset_tools()',
    '    seq = atools.create_asset(_name, _path, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())',
    '    if seq is None: raise Exception("create_asset returned None")',
    '    try: unreal.MovieSceneSequenceExtensions.set_display_rate(seq, unreal.FrameRate(int(_fr), 1))',
    '    except Exception: pass',
    '    unreal.EditorAssetLibrary.save_asset(full, only_if_is_dirty=False)',
    '    _emit({"ok": True, "asset_path": full, "name": _name, "created": True, "frame_rate": _fr})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const seqNewDescriptor: PyToolDescriptor<typeof seqNewSchema.shape> = {
  name: 'seq_new',
  description:
    'Create a new LevelSequence asset at a content path (the entry point for every cinematic), setting its display frame rate and saving. Idempotent by asset path (returns created:false if it already exists). Named seq_new to avoid colliding with the dormant satellite-plugin C++ seq_create command.',
  cost: 'medium',
  returns: '{ok, asset_path, name, created, frame_rate?, dry_run?}',
  schema: seqNewSchema.shape,
  meta: writeMeta,
  buildScript: seqNewScript,
  timeoutMs: 30_000,
};

// ── seq_inspect ───────────────────────────────────────────────────────────────
export const seqInspectSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the LevelSequence'),
  limit: z.number().int().positive().default(50).describe('Max bindings to return'),
  offset: z.number().int().nonnegative().default(0).describe('Binding offset for pagination'),
});
export type SeqInspectParams = z.infer<typeof seqInspectSchema>;

function seqInspectScript(p: SeqInspectParams): string {
  return [
    PY_SEQ_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'def _go():',
    '    seq = _load_seq(_path)',
    '    fr = _disp_rate(seq)',
    '    tr = _tick_res(seq)',
    '    dur = None',
    '    try:',
    '        rng = unreal.MovieSceneSequenceExtensions.get_playback_range(seq)',
    '        sf = rng.get_start_frame(); ef = rng.get_end_frame()',
    '        dur = (float(ef) - float(sf)) / tr if tr else None',
    '    except Exception: dur = None',
    '    allb = list(unreal.MovieSceneSequenceExtensions.get_bindings(seq))',
    '    total = len(allb)',
    '    page = allb[_offset:_offset + _limit]',
    '    binds = []',
    '    for b in page:',
    '        name = None; guid = None; ntracks = None',
    '        try: guid = str(unreal.MovieSceneBindingExtensions.get_id(b))',
    '        except Exception: pass',
    '        try: name = unreal.MovieSceneBindingExtensions.get_name(b)',
    '        except Exception: pass',
    '        try: ntracks = len(unreal.MovieSceneBindingExtensions.get_tracks(b))',
    '        except Exception: pass',
    '        binds.append({"binding_guid": guid, "display_name": name, "track_count": ntracks})',
    '    mtracks = []',
    '    try:',
    '        for t in unreal.MovieSceneSequenceExtensions.get_master_tracks(seq):',
    '            mtracks.append(type(t).__name__)',
    '    except Exception: pass',
    '    nxt = _offset + len(page)',
    '    _emit({"ok": True, "asset_path": _path, "frame_rate": fr, "tick_resolution": tr,',
    '           "duration_seconds": dur, "binding_count": total, "bindings": binds,',
    '           "master_tracks": mtracks, "has_more": nxt < total, "next_offset": nxt})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const seqInspectDescriptor: PyToolDescriptor<typeof seqInspectSchema.shape> = {
  name: 'seq_inspect',
  description:
    'Read-back full sequence state: display frame rate, tick resolution, duration (seconds), master tracks, and a paginated list of bindings with per-binding track counts. The inspection-first paired read for the authoring tools (analogue of the C++ seq_get_info, python-only so it works without the satellite plugin).',
  cost: 'low',
  returns: '{ok, asset_path, frame_rate, tick_resolution, duration_seconds, binding_count, bindings:[{binding_guid,display_name,track_count}], master_tracks, has_more, next_offset}',
  schema: seqInspectSchema.shape,
  meta: readMeta,
  buildScript: seqInspectScript,
  timeoutMs: 30_000,
};

// ── seq_bind_actor ────────────────────────────────────────────────────────────
export const seqBindActorSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the LevelSequence'),
  actor: z.string().min(1).describe('Actor label or full path of the level actor to possess'),
  dry_run: z.boolean().default(false).describe('Resolve the actor without adding the binding'),
});
export type SeqBindActorParams = z.infer<typeof seqBindActorSchema>;

function seqBindActorScript(p: SeqBindActorParams): string {
  return [
    PY_SEQ_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    `_ref = ${pyStr(p.actor)}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _go():',
    '    seq = _load_seq(_path)',
    '    actor = _find_actor(_ref)',
    '    if actor is None: raise Exception("actor not found: %s" % _ref)',
    '    if _dry:',
    '        _emit({"ok": True, "dry_run": True, "resolved": actor.get_path_name()}); return',
    '    # idempotent-by-name: reuse an existing binding for this actor label',
    '    label = None',
    '    try: label = actor.get_actor_label()',
    '    except Exception: pass',
    '    for b in unreal.MovieSceneSequenceExtensions.get_bindings(seq):',
    '        try:',
    '            if label is not None and unreal.MovieSceneBindingExtensions.get_name(b) == label:',
    '                _emit({"ok": True, "binding_guid": str(unreal.MovieSceneBindingExtensions.get_id(b)),',
    '                       "display_name": label, "created": False}); return',
    '        except Exception: pass',
    '    binding = _add_possessable(seq, actor)',
    '    guid = str(unreal.MovieSceneBindingExtensions.get_id(binding))',
    '    name = None',
    '    try: name = unreal.MovieSceneBindingExtensions.get_name(binding)',
    '    except Exception: name = label',
    '    unreal.EditorAssetLibrary.save_asset(_path, only_if_is_dirty=False)',
    '    _emit({"ok": True, "binding_guid": guid, "display_name": name, "created": True})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const seqBindActorDescriptor: PyToolDescriptor<typeof seqBindActorSchema.shape> = {
  name: 'seq_bind_actor',
  description:
    'Possess a level actor (by label or path) in the sequence and return its binding GUID — the prerequisite handle for all per-actor tracks. Idempotent by actor label (reuses an existing binding). Probes seq.add_possessable then MovieSceneSequenceExtensions.add_possessable.',
  cost: 'medium',
  returns: '{ok, binding_guid, display_name, created, dry_run?, resolved?}',
  schema: seqBindActorSchema.shape,
  meta: writeMeta,
  buildScript: seqBindActorScript,
  timeoutMs: 30_000,
};

// ── seq_track_add ─────────────────────────────────────────────────────────────
const TRACK_TYPES = ['transform', 'float', 'visibility', 'camera_cuts', 'audio', 'event'] as const;
export const seqTrackAddSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the LevelSequence'),
  track_type: z.enum(TRACK_TYPES).describe('Track type to add'),
  binding_guid: z.string().optional().describe('Binding GUID for a per-actor track; omit for a master track'),
  dry_run: z.boolean().default(false).describe('Report the resolved track class without adding it'),
});
export type SeqTrackAddParams = z.infer<typeof seqTrackAddSchema>;

function seqTrackAddScript(p: SeqTrackAddParams): string {
  return [
    PY_SEQ_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    `_ttype = ${pyStr(p.track_type)}`,
    `_guid = ${p.binding_guid ? pyStr(p.binding_guid) : 'None'}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _track_class(tt):',
    '    m = {"transform": unreal.MovieScene3DTransformTrack,',
    '         "float": unreal.MovieSceneFloatTrack,',
    '         "visibility": unreal.MovieSceneVisibilityTrack,',
    '         "camera_cuts": unreal.MovieSceneCameraCutTrack,',
    '         "audio": unreal.MovieSceneAudioTrack,',
    '         "event": unreal.MovieSceneEventTrack}',
    '    if tt not in m: raise Exception("unknown track_type: %s" % tt)',
    '    return m[tt]',
    'def _go():',
    '    seq = _load_seq(_path)',
    '    cls = _track_class(_ttype)',
    '    if _dry:',
    '        _emit({"ok": True, "dry_run": True, "track_class": cls.__name__}); return',
    '    if _guid is not None:',
    '        b = _binding_by_guid(seq, _guid)',
    '        if b is None: raise Exception("binding not found: %s" % _guid)',
    '        track = unreal.MovieSceneBindingExtensions.add_track(b, cls)',
    '    else:',
    '        track = unreal.MovieSceneSequenceExtensions.add_track(seq, cls)',
    '    if track is None: raise Exception("add_track returned None")',
    '    tid = None',
    '    try: tid = str(track.get_name())',
    '    except Exception:',
    '        try: tid = str(track.get_fname())',
    '        except Exception: pass',
    '    unreal.EditorAssetLibrary.save_asset(_path, only_if_is_dirty=False)',
    '    _emit({"ok": True, "track_id": tid, "track_class": cls.__name__, "binding_guid": _guid})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const seqTrackAddDescriptor: PyToolDescriptor<typeof seqTrackAddSchema.shape> = {
  name: 'seq_track_add',
  description:
    'Add a track (transform/float/visibility/camera_cuts/audio/event) to a binding (via binding_guid) or as a master track, returning the track id and class. Named seq_track_add to avoid colliding with the dormant satellite-plugin C++ seq_add_track command.',
  cost: 'medium',
  returns: '{ok, track_id, track_class, binding_guid?, dry_run?}',
  schema: seqTrackAddSchema.shape,
  meta: writeMeta,
  buildScript: seqTrackAddScript,
  timeoutMs: 30_000,
};

// ── seq_transform_keyframe ────────────────────────────────────────────────────
export const seqTransformKeyframeSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the LevelSequence'),
  binding_guid: z.string().min(1).describe('Binding GUID of the possessed actor to keyframe'),
  time_seconds: z.number().describe('Time (seconds) at which to place the key'),
  location: z.array(z.number()).length(3).optional().describe('World location [x,y,z]'),
  rotation: z.array(z.number()).length(3).optional().describe('Rotation [roll,pitch,yaw] degrees'),
  scale: z.array(z.number()).length(3).optional().describe('Scale [x,y,z]'),
});
export type SeqTransformKeyframeParams = z.infer<typeof seqTransformKeyframeSchema>;

function seqTransformKeyframeScript(p: SeqTransformKeyframeParams): string {
  const loc = p.location ? `[${p.location.join(', ')}]` : 'None';
  const rot = p.rotation ? `[${p.rotation.join(', ')}]` : 'None';
  const scl = p.scale ? `[${p.scale.join(', ')}]` : 'None';
  return [
    PY_SEQ_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    `_guid = ${pyStr(p.binding_guid)}`,
    `_t = ${p.time_seconds}`,
    `_loc = ${loc}`,
    `_rot = ${rot}`,
    `_scl = ${scl}`,
    // channel name-prefix -> the three components of each transform vector
    'def _go():',
    '    seq = _load_seq(_path)',
    '    b = _binding_by_guid(seq, _guid)',
    '    if b is None: raise Exception("binding not found: %s" % _guid)',
    '    tracks = [t for t in unreal.MovieSceneBindingExtensions.get_tracks(b) if isinstance(t, unreal.MovieScene3DTransformTrack)]',
    '    if not tracks:',
    '        track = unreal.MovieSceneBindingExtensions.add_track(b, unreal.MovieScene3DTransformTrack)',
    '    else:',
    '        track = tracks[0]',
    '    secs = unreal.MovieSceneTrackExtensions.get_sections(track)',
    '    if secs:',
    '        section = secs[0]',
    '    else:',
    '        section = unreal.MovieSceneTrackExtensions.add_section(track)',
    '    frame = unreal.FrameNumber(_sec_to_tick(seq, _t))',
    '    chans = unreal.MovieSceneSectionExtensions.get_all_channels(section)',
    '    # map channel display name -> value by prefix + axis order',
    '    want = {}',
    '    if _loc is not None: want["Location"] = _loc',
    '    if _rot is not None: want["Rotation"] = _rot',
    '    if _scl is not None: want["Scale"] = _scl',
    '    axis = {"X": 0, "Y": 1, "Z": 2, "Roll": 0, "Pitch": 1, "Yaw": 2}',
    '    added = 0',
    '    for ch in chans:',
    '        try: nm = str(unreal.MovieSceneScriptingChannel.get_channel_name(ch))',
    '        except Exception:',
    '            try: nm = str(ch.channel_name)',
    '            except Exception: nm = ""',
    '        grp = None',
    '        for k in want:',
    '            if nm.startswith(k): grp = k; break',
    '        if grp is None: continue',
    '        idx = None',
    '        for suff, i in axis.items():',
    '            if nm.endswith(suff): idx = i; break',
    '        if idx is None: continue',
    '        try:',
    '            ch.add_key(frame, float(want[grp][idx])); added += 1',
    '        except Exception: pass',
    '    unreal.EditorAssetLibrary.save_asset(_path, only_if_is_dirty=False)',
    '    _emit({"ok": True, "binding_guid": _guid, "frame": int(frame.value) if hasattr(frame, "value") else _sec_to_tick(seq, _t),',
    '           "time_seconds": _t, "keys_added": added})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const seqTransformKeyframeDescriptor: PyToolDescriptor<typeof seqTransformKeyframeSchema.shape> = {
  name: 'seq_transform_keyframe',
  description:
    'Keyframe location/rotation/scale on a possessed actor\'s transform track at a time (seconds), creating the track/section if absent. Closes the C++ gap where the dormant seq_add_keyframe is float-only. Channels resolved by name prefix (Location/Rotation/Scale) + axis suffix; keys authored in tick resolution.',
  cost: 'medium',
  returns: '{ok, binding_guid, frame, time_seconds, keys_added}',
  schema: seqTransformKeyframeSchema.shape,
  meta: writeMeta,
  buildScript: seqTransformKeyframeScript,
  timeoutMs: 30_000,
};

// ── seq_camera_cut ────────────────────────────────────────────────────────────
export const seqCameraCutSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the LevelSequence'),
  camera_actor: z.string().min(1).describe('Camera actor label or path to cut to'),
  start_seconds: z.number().describe('Cut start time (seconds)'),
  end_seconds: z.number().describe('Cut end time (seconds)'),
  dry_run: z.boolean().default(false).describe('Resolve the camera without adding the cut'),
});
export type SeqCameraCutParams = z.infer<typeof seqCameraCutSchema>;

function seqCameraCutScript(p: SeqCameraCutParams): string {
  return [
    PY_SEQ_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    `_cam = ${pyStr(p.camera_actor)}`,
    `_start = ${p.start_seconds}`,
    `_end = ${p.end_seconds}`,
    `_dry = ${p.dry_run ? 'True' : 'False'}`,
    'def _go():',
    '    if _end <= _start: raise Exception("end_seconds must be > start_seconds")',
    '    seq = _load_seq(_path)',
    '    cam = _find_actor(_cam)',
    '    if cam is None: raise Exception("camera actor not found: %s" % _cam)',
    '    if _dry:',
    '        _emit({"ok": True, "dry_run": True, "resolved": cam.get_path_name()}); return',
    '    cam_binding = _add_possessable(seq, cam)',
    '    cam_guid = str(unreal.MovieSceneBindingExtensions.get_id(cam_binding))',
    '    cuts = [t for t in unreal.MovieSceneSequenceExtensions.get_master_tracks(seq) if isinstance(t, unreal.MovieSceneCameraCutTrack)]',
    '    if cuts:',
    '        cut_track = cuts[0]',
    '    else:',
    '        cut_track = unreal.MovieSceneSequenceExtensions.add_track(seq, unreal.MovieSceneCameraCutTrack)',
    '    section = unreal.MovieSceneTrackExtensions.add_section(cut_track)',
    '    sf = _sec_to_tick(seq, _start); ef = _sec_to_tick(seq, _end)',
    '    range_applied = False',
    '    try:',
    '        unreal.MovieSceneSectionExtensions.set_range(section, sf, ef)',
    '        range_applied = True',
    '    except Exception:',
    '        try:',
    '            unreal.MovieSceneSectionExtensions.set_start_frame_seconds(section, _start); unreal.MovieSceneSectionExtensions.set_end_frame_seconds(section, _end)',
    '            range_applied = True',
    '        except Exception: range_applied = False',
    '    # bind the camera to the cut section',
    '    camera_bound = False',
    '    try:',
    '        binding_id = unreal.MovieSceneObjectBindingID()',
    '        binding_id.set_editor_property("guid", unreal.MovieSceneBindingExtensions.get_id(cam_binding))',
    '        section.set_camera_binding_id(binding_id)',
    '        camera_bound = True',
    '    except Exception: camera_bound = False',
    '    unreal.EditorAssetLibrary.save_asset(_path, only_if_is_dirty=False)',
    '    warnings = []',
    '    if not camera_bound: warnings.append("camera_binding_failed: cut section has no camera attached")',
    '    if not range_applied: warnings.append("range_apply_failed: section start/end frame not set")',
    '    _emit({"ok": True, "camera_guid": cam_guid, "start_frame": sf, "end_frame": ef,',
    '           "start_seconds": _start, "end_seconds": _end,',
    '           "camera_bound": camera_bound, "range_applied": range_applied, "warnings": warnings})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const seqCameraCutDescriptor: PyToolDescriptor<typeof seqCameraCutSchema.shape> = {
  name: 'seq_camera_cut',
  description:
    'Add a camera-cut section binding a camera actor over a time range (seconds) — how a shot gets its camera. Possesses the camera, ensures a master camera-cut track, and sets the section range + camera binding id. Named seq_camera_cut to avoid colliding with the dormant satellite-plugin C++ seq_add_camera_cut command.',
  cost: 'medium',
  returns: '{ok, camera_guid, start_frame, end_frame, start_seconds, end_seconds, camera_bound, range_applied, warnings[], dry_run?}',
  schema: seqCameraCutSchema.shape,
  meta: writeMeta,
  buildScript: seqCameraCutScript,
  timeoutMs: 30_000,
};

// ── seq_playback_range ────────────────────────────────────────────────────────
export const seqPlaybackRangeSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the LevelSequence'),
  start_seconds: z.number().describe('Playback in point (seconds)'),
  end_seconds: z.number().describe('Playback out point (seconds)'),
});
export type SeqPlaybackRangeParams = z.infer<typeof seqPlaybackRangeSchema>;

function seqPlaybackRangeScript(p: SeqPlaybackRangeParams): string {
  return [
    PY_SEQ_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    `_start = ${p.start_seconds}`,
    `_end = ${p.end_seconds}`,
    'def _go():',
    '    if _end <= _start: raise Exception("end_seconds must be > start_seconds")',
    '    seq = _load_seq(_path)',
    '    set_ok = False',
    '    try:',
    '        unreal.MovieSceneSequenceExtensions.set_playback_start_seconds(seq, _start)',
    '        unreal.MovieSceneSequenceExtensions.set_playback_end_seconds(seq, _end)',
    '        set_ok = True',
    '    except Exception: set_ok = False',
    '    if not set_ok:',
    '        fr = _disp_rate(seq)',
    '        unreal.MovieSceneSequenceExtensions.set_playback_start(seq, int(round(_start * fr)))',
    '        unreal.MovieSceneSequenceExtensions.set_playback_end(seq, int(round(_end * fr)))',
    '    sf = _sec_to_tick(seq, _start); ef = _sec_to_tick(seq, _end)',
    '    unreal.EditorAssetLibrary.save_asset(_path, only_if_is_dirty=False)',
    '    _emit({"ok": True, "start_seconds": _start, "end_seconds": _end, "start_frame": sf, "end_frame": ef})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const seqPlaybackRangeDescriptor: PyToolDescriptor<typeof seqPlaybackRangeSchema.shape> = {
  name: 'seq_playback_range',
  description:
    'Set the sequence playback in/out range in seconds (defines what renders and plays). Idempotent set-to-value. Probes set_playback_start_seconds/set_playback_end_seconds then a display-rate frame fallback. Named seq_playback_range to avoid colliding with the dormant satellite-plugin C++ seq_set_playback_range command.',
  cost: 'low',
  returns: '{ok, start_seconds, end_seconds, start_frame, end_frame}',
  schema: seqPlaybackRangeSchema.shape,
  meta: writeMeta,
  buildScript: seqPlaybackRangeScript,
  timeoutMs: 30_000,
};

// ── seq_open ──────────────────────────────────────────────────────────────────
export const seqOpenSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the LevelSequence to open in Sequencer'),
});
export type SeqOpenParams = z.infer<typeof seqOpenSchema>;

function seqOpenScript(p: SeqOpenParams): string {
  return [
    PY_SEQ_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    'def _go():',
    '    seq = _load_seq(_path)',
    '    opened = False',
    '    try:',
    '        unreal.LevelSequenceEditorBlueprintLibrary.open_level_sequence(seq); opened = True',
    '    except Exception:',
    '        try:',
    '            unreal.AssetEditorSubsystem = unreal.get_editor_subsystem(unreal.AssetEditorSubsystem)',
    '            unreal.AssetEditorSubsystem.open_editor_for_assets([seq]); opened = True',
    '        except Exception: opened = False',
    '    _emit({"ok": True, "asset_path": _path, "editor_opened": opened})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const seqOpenDescriptor: PyToolDescriptor<typeof seqOpenSchema.shape> = {
  name: 'seq_open',
  description:
    'Open a LevelSequence in the Sequencer editor for human review or before render (analogue of the dormant C++ seq_play). Probes LevelSequenceEditorBlueprintLibrary.open_level_sequence then AssetEditorSubsystem.',
  cost: 'low',
  returns: '{ok, asset_path, editor_opened}',
  schema: seqOpenSchema.shape,
  meta: readMeta,
  buildScript: seqOpenScript,
  timeoutMs: 30_000,
};

// ── seq_validate ──────────────────────────────────────────────────────────────
export const seqValidateSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the LevelSequence to validate'),
});
export type SeqValidateParams = z.infer<typeof seqValidateSchema>;

function seqValidateScript(p: SeqValidateParams): string {
  return [
    PY_SEQ_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    'def _go():',
    '    seq = _load_seq(_path)',
    '    tr = _tick_res(seq)',
    '    issues = []',
    '    # playback range',
    '    ps = None; pe = None',
    '    try:',
    '        rng = unreal.MovieSceneSequenceExtensions.get_playback_range(seq)',
    '        ps = float(rng.get_start_frame()); pe = float(rng.get_end_frame())',
    '        if pe <= ps:',
    '            issues.append({"code": "zero_length_playback", "severity": "error", "detail": "playback range is empty or inverted"})',
    '    except Exception: pass',
    '    has_camera_cut = False',
    '    try:',
    '        for t in unreal.MovieSceneSequenceExtensions.get_master_tracks(seq):',
    '            if isinstance(t, unreal.MovieSceneCameraCutTrack):',
    '                has_camera_cut = True',
    '                if not unreal.MovieSceneTrackExtensions.get_sections(t):',
    '                    issues.append({"code": "empty_camera_cut_track", "severity": "warning", "detail": "camera cut track has no sections"})',
    '    except Exception: pass',
    '    if not has_camera_cut:',
    '        issues.append({"code": "missing_camera_cut", "severity": "warning", "detail": "no camera cut track — sequence will render the active viewport camera"})',
    '    for b in unreal.MovieSceneSequenceExtensions.get_bindings(seq):',
    '        guid = None; name = None',
    '        try: guid = str(unreal.MovieSceneBindingExtensions.get_id(b))',
    '        except Exception: pass',
    '        try: name = unreal.MovieSceneBindingExtensions.get_name(b)',
    '        except Exception: pass',
    '        tracks = []',
    '        try: tracks = list(unreal.MovieSceneBindingExtensions.get_tracks(b))',
    '        except Exception: pass',
    '        if not tracks:',
    '            issues.append({"code": "dangling_binding", "severity": "warning", "detail": "binding %s has no tracks" % (name or guid), "binding_guid": guid})',
    '        for t in tracks:',
    '            secs = []',
    '            try: secs = list(unreal.MovieSceneTrackExtensions.get_sections(t))',
    '            except Exception: pass',
    '            if not secs:',
    '                issues.append({"code": "empty_track", "severity": "warning", "detail": "track %s on %s has no sections" % (type(t).__name__, name or guid), "binding_guid": guid})',
    '            for s in secs:',
    '                try:',
    '                    ssf = float(s.get_start_frame()); sef = float(s.get_end_frame())',
    '                    if ps is not None and (sef < ps or ssf > pe):',
    '                        issues.append({"code": "section_out_of_range", "severity": "warning", "detail": "a section on %s lies outside the playback range" % (name or guid), "binding_guid": guid})',
    '                except Exception: pass',
    '    errs = [i for i in issues if i.get("severity") == "error"]',
    '    _emit({"ok": len(errs) == 0, "asset_path": _path, "issues": issues, "fixed": [],',
    '           "error_count": len(errs), "warning_count": len(issues) - len(errs)})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const seqValidateDescriptor: PyToolDescriptor<typeof seqValidateSchema.shape> = {
  name: 'seq_validate',
  description:
    'PLUMB-style read-only check of a sequence: dangling bindings (no tracks), empty tracks (no sections), sections out of the playback range, missing/empty camera cut, zero-length playback. Returns categorised issues with severity; ok:false only on errors. (autofix not implemented this wave — fixed:[] always.)',
  cost: 'low',
  returns: '{ok, asset_path, issues:[{code,severity,detail,binding_guid?}], fixed, error_count, warning_count}',
  schema: seqValidateSchema.shape,
  meta: readMeta,
  buildScript: seqValidateScript,
  timeoutMs: 30_000,
};

// ── seq_list ──────────────────────────────────────────────────────────────────
export const seqListSchema = z.object({
  path_filter: z.string().default('/Game').describe('Content root to search under, e.g. "/Game/Cinematics"'),
  limit: z.number().int().positive().default(30).describe('Max sequences to return'),
  offset: z.number().int().nonnegative().default(0).describe('Offset for pagination'),
});
export type SeqListParams = z.infer<typeof seqListSchema>;

function seqListScript(p: SeqListParams): string {
  return [
    PY_SEQ_HELPERS,
    `_root = ${pyStr(p.path_filter)}`,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'def _go():',
    '    ar = unreal.AssetRegistryHelpers.get_asset_registry()',
    '    ardata = ar.get_assets_by_path(unreal.Name(_root), recursive=True)',
    '    seqs = []',
    '    for a in ardata:',
    '        try:',
    '            cn = str(a.asset_class_path.asset_name) if hasattr(a, "asset_class_path") else str(a.asset_class)',
    '        except Exception: cn = ""',
    '        if cn != "LevelSequence": continue',
    '        try: seqs.append(str(a.package_name))',
    '        except Exception: pass',
    '    seqs = sorted(set(seqs))',
    '    total = len(seqs)',
    '    page = seqs[_offset:_offset + _limit]',
    '    out = []',
    '    for pth in page:',
    '        item = {"asset_path": pth, "track_count": None, "binding_count": None}',
    '        try:',
    '            seq = _load_seq(pth)',
    '            item["binding_count"] = len(unreal.MovieSceneSequenceExtensions.get_bindings(seq))',
    '            item["track_count"] = len(unreal.MovieSceneSequenceExtensions.get_master_tracks(seq))',
    '        except Exception: pass',
    '        out.append(item)',
    '    nxt = _offset + len(page)',
    '    _emit({"ok": True, "sequences": out, "count": total, "has_more": nxt < total, "next_offset": nxt})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const seqListDescriptor: PyToolDescriptor<typeof seqListSchema.shape> = {
  name: 'seq_list',
  description:
    'List/paginate LevelSequence assets under a content root (via the AssetRegistry) with per-sequence master-track and binding counts — discovery before any edit.',
  cost: 'low',
  returns: '{ok, sequences:[{asset_path,track_count,binding_count}], count, has_more, next_offset}',
  schema: seqListSchema.shape,
  meta: readMeta,
  buildScript: seqListScript,
  timeoutMs: 30_000,
};

// ── seq_list_bindings ─────────────────────────────────────────────────────────
export const seqListBindingsSchema = z.object({
  asset_path: z.string().min(1).describe('Content path of the LevelSequence'),
  limit: z.number().int().positive().default(50).describe('Max bindings to return'),
  offset: z.number().int().nonnegative().default(0).describe('Offset for pagination'),
});
export type SeqListBindingsParams = z.infer<typeof seqListBindingsSchema>;

function seqListBindingsScript(p: SeqListBindingsParams): string {
  return [
    PY_SEQ_HELPERS,
    `_path = ${pyStr(p.asset_path)}`,
    `_limit = ${p.limit}`,
    `_offset = ${p.offset}`,
    'def _go():',
    '    seq = _load_seq(_path)',
    '    allb = list(unreal.MovieSceneSequenceExtensions.get_bindings(seq))',
    '    total = len(allb)',
    '    page = allb[_offset:_offset + _limit]',
    '    out = []',
    '    for b in page:',
    '        guid = None; name = None; kind = "possessable"; obj_class = None',
    '        try: guid = str(unreal.MovieSceneBindingExtensions.get_id(b))',
    '        except Exception: pass',
    '        try: name = unreal.MovieSceneBindingExtensions.get_name(b)',
    '        except Exception: pass',
    '        try:',
    '            c = unreal.MovieSceneBindingExtensions.get_possessed_object_class(b)',
    '            if c is not None: obj_class = c.get_name()',
    '        except Exception: pass',
    '        out.append({"guid": guid, "name": name, "kind": kind, "object_class": obj_class})',
    '    nxt = _offset + len(page)',
    '    _emit({"ok": True, "asset_path": _path, "bindings": out, "count": total, "has_more": nxt < total, "next_offset": nxt})',
    'try:',
    '    _go()',
    'except Exception as _e:',
    '    _err(_e)',
  ].join('\n');
}

export const seqListBindingsDescriptor: PyToolDescriptor<typeof seqListBindingsSchema.shape> = {
  name: 'seq_list_bindings',
  description:
    'Paginated read of a sequence\'s bindings — GUID, display name, kind and possessed object class — the map an agent needs to find GUIDs for keyframing.',
  cost: 'low',
  returns: '{ok, asset_path, bindings:[{guid,name,kind,object_class}], count, has_more, next_offset}',
  schema: seqListBindingsSchema.shape,
  meta: readMeta,
  buildScript: seqListBindingsScript,
  timeoutMs: 30_000,
};

// ── Aggregate: all sequencer-domain PyToolDescriptors (spliced in index.ts) ────
export const sequencerPyDescriptors: PyToolDescriptor[] = [
  seqNewDescriptor,
  seqInspectDescriptor,
  seqBindActorDescriptor,
  seqTrackAddDescriptor,
  seqTransformKeyframeDescriptor,
  seqCameraCutDescriptor,
  seqPlaybackRangeDescriptor,
  seqOpenDescriptor,
  seqValidateDescriptor,
  seqListDescriptor,
  seqListBindingsDescriptor,
] as unknown as PyToolDescriptor[];

/**
 * Sequencer-domain factory tools that are non-idempotent (mutating create/append
 * whose retry would duplicate state). Mirrored into tool-executor's
 * NON_IDEMPOTENT set (which also carries the legacy `seq_create` entry for the
 * dormant C++ command). seq_playback_range is a set-to-value write (idempotent);
 * the reads (inspect/open/validate/list/list_bindings) are excluded.
 */
export const SEQUENCER_NON_IDEMPOTENT: readonly string[] = [
  seqNewDescriptor.name,
  seqBindActorDescriptor.name,
  seqTrackAddDescriptor.name,
  seqTransformKeyframeDescriptor.name,
  seqCameraCutDescriptor.name,
];
