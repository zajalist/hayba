import { describe, it, expect, beforeEach } from 'vitest';
import { makePyToolHandler } from '../py-tool-factory.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from '../tool-executor.js';
import {
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
  sequencerPyDescriptors,
  SEQUENCER_NON_IDEMPOTENT,
} from './sequencer-py-tools.js';

// Canned-stdout sender driving the HAYBA_JSON parse path; captures the last
// script so we can assert on generated python (mirrors mesh-py-tools.test.ts).
function mockStdout(stdout: string): { sender: Sender; lastScript: () => string } {
  let script = '';
  const sender: Sender = (async (_cmd, params: Record<string, unknown>) => {
    script = String((params as { script?: string }).script ?? '');
    return { id: 'inmem', ok: true, data: { ok: true, stdout, stderr: '' } };
  }) as Sender;
  return { sender, lastScript: () => script };
}

function emit(obj: unknown): string {
  return `noise\nHAYBA_JSON:${JSON.stringify(obj)}\ntrailing`;
}

beforeEach(() => setDefaultSender(undefined as never));

describe('seq_new', () => {
  it('requires path + name and creates a LevelSequence with display rate', async () => {
    const missing = await makePyToolHandler(seqNewDescriptor)({ path: '/Game/Cine' });
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/Cine/LS', name: 'LS', created: true }));
    setDefaultSender(sender);
    await makePyToolHandler(seqNewDescriptor)({ path: '/Game/Cine', name: 'LS', frame_rate: 24 });
    const s = lastScript();
    expect(s).toContain('LevelSequenceFactoryNew');
    expect(s).toContain('set_display_rate');
    expect(s).toContain('_fr = 24');
    expect(s).toContain("_name = 'LS'");
  });

  it('supports dry_run without creating', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, dry_run: true, asset_path: '/Game/Cine/LS', name: 'LS' }));
    setDefaultSender(sender);
    await makePyToolHandler(seqNewDescriptor)({ path: '/Game/Cine', name: 'LS', dry_run: true });
    expect(lastScript()).toContain('_dry = True');
  });
});

describe('seq_inspect', () => {
  it('reads display rate, playback range and paginated bindings', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/LS', frame_rate: 30, bindings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(seqInspectDescriptor)({ asset_path: '/Game/LS' });
    const s = lastScript();
    expect(s).toContain('get_display_rate');
    expect(s).toContain('get_playback_range');
    expect(s).toContain('get_bindings');
    expect(s).toContain('next_offset');
  });
});

describe('seq_bind_actor', () => {
  it('resolves the actor and probes both possession entry points', async () => {
    const missing = await makePyToolHandler(seqBindActorDescriptor)({ asset_path: '/Game/LS' });
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, binding_guid: 'ABC', display_name: 'Cube', created: true }));
    setDefaultSender(sender);
    await makePyToolHandler(seqBindActorDescriptor)({ asset_path: '/Game/LS', actor: 'Cube' });
    const s = lastScript();
    expect(s).toContain('_find_actor');
    expect(s).toContain('add_possessable');
    expect(s).toContain('MovieSceneSequenceExtensions.add_possessable');
  });
});

describe('seq_track_add', () => {
  it('validates track_type enum and maps to a track class', async () => {
    const bad = await makePyToolHandler(seqTrackAddDescriptor)({ asset_path: '/Game/LS', track_type: 'bogus' });
    expect(bad.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, track_id: 'T', track_class: 'MovieScene3DTransformTrack' }));
    setDefaultSender(sender);
    await makePyToolHandler(seqTrackAddDescriptor)({ asset_path: '/Game/LS', track_type: 'transform', binding_guid: 'G' });
    const s = lastScript();
    expect(s).toContain('MovieScene3DTransformTrack');
    expect(s).toContain('MovieSceneBindingExtensions.add_track');
    expect(s).toContain("_guid = 'G'");
  });

  it('adds a master track when binding_guid is omitted', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, track_id: 'T', track_class: 'MovieSceneCameraCutTrack' }));
    setDefaultSender(sender);
    await makePyToolHandler(seqTrackAddDescriptor)({ asset_path: '/Game/LS', track_type: 'camera_cuts' });
    const s = lastScript();
    expect(s).toContain('_guid = None');
    expect(s).toContain('MovieSceneSequenceExtensions.add_track');
  });
});

describe('seq_transform_keyframe', () => {
  it('embeds location/rotation/scale vectors and authors keys in tick resolution', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, binding_guid: 'G', keys_added: 6, frame: 240 }));
    setDefaultSender(sender);
    await makePyToolHandler(seqTransformKeyframeDescriptor)({
      asset_path: '/Game/LS', binding_guid: 'G', time_seconds: 1, location: [1, 2, 3], rotation: [0, 90, 0],
    });
    const s = lastScript();
    expect(s).toContain('_loc = [1, 2, 3]');
    expect(s).toContain('_rot = [0, 90, 0]');
    expect(s).toContain('_scl = None');
    expect(s).toContain('get_all_channels');
    expect(s).toContain('_sec_to_tick');
  });
});

describe('seq_camera_cut', () => {
  it('possesses the camera and sets a section range', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, camera_guid: 'C', start_frame: 0, end_frame: 240 }));
    setDefaultSender(sender);
    await makePyToolHandler(seqCameraCutDescriptor)({
      asset_path: '/Game/LS', camera_actor: 'Cam', start_seconds: 0, end_seconds: 2,
    });
    const s = lastScript();
    expect(s).toContain('MovieSceneCameraCutTrack');
    expect(s).toContain('add_section');
    expect(s).toContain('set_camera_binding_id');
    expect(s).toContain('_start = 0');
  });
});

describe('seq_playback_range', () => {
  it('probes seconds setters then a frame fallback', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, start_seconds: 0, end_seconds: 5, start_frame: 0, end_frame: 120000 }));
    setDefaultSender(sender);
    await makePyToolHandler(seqPlaybackRangeDescriptor)({ asset_path: '/Game/LS', start_seconds: 0, end_seconds: 5 });
    const s = lastScript();
    expect(s).toContain('set_playback_start_seconds');
    expect(s).toContain('set_playback_end_seconds');
    expect(s).toContain('set_playback_start');
  });
});

describe('seq_open', () => {
  it('probes LevelSequenceEditorBlueprintLibrary.open_level_sequence', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/LS', editor_opened: true }));
    setDefaultSender(sender);
    await makePyToolHandler(seqOpenDescriptor)({ asset_path: '/Game/LS' });
    expect(lastScript()).toContain('open_level_sequence');
  });
});

describe('seq_validate', () => {
  it('flags dangling bindings, empty tracks and missing camera cut', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/LS', issues: [], fixed: [] }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(seqValidateDescriptor)({ asset_path: '/Game/LS' });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('dangling_binding');
    expect(s).toContain('empty_track');
    expect(s).toContain('missing_camera_cut');
    expect(s).toContain('section_out_of_range');
  });
});

describe('seq_list', () => {
  it('queries the AssetRegistry filtering LevelSequence', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, sequences: [], count: 0, has_more: false, next_offset: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(seqListDescriptor)({});
    const s = lastScript();
    expect(s).toContain('get_asset_registry');
    expect(s).toContain('LevelSequence');
    expect(s).toContain('_root = ');
  });
});

describe('seq_list_bindings', () => {
  it('reads binding guid/name/object class paginated', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/LS', bindings: [], count: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(seqListBindingsDescriptor)({ asset_path: '/Game/LS' });
    const s = lastScript();
    expect(s).toContain('get_possessed_object_class');
    expect(s).toContain('next_offset');
  });
});

describe('sequencer-domain factory catalog', () => {
  it('exports 11 tools with unique names', () => {
    const names = sequencerPyDescriptors.map((d) => d.name);
    expect(names).toHaveLength(11);
    expect(new Set(names).size).toBe(11);
  });

  it('every tool has a 30s timeout and structured returns', () => {
    for (const d of sequencerPyDescriptors) {
      expect(d.timeoutMs).toBe(30_000);
      expect(d.returns).toContain('ok');
    }
  });

  it('uses names that do NOT collide with the dormant C++ seq_* commands', () => {
    const cpp = new Set([
      'seq_create', 'seq_add_track', 'seq_add_keyframe', 'seq_get_info',
      'seq_play', 'seq_export', 'seq_add_camera_cut', 'seq_set_playback_range',
    ]);
    for (const d of sequencerPyDescriptors) {
      expect(cpp.has(d.name)).toBe(false);
    }
  });

  it('classifies the 5 mutating create/append tools NON_IDEMPOTENT', () => {
    expect([...SEQUENCER_NON_IDEMPOTENT].sort()).toEqual(
      ['seq_bind_actor', 'seq_camera_cut', 'seq_new', 'seq_track_add', 'seq_transform_keyframe'],
    );
    for (const name of SEQUENCER_NON_IDEMPOTENT) {
      expect(NON_IDEMPOTENT.has(name)).toBe(true);
    }
  });

  it('does NOT classify set-to-value / read tools as non-idempotent', () => {
    for (const name of ['seq_playback_range', 'seq_open', 'seq_inspect', 'seq_validate', 'seq_list', 'seq_list_bindings']) {
      expect(NON_IDEMPOTENT.has(name)).toBe(false);
    }
  });
});
