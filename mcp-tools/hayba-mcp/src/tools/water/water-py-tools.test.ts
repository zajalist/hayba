import { describe, it, expect, beforeEach } from 'vitest';
import { makePyToolHandler } from '../py-tool-factory.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from '../tool-executor.js';
import {
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
  waterPyDescriptors,
  WATER_NON_IDEMPOTENT,
} from './water-py-tools.js';

// Canned-stdout sender driving the HAYBA_JSON parse path; captures the last
// script so we can assert on generated python (mirrors niagara-py-tools.test.ts).
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

describe('water_check_plugin', () => {
  it('returns a structured probe and never throws (enabled/version/subsystem)', async () => {
    const { sender, lastScript } = mockStdout(
      emit({ ok: true, enabled: false, version: null, water_subsystem_ready: false, classes: {}, warnings: [] }),
    );
    setDefaultSender(sender);
    const res = await makePyToolHandler(waterCheckPluginDescriptor)({});
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('_plugin_status()');
    expect(s).toContain('WaterBodyOcean');
    expect(s).toContain('WaterZone');
    expect(s).toContain('water_subsystem_ready');
    // gate never raises on plugin absence — no `_water_guard` in the probe itself
    expect(s).toContain('"enabled": st["enabled"]');
  });
});

describe('water_body_list', () => {
  it('guards the plugin then enumerates bodies with pagination + zone binding', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, enabled: true, bodies: [], count: 0, has_more: false, next_offset: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(waterBodyListDescriptor)({ class_filter: 'Ocean' });
    const s = lastScript();
    expect(s).toContain('_water_guard()');
    expect(s).toContain('if st is None: return');
    expect(s).toContain("_filter = 'Ocean'");
    expect(s).toContain('next_offset');
    expect(s).toContain('has_waves');
  });
});

describe('water_body_inspect', () => {
  it('requires body_path and probes component validity + materials defensively', async () => {
    const missing = await makePyToolHandler(waterBodyInspectDescriptor)({});
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, enabled: true, path: '/x', component_valid: true }));
    setDefaultSender(sender);
    await makePyToolHandler(waterBodyInspectDescriptor)({ body_path: '/Game/L.L:PersistentLevel.Ocean' });
    const s = lastScript();
    expect(s).toContain('_water_guard()');
    expect(s).toContain('component_valid');
    expect(s).toContain('placeholder-stub');
    expect(s).toContain('affects_landscape');
  });
});

describe('water_body_ocean_create', () => {
  it('guards, spawns WaterBodyOcean and supports dry_run', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, enabled: true, body_path: '/a', class: 'WaterBodyOcean', warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(waterBodyOceanCreateDescriptor)({ location: [1, 2, 3] });
    const s = lastScript();
    expect(s).toContain('_water_guard()');
    expect(s).toContain("_CLS = 'WaterBodyOcean'");
    expect(s).toContain('spawn_actor_from_class');
    expect(s).toContain('_loc = [1, 2, 3]');

    const { sender: s2, lastScript: ls2 } = mockStdout(emit({ ok: true, enabled: true, planned: {} }));
    setDefaultSender(s2);
    await makePyToolHandler(waterBodyOceanCreateDescriptor)({ dry_run: true });
    expect(ls2()).toContain('_dry = True');
  });
});

describe('water_body_lake_create', () => {
  it('spawns WaterBodyLake and flags spline shaping as uncertain', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, enabled: true, body_path: '/l', class: 'WaterBodyLake', warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(waterBodyLakeCreateDescriptor)({ location: [0, 0, 0], radius: 500 });
    const s = lastScript();
    expect(s).toContain("_CLS = 'WaterBodyLake'");
    expect(s).toContain('_radius = 500');
    expect(s).toContain('UNCERTAIN-API');
  });
});

describe('water_body_river_create', () => {
  it('requires >=2 points and surfaces a spline_applied set-success flag', async () => {
    const bad = await makePyToolHandler(waterBodyRiverCreateDescriptor)({ points: [[0, 0, 0]] });
    expect(bad.isError).toBe(true);

    const { sender, lastScript } = mockStdout(emit({ ok: true, enabled: true, body_path: '/r', point_count: 3, spline_applied: true, warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(waterBodyRiverCreateDescriptor)({ points: [[0, 0, 0], [100, 0, 0], [200, 0, 0]] });
    const s = lastScript();
    expect(s).toContain("_CLS = 'WaterBodyRiver'");
    expect(s).toContain('_points = json.loads(');
    expect(s).toContain('spline_applied = _apply_points');
    expect(s).toContain('"spline_applied": spline_applied');
  });
});

describe('water_waves_inspect', () => {
  it('resolves the generator defensively and surfaces warnings', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, enabled: true, path: '/b', generator: null, warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(waterWavesInspectDescriptor)({ body_path: '/b' });
    const s = lastScript();
    expect(s).toContain('_get_waves(a)');
    expect(s).toContain('_get_generator(waves)');
    expect(s).toContain('num_waves');
    expect(s).toContain('steepness');
  });
});

describe('water_waves_set_gerstner', () => {
  it('surfaces an applied set-success flag bound to a resolved generator + setter', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: false, enabled: true, applied: false, fields_applied: {}, warnings: ['no generator'] }));
    setDefaultSender(sender);
    await makePyToolHandler(waterWavesSetGerstnerDescriptor)({ body_path: '/b', steepness: 0.5, num_waves: 8 });
    const s = lastScript();
    // ok is bound to applied — the no-silent-partial-success rule
    expect(s).toContain('applied = any(v is True for v in fields.values())');
    expect(s).toContain('"ok": bool(applied)');
    expect(s).toContain('"applied": bool(applied)');
    expect(s).toContain('value NOT applied');
    expect(s).toContain('_steep = 0.5');
    expect(s).toContain('_num = 8');
  });

  it('validates steepness range [0..1]', async () => {
    const bad = await makePyToolHandler(waterWavesSetGerstnerDescriptor)({ body_path: '/b', steepness: 2 });
    expect(bad.isError).toBe(true);
  });

  it('supports dry_run without applying', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, enabled: true, applied: false, planned: {} }));
    setDefaultSender(sender);
    await makePyToolHandler(waterWavesSetGerstnerDescriptor)({ body_path: '/b', dry_run: true });
    expect(lastScript()).toContain('_dry = True');
  });
});

describe('water_zone_create', () => {
  it('spawns a WaterZone and surfaces extent/resolution set-success flags', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, enabled: true, zone_path: '/z', warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(waterZoneCreateDescriptor)({ location: [0, 0, 0], extent: [10000, 10000], resolution: [1024, 1024] });
    const s = lastScript();
    expect(s).toContain('WaterZone');
    expect(s).toContain('spawn_actor_from_class');
    expect(s).toContain('extent_applied');
    expect(s).toContain('resolution_applied');
  });
});

describe('water_zone_inspect', () => {
  it('reports covered vs orphaned bodies', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, enabled: true, zone_path: '/z', covered_bodies: [], orphaned_bodies: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(waterZoneInspectDescriptor)({ zone_path: '/z' });
    const s = lastScript();
    expect(s).toContain('covered_bodies');
    expect(s).toContain('orphaned_bodies');
    expect(s).toContain('_covers');
  });
});

describe('water_validate', () => {
  it('flags no-zone, body-outside-zone and out-of-range waves (PLUMB green/red)', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, enabled: true, status: 'green', findings: [], error_count: 0, warning_count: 0 }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(waterValidateDescriptor)({});
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('no_water_zone');
    expect(s).toContain('body_outside_zone');
    expect(s).toContain('steepness_out_of_range');
    expect(s).toContain('"status": status');
  });
});

describe('water-domain factory catalog', () => {
  it('exports 11 tools with unique names', () => {
    const names = waterPyDescriptors.map((d) => d.name);
    expect(names).toHaveLength(11);
    expect(new Set(names).size).toBe(11);
  });

  it('every tool has a 30s timeout and structured returns', () => {
    for (const d of waterPyDescriptors) {
      expect(d.timeoutMs).toBe(30_000);
      expect(d.returns).toContain('ok');
    }
  });

  it('water_check_plugin is the first tool (the honest gate)', () => {
    expect(waterPyDescriptors[0].name).toBe('water_check_plugin');
  });

  it('classifies the 4 spawn tools NON_IDEMPOTENT and wires them into the executor set', () => {
    expect([...WATER_NON_IDEMPOTENT].sort()).toEqual(
      ['water_body_lake_create', 'water_body_ocean_create', 'water_body_river_create', 'water_zone_create'],
    );
    for (const name of WATER_NON_IDEMPOTENT) {
      expect(NON_IDEMPOTENT.has(name)).toBe(true);
    }
  });

  it('does NOT classify set-to-value / read tools as non-idempotent', () => {
    for (const name of [
      'water_check_plugin', 'water_body_list', 'water_body_inspect',
      'water_waves_inspect', 'water_waves_set_gerstner', 'water_zone_inspect',
      'water_validate',
    ]) {
      expect(NON_IDEMPOTENT.has(name)).toBe(false);
    }
  });

  it('uses net-new names that do not collide with any existing command surface', () => {
    // no water_* command exists in sidecar/index/list-tool-categories or unreal
    for (const d of waterPyDescriptors) {
      expect(d.name.startsWith('water_')).toBe(true);
    }
  });
});
