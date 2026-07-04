import { describe, it, expect, beforeEach } from 'vitest';
import { makePyToolHandler } from '../py-tool-factory.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from '../tool-executor.js';
import {
  actorInspectDescriptor,
  actorFindDescriptor,
  actorGetSelectionDescriptor,
  actorSetSelectionDescriptor,
  actorSpawnFromAssetDescriptor,
  actorBatchTransformDescriptor,
  actorFocusDescriptor,
  actorSetFolderDescriptor,
  actorPyDescriptors,
} from './actor-py-tools.js';

// Canned-stdout sender that drives the HAYBA_JSON parse path (mirrors
// py-tool-factory.test.ts). Also captures the last script sent so we can assert
// on generated python.
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

describe('actor_inspect', () => {
  it('rejects missing actor_id (never dispatches)', async () => {
    let dispatched = false;
    setDefaultSender((async () => { dispatched = true; return { id: 'x', ok: true, data: {} }; }) as Sender);
    const res = await makePyToolHandler(actorInspectDescriptor)({});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toContain('Invalid params for actor_inspect');
    expect(dispatched).toBe(false);
  });

  it('generates a script with the validated accessor idioms and parses HAYBA_JSON', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_id: 'Rock1', class: 'StaticMeshActor' }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(actorInspectDescriptor)({ actor_id: 'Rock1' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toMatchObject({ ok: true, actor_id: 'Rock1' });
    const s = lastScript();
    expect(s).toContain('EditorActorSubsystem');
    expect(s).toContain('get_components_by_class');
    expect(s).toContain("_ref = 'Rock1'");
    expect(s).toContain('get_actor_bounds');
  });
});

describe('actor_find', () => {
  it('applies zod defaults for limit/offset into the script', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actors: [], total: 0, has_more: false }));
    setDefaultSender(sender);
    await makePyToolHandler(actorFindDescriptor)({ label_contains: 'Tree' });
    const s = lastScript();
    expect(s).toContain('_limit = 100');
    expect(s).toContain('_offset = 0');
    expect(s).toContain("_label = 'Tree'");
    expect(s).toContain('_cls = None');
  });

  it('embeds spatial filter params when near+radius supplied', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actors: [], total: 0, has_more: false }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(actorFindDescriptor)({ near: [100, 200, 0], radius_cm: 500, class_name: 'StaticMeshActor' });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('_near = [100,200,0]');
    expect(s).toContain('_radius = 500');
    expect(s).toContain("_cls = 'StaticMeshActor'");
  });

  it('rejects a bad near vector length', async () => {
    const res = await makePyToolHandler(actorFindDescriptor)({ near: [1, 2] });
    expect(res.isError).toBe(true);
  });
});

describe('actor_get_selection', () => {
  it('takes no params and reads the selection', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actors: [], count: 0 }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(actorGetSelectionDescriptor)({});
    expect(res.isError).toBeUndefined();
    expect(lastScript()).toContain('get_selected_level_actors');
  });
});

describe('actor_set_selection', () => {
  it('requires actor_ids', async () => {
    const res = await makePyToolHandler(actorSetSelectionDescriptor)({});
    expect(res.isError).toBe(true);
  });

  it('embeds the id list and clears prior selection', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, selected: ['A'], missing: [], count: 1 }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(actorSetSelectionDescriptor)({ actor_ids: ['A', 'B'] });
    expect(JSON.parse(res.content[0].text).selected).toEqual(['A']);
    const s = lastScript();
    expect(s).toContain('select_nothing');
    expect(s).toContain('set_actor_selection_state');
    expect(s).toContain('_refs = ["A","B"]');
  });
});

describe('actor_spawn_from_asset', () => {
  it('requires asset_path', async () => {
    const res = await makePyToolHandler(actorSpawnFromAssetDescriptor)({});
    expect(res.isError).toBe(true);
  });

  it('generates spawn_actor_from_object + defaults, snap off by default', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_id: 'SM_Rock', class: 'StaticMeshActor' }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(actorSpawnFromAssetDescriptor)({ asset_path: '/Game/Meshes/SM_Rock' });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('spawn_actor_from_object');
    expect(s).toContain("_asset_path = '/Game/Meshes/SM_Rock'");
    expect(s).toContain('_snap = False');
    expect(s).toContain('_loc = [0,0,0]');
  });

  it('emits line_trace when snap_to_floor is set', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_id: 'X' }));
    setDefaultSender(sender);
    await makePyToolHandler(actorSpawnFromAssetDescriptor)({ asset_path: '/Game/A', snap_to_floor: true, location: [10, 20, 30] });
    const s = lastScript();
    expect(s).toContain('_snap = True');
    expect(s).toContain('line_trace_single');
    expect(s).toContain('_loc = [10,20,30]');
  });

  it('surfaces a python _err envelope as a success-shaped ok:false result', async () => {
    setDefaultSender(mockStdout(emit({ ok: false, error: 'asset not found: /Game/Nope' })).sender);
    const res = await makePyToolHandler(actorSpawnFromAssetDescriptor)({ asset_path: '/Game/Nope' });
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('asset not found');
  });

  it('is classified NON_IDEMPOTENT', () => {
    expect(NON_IDEMPOTENT.has('actor_spawn_from_asset')).toBe(true);
  });
});

describe('actor_batch_transform', () => {
  it('requires a non-empty transforms array', async () => {
    const res = await makePyToolHandler(actorBatchTransformDescriptor)({ transforms: [] });
    expect(res.isError).toBe(true);
  });

  it('embeds each edit and returns per-actor before/after', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, results: [{ actor_id: 'A', ok: true, before: {}, after: {} }], count: 1 }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(actorBatchTransformDescriptor)({
      transforms: [{ actor_id: 'A', location: [1, 2, 3] }],
    });
    expect(JSON.parse(res.content[0].text).count).toBe(1);
    const s = lastScript();
    expect(s).toContain('set_actor_location');
    expect(s).toContain('"actor_id":"A"');
    expect(s).toContain('"location":[1,2,3]');
  });
});

describe('actor_focus', () => {
  it('requires actor_id and generates a viewport-align path', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_id: 'Hero', focused: true }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(actorFocusDescriptor)({ actor_id: 'Hero' });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain("_ref = 'Hero'");
    expect(s).toContain('set_actor_selection_state');
    expect(s).toContain('CAMERA ALIGN');
  });
});

describe('actor_set_folder', () => {
  it('requires actor_ids and a folder', async () => {
    const res = await makePyToolHandler(actorSetFolderDescriptor)({ actor_ids: ['A'] });
    expect(res.isError).toBe(true);
  });

  it('embeds the folder and set_folder_path call', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, moved: [{ actor_id: 'A', folder: 'Buildings' }], missing: [], count: 1 }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(actorSetFolderDescriptor)({ actor_ids: ['A'], folder: 'Buildings' });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('set_folder_path');
    expect(s).toContain("_folder = 'Buildings'");
    expect(s).toContain('_refs = ["A"]');
  });
});

describe('actor-domain factory catalog', () => {
  it('exports 8 net-new tools with unique names', () => {
    const names = actorPyDescriptors.map((d) => d.name);
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8);
  });

  it('does not collide with the existing hand-written actor tool names', () => {
    const existing = new Set(['actor_spawn', 'actor_list', 'actor_delete', 'actor_transform']);
    for (const n of actorPyDescriptors.map((d) => d.name)) {
      expect(existing.has(n)).toBe(false);
    }
  });

  it('every tool has a 30s timeout and structured returns', () => {
    for (const d of actorPyDescriptors) {
      expect(d.timeoutMs).toBe(30_000);
      expect(d.returns).toContain('ok');
    }
  });
});
