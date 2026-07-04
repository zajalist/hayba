import { describe, it, expect, beforeEach } from 'vitest';
import { makePyToolHandler } from '../py-tool-factory.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from '../tool-executor.js';
import {
  meshGetSocketsDescriptor,
  meshGetLodsDescriptor,
  meshGetMaterialsDescriptor,
  meshGetBoundsDescriptor,
  meshSetMaterialSlotDescriptor,
  meshPyDescriptors,
  MESH_NON_IDEMPOTENT,
} from './mesh-py-tools.js';

// Canned-stdout sender driving the HAYBA_JSON parse path; captures the last
// script so we can assert on generated python (mirrors editor-py-tools.test.ts).
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

describe('mesh_get_sockets', () => {
  it('requires asset_path and reads the sockets property with a StaticMesh guard', async () => {
    const missing = await makePyToolHandler(meshGetSocketsDescriptor)({});
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/M', sockets: [], count: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(meshGetSocketsDescriptor)({ asset_path: '/Game/M' });
    const s = lastScript();
    expect(s).toContain('isinstance(obj, unreal.StaticMesh)');
    expect(s).toContain('"sockets"');
    expect(s).toContain('socket_name');
  });
});

describe('mesh_get_lods', () => {
  it('probes StaticMeshEditorSubsystem then EditorStaticMeshLibrary', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/M', lod_count: 3, lods: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(meshGetLodsDescriptor)({ asset_path: '/Game/M' });
    const s = lastScript();
    expect(s).toContain('StaticMeshEditorSubsystem');
    expect(s).toContain('get_lod_count');
    expect(s).toContain('EditorStaticMeshLibrary');
    expect(s).toContain('get_number_triangles');
  });
});

describe('mesh_get_materials', () => {
  it('reads static_materials slot table', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/M', materials: [], count: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(meshGetMaterialsDescriptor)({ asset_path: '/Game/M' });
    const s = lastScript();
    expect(s).toContain('static_materials');
    expect(s).toContain('material_slot_name');
    expect(s).toContain('material_interface');
  });
});

describe('mesh_get_bounds', () => {
  it('reads get_bounds with a get_bounding_box fallback', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/M', origin: [0, 0, 0], extent: [1, 1, 1] }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(meshGetBoundsDescriptor)({ asset_path: '/Game/M' });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('get_bounds');
    expect(s).toContain('get_bounding_box');
    expect(s).toContain('box_extent');
  });
});

describe('mesh_set_material_slot', () => {
  it('requires all params and assigns + reads back', async () => {
    const missing = await makePyToolHandler(meshSetMaterialSlotDescriptor)({ asset_path: '/Game/M' });
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, asset_path: '/Game/M', slot_index: 0, material: '/Game/Mat', applied: true, readback: '/Game/Mat' }));
    setDefaultSender(sender);
    await makePyToolHandler(meshSetMaterialSlotDescriptor)({ asset_path: '/Game/M', slot_index: 0, material_path: '/Game/Mat' });
    const s = lastScript();
    expect(s).toContain('set_material');
    expect(s).toContain('static_materials');
    expect(s).toContain('save_asset');
    expect(s).toContain('_slot = 0');
    expect(s).toContain("_mat = '/Game/Mat'");
  });

  it('is NOT classified NON_IDEMPOTENT (set-to-value is retry-safe)', () => {
    expect(NON_IDEMPOTENT.has('mesh_set_material_slot')).toBe(false);
  });
});

describe('mesh-domain factory catalog', () => {
  it('exports 5 net-new tools with unique names', () => {
    const names = meshPyDescriptors.map((d) => d.name);
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
  });

  it('every tool has a 30s timeout and structured returns', () => {
    for (const d of meshPyDescriptors) {
      expect(d.timeoutMs).toBe(30_000);
      expect(d.returns).toContain('ok');
    }
  });

  it('declares no non-idempotent tools', () => {
    expect(MESH_NON_IDEMPOTENT).toHaveLength(0);
  });
});
