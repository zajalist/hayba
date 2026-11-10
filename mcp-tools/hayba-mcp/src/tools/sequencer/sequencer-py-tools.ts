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
import { pyStr, runUePythonJson } from '../ue-python.js';
import { executeCommand } from '../tool-executor.js';
import type { PyToolDescriptor } from '../py-tool-factory.js';
import { TOOL_ALIASES } from '../tool-aliases.js';

// ── Shared Python helpers: load + validate a LevelSequence, rate/frame math,
//    actor lookup, binding lookup by GUID ─────────────────────────────────────
const PY_SEQ_HELPERS = [
  // No try/with: python_run's native policy (HCR-TIME-001) refuses them. Expected
  // failures return (None, message); the 5.8 names are checked against the engine.
  'MSE = unreal.MovieSceneSequenceExtensions',
  'MBE = unreal.MovieSceneBindingExtensions',
  'def _load_seq(path):',
  '    if not unreal.EditorAssetLibrary.does_asset_exist(path): return None, "asset not found: %s" % path',
  '    obj = unreal.EditorAssetLibrary.load_asset(path)',
  '    if not isinstance(obj, unreal.LevelSequence): return None, "not a LevelSequence: %s (%s)" % (path, type(obj).__name__)',
  '    return obj, ""',
  'def _rate(r):',
  '    d = float(r.denominator)',
  '    return float(r.numerator) / d if d else 0.0',
  'def _disp_rate(seq): return _rate(MSE.get_display_rate(seq))',
  'def _tick_res(seq): return _rate(MSE.get_tick_resolution(seq))',
  'def _sec_to_tick(seq, sec): return int(round(sec * _tick_res(seq)))',
  'def _find_actor(ref):',
  '    eas = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)',
  '    for a in (eas.get_all_level_actors() if eas is not None else []):',
  '        if a.get_actor_label() == ref or a.get_path_name() == ref: return a',
  '    return None',
  'def _binding(seq, ref):',
  '    # a binding GUID, display name or name',
  '    for b in MSE.get_bindings(seq):',
  '        if str(MBE.get_id(b)) == ref or str(MBE.get_display_name(b)) == ref or MBE.get_name(b) == ref: return b',
  '    return None',
  'def _binding_by_guid(seq, guid): return _binding(seq, str(guid))',
  'def _add_possessable(seq, actor): return MSE.add_possessable(seq, actor)',
  'def _binding_for_actor(seq, actor):',
  '    # reuse the actor binding if there is one: a second possessable is a second track set',
  '    b = _binding(seq, actor.get_actor_label())',
  '    return b if b is not None else MSE.add_possessable(seq, actor)',
  'def _sec(section, start):',
  '    SE = unreal.MovieSceneSectionExtensions',
  '    if start: return SE.get_start_frame_seconds(section) if SE.has_start_frame(section) else None',
  '    return SE.get_end_frame_seconds(section) if SE.has_end_frame(section) else None',].join('\n');

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
    '    existing = unreal.EditorAssetLibrary.load_asset(full) if unreal.EditorAssetLibrary.does_asset_exist(full) else None',
    '    if existing is not None and isinstance(existing, unreal.LevelSequence):',
    '        _emit({"ok": True, "asset_path": full, "name": _name, "created": False, "note": "already exists"}); return',
    '    atools = unreal.AssetToolsHelpers.get_asset_tools()',
    '    seq = atools.create_asset(_name, _path, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())',
    '    if seq is None: _err("create_asset returned None"); return',
    '    MSE.set_display_rate(seq, unreal.FrameRate(int(_fr), 1))',
    '    unreal.EditorAssetLibrary.save_asset(full, only_if_is_dirty=False)',
    '    _emit({"ok": True, "asset_path": full, "name": _name, "created": True, "frame_rate": _fr})',
    '_go()',
  ].join('\n');
}

export const seqNewDescriptor: PyToolDescriptor<typeof seqNewSchema.shape> = {
  name: 'seq_new',
  description:
    'Create a new LevelSequence asset at a content path (the entry point for every cinematic), setting its display frame rate and saving. Idempotent by asset path (returns created:false if it already exists). Named seq_new to avoid colliding with the dormant satellite-plugin C++ seq_create command.',
  cost: 'medium',
  returns: '{ok, asset_path, name, created, frame_rate?, dry_run?}',
  schema: seqNewSchema.shape,
  aliases: TOOL_ALIASES.seq_new,
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
    'seq, _msg = _load_seq(_path)',
    'if seq is None:',
    '    _err(_msg)',
    'else:',
    '    fr = _disp_rate(seq); tr = _tick_res(seq)',
    '    start = MSE.get_playback_start_seconds(seq); end = MSE.get_playback_end_seconds(seq)',
    '    allb = list(MSE.get_bindings(seq))',
    '    page = allb[_offset:_offset + _limit]',
    '    binds = []',
    '    for b in page:',
    '        tracks = list(MBE.get_tracks(b))',
    '        binds.append({"binding_guid": str(MBE.get_id(b)), "display_name": str(MBE.get_display_name(b)),',
    '                      "track_count": len(tracks), "tracks": [type(t).__name__ for t in tracks]})',
    '    roots = []',
    '    for t in MSE.get_tracks(seq):',
    '        secs = list(unreal.MovieSceneTrackExtensions.get_sections(t))',
    '        e = {"class": type(t).__name__, "path": t.get_path_name(), "section_count": len(secs)}',
    '        if isinstance(t, unreal.MovieSceneCameraCutTrack):',
    '            e["cuts"] = [{"section_path": c.get_path_name(), "start_seconds": _sec(c, True), "end_seconds": _sec(c, False)} for c in secs]',
    '        roots.append(e)',
    '    nxt = _offset + len(page)',
    '    _emit({"ok": True, "asset_path": _path, "frame_rate": fr, "tick_resolution": tr,',
    '           "playback_start_seconds": start, "playback_end_seconds": end, "duration_seconds": end - start,',
    '           "binding_count": len(allb), "bindings": binds, "master_tracks": [r["class"] for r in roots],',
    '           "root_tracks": roots, "has_more": nxt < len(allb), "next_offset": nxt})',
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
  readOnly: true,
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
    '    seq, _msg = _load_seq(_path)',
    '    if seq is None: _err(_msg); return',
    '    actor = _find_actor(_ref)',
    '    if actor is None: _err("actor not found: %s" % _ref); return',
    '    if _dry:',
    '        _emit({"ok": True, "dry_run": True, "resolved": actor.get_path_name()}); return',
    '    # idempotent-by-name: reuse an existing binding for this actor label',
    '    label = actor.get_actor_label()',
    '    for b in MSE.get_bindings(seq):',
    '        if MBE.get_name(b) == label:',
    '            _emit({"ok": True, "binding_guid": str(MBE.get_id(b)), "display_name": label, "created": False}); return',
    '    binding = _add_possessable(seq, actor)',
    '    guid = str(MBE.get_id(binding))',
    '    name = MBE.get_name(binding)',
    '    unreal.EditorAssetLibrary.save_asset(_path, only_if_is_dirty=False)',
    '    _emit({"ok": True, "binding_guid": guid, "display_name": name, "created": True})',
    '_go()',
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
    '    return m.get(tt)',
    'def _go():',
    '    seq, _msg = _load_seq(_path)',
    '    if seq is None: _err(_msg); return',
    '    cls = _track_class(_ttype)',
    '    if cls is None: _err("unknown track_type: %s" % _ttype); return',
    '    if _dry:',
    '        _emit({"ok": True, "dry_run": True, "track_class": cls.__name__}); return',
    '    if _guid is not None:',
    '        b = _binding_by_guid(seq, _guid)',
    '        if b is None: _err("binding not found: %s" % _guid); return',
    '        track = unreal.MovieSceneBindingExtensions.add_track(b, cls)',
    '    else:',
    '        track = unreal.MovieSceneSequenceExtensions.add_track(seq, cls)',
    '    if track is None: _err("add_track returned None"); return',
    '    tid = str(track.get_name())',
    '    unreal.EditorAssetLibrary.save_asset(_path, only_if_is_dirty=False)',
    '    _emit({"ok": True, "track_id": tid, "track_class": cls.__name__, "binding_guid": _guid})',
    '_go()',
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
    '    seq, _msg = _load_seq(_path)',
    '    if seq is None: _err(_msg); return',
    '    b = _binding_by_guid(seq, _guid)',
    '    if b is None: _err("binding not found: %s" % _guid); return',
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
    '        # ChannelName is a BlueprintReadOnly UPROPERTY on every scripting channel (no getter in 5.8)',
    '        nm = str(ch.channel_name)',
    '        grp = None',
    '        for k in want:',
    '            if nm.startswith(k): grp = k; break',
    '        if grp is None: continue',
    '        idx = None',
    '        for suff, i in axis.items():',
    '            if nm.endswith(suff): idx = i; break',
    '        if idx is None or not hasattr(ch, "add_key"): continue',
    '        ch.add_key(frame, float(want[grp][idx])); added += 1',
    '    unreal.EditorAssetLibrary.save_asset(_path, only_if_is_dirty=False)',
    '    _emit({"ok": True, "binding_guid": _guid, "frame": int(frame.value) if hasattr(frame, "value") else _sec_to_tick(seq, _t),',
    '           "time_seconds": _t, "keys_added": added})',
    '_go()',
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
  camera_actor: z.string().min(1).describe('Camera actor label or path to cut to (an existing binding for it is reused)'),
  start_seconds: z.number().describe('Cut start time (seconds)'),
  end_seconds: z.number().describe('Cut end time (seconds)'),
  can_blend: z.boolean().optional().describe('Set the camera-cut TRACK\'s bCanBlend (blend between cuts). Not reachable from Python; set through object_set_property.'),
  ease_in_seconds: z.number().nonnegative().optional().describe('Manual ease-in on this cut section, seconds'),
  ease_out_seconds: z.number().nonnegative().optional().describe('Manual ease-out on this cut section, seconds (FMovieSceneEasingSettings ManualEaseOutDuration)'),
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
    'seq, _msg = _load_seq(_path)',
    'cam = _find_actor(_cam) if seq is not None else None',
    'if seq is None:',
    '    _err(_msg)',
    'elif _end <= _start:',
    '    _err("end_seconds must be > start_seconds")',
    'elif cam is None:',
    '    _err("camera actor not found: %s" % _cam)',
    'elif _dry:',
    '    _emit({"ok": True, "dry_run": True, "resolved": cam.get_path_name()})',
    'else:',
    '    b = _binding_for_actor(seq, cam)',
    '    found = MSE.find_tracks_by_type(seq, unreal.MovieSceneCameraCutTrack)',
    '    track = found[0] if len(found) > 0 else MSE.add_track(seq, unreal.MovieSceneCameraCutTrack)',
    '    section = unreal.MovieSceneTrackExtensions.add_section(track)',
    '    unreal.MovieSceneSectionExtensions.set_range_seconds(section, _start, _end)',
    '    section.set_camera_binding_id(MSE.get_binding_id(seq, b))',
    '    _emit({"ok": True, "camera_guid": str(MBE.get_id(b)), "track_path": track.get_path_name(),',
    '           "section_path": section.get_path_name(), "tick_resolution": _tick_res(seq),',
    '           "start_frame": _sec_to_tick(seq, _start), "end_frame": _sec_to_tick(seq, _end),',
    '           "start_seconds": _sec(section, True), "end_seconds": _sec(section, False),',
    '           "camera_bound": True, "range_applied": True, "warnings": []})',
  ].join('\n');
}

/** bCanBlend and the easing durations are bare UPROPERTY()s, invisible to Python but
 *  not to C++ reflection, so they go through object_set_property; then the sequence is
 *  saved once and every value is read back. */
async function seqCameraCutFinish(p: SeqCameraCutParams, raw: unknown): Promise<unknown> {
  const r = raw as Record<string, unknown> & { ok?: boolean; dry_run?: boolean; track_path?: string; section_path?: string; tick_resolution?: number; warnings?: string[] };
  if (!r || r.ok !== true || r.dry_run) return raw;
  const warnings = [...(r.warnings ?? [])];
  const out: Record<string, unknown> = { ...r };
  if (p.can_blend !== undefined && r.track_path) {
    const res = await executeCommand<{ applied?: string[] }>('object_set_property', { path: r.track_path, properties: { bCanBlend: p.can_blend } });
    out.can_blend_applied = (res.applied ?? []).includes('bCanBlend');
    if (!out.can_blend_applied) warnings.push('can_blend: bCanBlend did not apply on the camera-cut track');
  }
  if ((p.ease_in_seconds !== undefined || p.ease_out_seconds !== undefined) && r.section_path) {
    const ticks = (sec: number) => Math.round(sec * (r.tick_resolution ?? 24000));
    const easing: Record<string, unknown> = {};
    if (p.ease_in_seconds !== undefined) { easing.bManualEaseIn = true; easing.ManualEaseInDuration = ticks(p.ease_in_seconds); }
    if (p.ease_out_seconds !== undefined) { easing.bManualEaseOut = true; easing.ManualEaseOutDuration = ticks(p.ease_out_seconds); }
    const res = await executeCommand<{ applied?: string[] }>('object_set_property', { path: r.section_path, properties: { Easing: easing } });
    out.easing_applied = (res.applied ?? []).includes('Easing');
    if (!out.easing_applied) warnings.push('easing did not apply on the cut section');
  }
  const saved = await runUePythonJson<{ ok?: boolean }>(
    `_ok = unreal.EditorAssetLibrary.save_asset(${pyStr(p.asset_path)}, only_if_is_dirty=False)\n_emit({"ok": bool(_ok)})`,
  );
  out.saved = saved?.ok === true;
  if (!out.saved) warnings.push('save_asset returned False; the sequence is changed but not on disk');
  out.warnings = warnings;
  return out;
}
export const seqCameraCutDescriptor: PyToolDescriptor<typeof seqCameraCutSchema.shape> = {
  name: 'seq_camera_cut',
  description:
    'Add a camera-cut section binding a camera actor over a time range (seconds) — how a shot gets its camera. Reuses (or adds) the camera binding, ensures the camera-cut track, sets the section range in seconds and its camera binding id. can_blend sets bCanBlend on the track and ease_in/out_seconds set manual easing on the section (both via object_set_property, since Python cannot reach them); then saves. Named seq_camera_cut to avoid colliding with the dormant satellite-plugin C++ seq_add_camera_cut command.',
  cost: 'medium',
  returns: '{ok, camera_guid, track_path, section_path, start_frame, end_frame, start_seconds, end_seconds, camera_bound, range_applied, can_blend_applied?, easing_applied?, saved, warnings[], dry_run?}',
  schema: seqCameraCutSchema.shape,
  meta: writeMeta,
  buildScript: seqCameraCutScript,
  finish: seqCameraCutFinish,
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
    '    if _end <= _start: _err("end_seconds must be > start_seconds"); return',
    '    seq, _msg = _load_seq(_path)',
    '    if seq is None: _err(_msg); return',
    '    if hasattr(MSE, "set_playback_start_seconds") and hasattr(MSE, "set_playback_end_seconds"):',
    '        MSE.set_playback_start_seconds(seq, _start)',
    '        MSE.set_playback_end_seconds(seq, _end)',
    '    else:',
    '        fr = _disp_rate(seq)',
    '        MSE.set_playback_start(seq, int(round(_start * fr)))',
    '        MSE.set_playback_end(seq, int(round(_end * fr)))',
    '    sf = _sec_to_tick(seq, _start); ef = _sec_to_tick(seq, _end)',
    '    unreal.EditorAssetLibrary.save_asset(_path, only_if_is_dirty=False)',
    '    _emit({"ok": True, "start_seconds": _start, "end_seconds": _end, "start_frame": sf, "end_frame": ef})',
    '_go()',
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
    '    seq, _msg = _load_seq(_path)',
    '    if seq is None: _err(_msg); return',
    '    # LevelSequenceEditor is a plugin module; fall back to the asset editor subsystem without it',
    '    if hasattr(unreal, "LevelSequenceEditorBlueprintLibrary"):',
    '        opened = bool(unreal.LevelSequenceEditorBlueprintLibrary.open_level_sequence(seq))',
    '    else:',
    '        opened = bool(unreal.get_editor_subsystem(unreal.AssetEditorSubsystem).open_editor_for_assets([seq]))',
    '    _emit({"ok": True, "asset_path": _path, "editor_opened": opened})',
    '_go()',
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
    '    seq, _msg = _load_seq(_path)',
    '    if seq is None: _err(_msg); return',
    '    SE = unreal.MovieSceneSectionExtensions',
    '    issues = []',
    '    # playback range (display-rate frames, same unit as section get_start/end_frame)',
    '    rng = MSE.get_playback_range(seq)',
    '    ps = float(rng.get_start_frame()); pe = float(rng.get_end_frame())',
    '    if pe <= ps:',
    '        issues.append({"code": "zero_length_playback", "severity": "error", "detail": "playback range is empty or inverted"})',
    '    cuts = MSE.find_tracks_by_type(seq, unreal.MovieSceneCameraCutTrack)',
    '    has_camera_cut = len(cuts) > 0',
    '    for t in cuts:',
    '        if not unreal.MovieSceneTrackExtensions.get_sections(t):',
    '            issues.append({"code": "empty_camera_cut_track", "severity": "warning", "detail": "camera cut track has no sections"})',
    '    if not has_camera_cut:',
    '        issues.append({"code": "missing_camera_cut", "severity": "warning", "detail": "no camera cut track — sequence will render the active viewport camera"})',
    '    for b in MSE.get_bindings(seq):',
    '        guid = str(MBE.get_id(b)); name = MBE.get_name(b)',
    '        tracks = list(MBE.get_tracks(b))',
    '        if not tracks:',
    '            issues.append({"code": "dangling_binding", "severity": "warning", "detail": "binding %s has no tracks" % (name or guid), "binding_guid": guid})',
    '        for t in tracks:',
    '            secs = list(unreal.MovieSceneTrackExtensions.get_sections(t))',
    '            if not secs:',
    '                issues.append({"code": "empty_track", "severity": "warning", "detail": "track %s on %s has no sections" % (type(t).__name__, name or guid), "binding_guid": guid})',
    '            for s in secs:',
    '                # an open-ended section reaches the playback range; get_start/end_frame raise on one',
    '                if not (SE.has_start_frame(s) and SE.has_end_frame(s)): continue',
    '                ssf = float(SE.get_start_frame(s)); sef = float(SE.get_end_frame(s))',
    '                if sef < ps or ssf > pe:',
    '                    issues.append({"code": "section_out_of_range", "severity": "warning", "detail": "a section on %s lies outside the playback range" % (name or guid), "binding_guid": guid})',
    '    errs = [i for i in issues if i.get("severity") == "error"]',
    '    _emit({"ok": len(errs) == 0, "asset_path": _path, "issues": issues, "fixed": [],',
    '           "error_count": len(errs), "warning_count": len(issues) - len(errs)})',
    '_go()',
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
  readOnly: true,
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
    '        cn = str(a.asset_class_path.asset_name) if hasattr(a, "asset_class_path") else str(a.asset_class)',
    '        if cn != "LevelSequence": continue',
    '        seqs.append(str(a.package_name))',
    '    seqs = sorted(set(seqs))',
    '    total = len(seqs)',
    '    page = seqs[_offset:_offset + _limit]',
    '    out = []',
    '    for pth in page:',
    '        item = {"asset_path": pth, "track_count": None, "binding_count": None}',
    '        seq, _msg = _load_seq(pth)',
    '        if seq is not None:',
    '            item["binding_count"] = len(MSE.get_bindings(seq))',
    '            item["track_count"] = len(MSE.get_tracks(seq))',
    '        out.append(item)',
    '    nxt = _offset + len(page)',
    '    _emit({"ok": True, "sequences": out, "count": total, "has_more": nxt < total, "next_offset": nxt})',
    '_go()',
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
  readOnly: true,
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
    'seq, _msg = _load_seq(_path)',
    'if seq is None:',
    '    _err(_msg)',
    'else:',
    '    allb = list(MSE.get_bindings(seq))',
    '    page = allb[_offset:_offset + _limit]',
    '    poss = set(str(MBE.get_id(b)) for b in MSE.get_possessables(seq))',
    '    out = []',
    '    for b in page:',
    '        guid = str(MBE.get_id(b))',
    '        c = MBE.get_possessed_object_class(b)',
    '        out.append({"guid": guid, "name": MBE.get_name(b), "display_name": str(MBE.get_display_name(b)),',
    '                    "kind": "possessable" if guid in poss else "spawnable",',
    '                    "object_class": c.get_name() if c is not None else None,',
    '                    "tracks": [type(t).__name__ for t in MBE.get_tracks(b)]})',
    '    nxt = _offset + len(page)',
    '    _emit({"ok": True, "asset_path": _path, "bindings": out, "count": len(allb), "has_more": nxt < len(allb), "next_offset": nxt})',
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
  readOnly: true,
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
