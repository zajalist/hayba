import { describe, it, expect, beforeEach } from 'vitest';
import { makePyToolHandler } from '../py-tool-factory.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from '../tool-executor.js';
import {
  landscapeListDescriptor,
  landscapeInspectDescriptor,
  landscapeLayerListDescriptor,
  landscapeGetMaterialDescriptor,
  landscapeListSplinesDescriptor,
  landscapeSetMaterialDescriptor,
  landscapeSetLodSettingsDescriptor,
  landscapeSetNaniteDescriptor,
  landscapeAddLayerDescriptor,
  landscapePyDescriptors,
  LANDSCAPE_NON_IDEMPOTENT,
} from './landscape-py-tools.js';

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

describe('landscape_list', () => {
  it('enumerates LandscapeProxy actors with layout + pagination', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, landscapes: [], total: 0, has_more: false, next_offset: 50 }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(landscapeListDescriptor)({ name_filter: 'Terrain', limit: 10, offset: 5 });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('unreal.LandscapeProxy');
    expect(s).toContain('_all_landscapes');
    expect(s).toContain("_filter = 'Terrain'");
    expect(s).toContain('_limit = 10');
    expect(s).toContain('_offset = 5');
    expect(s).toContain('landscape_material');
  });
});

describe('landscape_inspect', () => {
  it('resolves a landscape and reads layout/layers/warnings', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_label: 'L', layers: [], warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeInspectDescriptor)({ actor_label: 'MyLand' });
    const s = lastScript();
    expect(s).toContain('_resolve_landscape');
    expect(s).toContain("_ref = 'MyLand'");
    expect(s).toContain('component_size_quads');
    expect(s).toContain('warnings');
  });

  it('passes None ref when actor_label omitted (single-landscape convenience)', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_label: 'L', layers: [], warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeInspectDescriptor)({});
    expect(lastScript()).toContain('_ref = None');
  });
});

describe('landscape_layer_list', () => {
  it('reads paint layers via the _layers_of helper', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_label: 'L', layers: [], count: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeLayerListDescriptor)({ actor_label: 'L' });
    const s = lastScript();
    expect(s).toContain('_layers_of');
    expect(s).toContain('weightmap_present');
  });
});

describe('landscape_get_material', () => {
  it('reads landscape_material + hole_material', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_label: 'L', material: null, hole_material: null }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeGetMaterialDescriptor)({ actor_label: 'L' });
    const s = lastScript();
    expect(s).toContain('landscape_material');
    expect(s).toContain('landscape_hole_material');
  });
});

describe('landscape_list_splines', () => {
  it('enumerates LandscapeSplinesComponents', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_label: 'L', spline_components: [], count: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeListSplinesDescriptor)({ actor_label: 'L' });
    const s = lastScript();
    expect(s).toContain('unreal.LandscapeSplinesComponent');
    expect(s).toContain('control_points');
  });
});

describe('landscape_set_material', () => {
  it('requires material_path and assigns + reads back (set-to-value)', async () => {
    const missing = await makePyToolHandler(landscapeSetMaterialDescriptor)({ actor_label: 'L' });
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_label: 'L', assigned: '/Game/M', readback: '/Game/M' }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeSetMaterialDescriptor)({ actor_label: 'L', material_path: '/Game/M' });
    const s = lastScript();
    expect(s).toContain('unreal.load_asset(_mat)');
    expect(s).toContain('set_editor_property("landscape_material"');
    expect(s).toContain("_mat = '/Game/M'");
  });

  it('binds ok to the readback matching the assigned material (no silent success)', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeSetMaterialDescriptor)({ actor_label: 'L', material_path: '/Game/M' });
    const s = lastScript();
    expect(s).toContain('_applied = (_rb == _mat)');
    expect(s).toContain('"ok": _applied');
    expect(s).toContain('warnings');
  });

  it('is NOT classified NON_IDEMPOTENT (set-to-value)', () => {
    expect(NON_IDEMPOTENT.has('landscape_set_material')).toBe(false);
  });
});

describe('landscape_set_lod_settings', () => {
  it('guards "at least one field" in the generated script', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_label: 'L', applied: {} }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeSetLodSettingsDescriptor)({ actor_label: 'L' });
    expect(lastScript()).toContain('provide at least one of');
  });

  it('emits set_editor_property for provided fields', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_label: 'L', applied: { lod_distribution: 2 } }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeSetLodSettingsDescriptor)({ actor_label: 'L', lod_distribution: 2 });
    const s = lastScript();
    expect(s).toContain('lod_distribution_setting');
    expect(s).toContain('_dist = 2');
    expect(s).toContain('_bias = None');
  });
});

describe('landscape_set_nanite', () => {
  it('toggles enable_nanite and reports rebuild_needed', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_label: 'L', nanite_enabled: true, rebuild_needed: true }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeSetNaniteDescriptor)({ actor_label: 'L', enable: true });
    const s = lastScript();
    expect(s).toContain('set_editor_property("enable_nanite"');
    expect(s).toContain('_enable = True');
    expect(s).toContain('rebuild_needed');
  });

  it('binds ok to the enable_nanite readback matching the request (no silent success)', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeSetNaniteDescriptor)({ actor_label: 'L', enable: true });
    const s = lastScript();
    expect(s).toContain('_applied = (_rb == _enable)');
    expect(s).toContain('"ok": _applied');
  });
});

describe('landscape_add_layer', () => {
  it('requires layer_name + layer_info_path and creates-or-reuses a LayerInfo', async () => {
    const missing = await makePyToolHandler(landscapeAddLayerDescriptor)({ layer_name: 'Rock' });
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, layer_name: 'Rock', layer_info_path: '/Game/LI_Rock', created: true, weight_blend: true }));
    setDefaultSender(sender);
    await makePyToolHandler(landscapeAddLayerDescriptor)({ layer_name: 'Rock', layer_info_path: '/Game/LI_Rock' });
    const s = lastScript();
    expect(s).toContain('LandscapeLayerInfoObject');
    expect(s).toContain('unreal.load_asset(_path)');
    expect(s).toContain("_name = 'Rock'");
    expect(s).toContain('save_loaded_asset');
  });

  it('IS classified NON_IDEMPOTENT (asset-create lifecycle)', () => {
    expect(NON_IDEMPOTENT.has('landscape_add_layer')).toBe(true);
    expect(LANDSCAPE_NON_IDEMPOTENT).toContain('landscape_add_layer');
  });
});

describe('landscape-domain factory catalog', () => {
  it('exports 9 net-new tools with unique names', () => {
    const names = landscapePyDescriptors.map((d) => d.name);
    expect(names).toHaveLength(9);
    expect(new Set(names).size).toBe(9);
  });

  it('every tool has a 30s timeout and structured returns', () => {
    for (const d of landscapePyDescriptors) {
      expect(d.timeoutMs).toBe(30_000);
      expect(d.returns).toContain('ok');
    }
  });

  it('declares exactly one non-idempotent tool', () => {
    expect(LANDSCAPE_NON_IDEMPOTENT).toEqual(['landscape_add_layer']);
  });

  it('every _err path is present in generated scripts', async () => {
    for (const d of landscapePyDescriptors) {
      const { sender, lastScript } = mockStdout(emit({ ok: true }));
      setDefaultSender(sender);
      // minimal params per tool
      const params: Record<string, unknown> = {};
      if (d.name === 'landscape_set_material') { params.material_path = '/Game/M'; }
      if (d.name === 'landscape_set_lod_settings') { params.lod_distribution = 1; }
      if (d.name === 'landscape_set_nanite') { params.enable = true; }
      if (d.name === 'landscape_add_layer') { params.layer_name = 'X'; params.layer_info_path = '/Game/LI_X'; }
      await makePyToolHandler(d)(params);
      expect(lastScript()).toContain('_err(_e)');
    }
  });
});
