import { describe, it, expect, beforeEach } from 'vitest';
import { makePyToolHandler } from '../py-tool-factory.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from '../tool-executor.js';
import {
  foliageCapabilityProbeDescriptor,
  foliageScanTypesDescriptor,
  foliageTypeInspectDescriptor,
  foliageGetInstanceCountDescriptor,
  foliageTypeSetParamsDescriptor,
  foliageReplaceMeshDescriptor,
  foliageTypeCreateDescriptor,
  foliageAddInstancesDescriptor,
  foliageScatterPaintDescriptor,
  FOLIAGE_SCATTER_WORK_LIMITS,
  foliageRemoveInBoundsDescriptor,
  foliageClearTypeDescriptor,
  foliagePyDescriptors,
  FOLIAGE_NON_IDEMPOTENT,
} from './foliage-py-tools.js';

// Canned-stdout sender driving the HAYBA_JSON parse path; captures the last
// script so we can assert on generated python (mirrors landscape-py-tools.test.ts).
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

describe('foliage_capability_probe', () => {
  it('reports bindings + surface actors', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, capabilities: {}, surface_actors: [] }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(foliageCapabilityProbeDescriptor)({});
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('has_foliage_lib');
    expect(s).toContain('EditorFoliageLibrary'); // via _efl helper text
    expect(s).toContain('surface_actors');
  });
});

describe('foliage_scan_types', () => {
  it('enumerates types with pagination', async () => {
    const { sender, lastScript } = mockStdout(
      emit({ ok: true, types: [], total: 0, has_more: false, next_offset: 10 }),
    );
    setDefaultSender(sender);
    await makePyToolHandler(foliageScanTypesDescriptor)({ limit: 10, offset: 5 });
    const s = lastScript();
    expect(s).toContain('_ifas');
    expect(s).toContain('_limit = 10');
    expect(s).toContain('_offset = 5');
    expect(s).toContain('instance_count');
  });
});

describe('foliage_type_inspect', () => {
  it('requires a path and reads all params', async () => {
    const missing = await makePyToolHandler(foliageTypeInspectDescriptor)({});
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, params: {}, warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageTypeInspectDescriptor)({ foliage_type_path: '/Game/FT' });
    const s = lastScript();
    expect(s).toContain("_path = '/Game/FT'");
    expect(s).toContain('align_to_normal');
    expect(s).toContain('cull_distance');
  });
});

describe('foliage_get_instance_count', () => {
  it('counts via _count_in_box', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, instance_count: 3, warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageGetInstanceCountDescriptor)({ foliage_type_path: '/Game/FT' });
    expect(lastScript()).toContain('_count_in_box');
  });
});

describe('foliage_type_set_params', () => {
  it('guards "at least one param"', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, changed_keys: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageTypeSetParamsDescriptor)({ foliage_type_path: '/Game/FT' });
    expect(lastScript()).toContain('provide at least one param');
  });

  it('emits set logic for provided fields + scale interval', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, changed_keys: ['density'] }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageTypeSetParamsDescriptor)({
      foliage_type_path: '/Game/FT',
      density: 5,
      scale_min: 0.8,
      scale_max: 1.2,
    });
    const s = lastScript();
    expect(s).toContain('_density = 5');
    expect(s).toContain('_smin = 0.8');
    expect(s).toContain('_interval');
    expect(s).toContain('changed_keys');
  });

  it('binds ok to at least one applied key (no silent success when nothing changed)', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageTypeSetParamsDescriptor)({ foliage_type_path: '/Game/FT', density: 5 });
    const s = lastScript();
    expect(s).toContain('"ok": len(changed) > 0');
    expect(s).toContain('warnings');
  });

  it('is NOT classified NON_IDEMPOTENT (set-to-value)', () => {
    expect(NON_IDEMPOTENT.has('foliage_type_set_params')).toBe(false);
  });
});

describe('foliage_replace_mesh', () => {
  it('requires new_mesh_path and sets mesh', async () => {
    const missing = await makePyToolHandler(foliageReplaceMeshDescriptor)({ foliage_type_path: '/Game/FT' });
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, assigned_mesh: '/Game/SM', readback: '/Game/SM' }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageReplaceMeshDescriptor)({ foliage_type_path: '/Game/FT', new_mesh_path: '/Game/SM' });
    const s = lastScript();
    expect(s).toContain('unreal.load_asset(_mesh)');
    expect(s).toContain('_set(ft, mesh');
  });

  it('is NOT classified NON_IDEMPOTENT (set-to-value)', () => {
    expect(NON_IDEMPOTENT.has('foliage_replace_mesh')).toBe(false);
  });
});

describe('foliage_type_create', () => {
  it('requires mesh/dest/name and probes the factory', async () => {
    const missing = await makePyToolHandler(foliageTypeCreateDescriptor)({ static_mesh_path: '/Game/SM' });
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, foliage_type_path: '/Game/FT', created: true }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageTypeCreateDescriptor)({
      static_mesh_path: '/Game/SM',
      dest_path: '/Game/Foliage',
      name: 'FT_Tree',
    });
    const s = lastScript();
    expect(s).toContain('FoliageType_InstancedStaticMesh');
    expect(s).toContain('create_asset');
    expect(s).toContain("_name = 'FT_Tree'");
  });

  it('IS classified NON_IDEMPOTENT (asset-create)', () => {
    expect(NON_IDEMPOTENT.has('foliage_type_create')).toBe(true);
    expect(FOLIAGE_NON_IDEMPOTENT).toContain('foliage_type_create');
  });

  it('guards against reusing a non-FoliageType asset at the destination path', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, foliage_type_path: '/Game/FT', created: false }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageTypeCreateDescriptor)({
      static_mesh_path: '/Game/SM',
      dest_path: '/Game/Foliage',
      name: 'FT_Tree',
    });
    const s = lastScript();
    expect(s).toContain('isinstance(existing, unreal.FoliageType)');
    expect(s).toContain('exists but is not a FoliageType');
  });
});

describe('foliage_add_instances', () => {
  it('requires transforms and chunks the add', async () => {
    const missing = await makePyToolHandler(foliageAddInstancesDescriptor)({ foliage_type_path: '/Game/FT' });
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, added: 1, instance_count: 1 }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageAddInstancesDescriptor)({
      foliage_type_path: '/Game/FT',
      transforms: [{ location: [1, 2, 3] }],
      chunk_size: 500,
    });
    const s = lastScript();
    expect(s).toContain('_chunk = 500');
    expect(s).toContain('_add_instances');
    expect(s).toContain('"location":[1,2,3]');
    expect(s).toContain('"scale":[1,1,1]'); // default filled
  });

  it('IS classified NON_IDEMPOTENT (append)', () => {
    expect(NON_IDEMPOTENT.has('foliage_add_instances')).toBe(true);
  });
});

describe('foliage_scatter_paint', () => {
  it('ground-traces, is deterministic by seed', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, painted: 4, skipped_no_hit: 0, seed: 42 }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageScatterPaintDescriptor)({
      foliage_type_path: '/Game/FT',
      center: [0, 0, 0],
      radius: 500,
      density_per_100m2: 2,
      seed: 42,
    });
    const s = lastScript();
    expect(s).toContain('line_trace_single');
    expect(s).toContain('random.Random(_seed)');
    expect(s).toContain('_seed = 42');
    expect(s).toContain('skipped_no_hit');
  });

  it('IS classified NON_IDEMPOTENT (append)', () => {
    expect(NON_IDEMPOTENT.has('foliage_scatter_paint')).toBe(true);
  });

  it('precomputes and emits the exact maximum bounded candidate count', async () => {
    const { sender, lastScript } = mockStdout(
      emit({ ok: true, painted: 0, candidates: FOLIAGE_SCATTER_WORK_LIMITS.maxCandidates }),
    );
    setDefaultSender(sender);
    const densityAtExactMax = FOLIAGE_SCATTER_WORK_LIMITS.maxCandidates / Math.PI;

    const result = await makePyToolHandler(foliageScatterPaintDescriptor)({
      foliage_type_path: '/Game/FT',
      center: [0, 0, 0],
      radius: 100,
      density_per_100m2: densityAtExactMax,
    });

    expect(result.isError).toBeUndefined();
    expect(lastScript()).toContain(`_candidate_count = ${FOLIAGE_SCATTER_WORK_LIMITS.maxCandidates}`);
    expect(lastScript()).toContain('n = _candidate_count');
    expect(lastScript()).not.toContain('area_cells =');
  });

  it('refuses hostile, fractional and max+1 workloads with zero UE transport', async () => {
    let transportCalls = 0;
    setDefaultSender((async () => {
      transportCalls += 1;
      throw new Error('UE transport must not run for refused work');
    }) as Sender);
    const handler = makePyToolHandler(foliageScatterPaintDescriptor);
    const base = {
      foliage_type_path: '/Game/FT',
      center: [0, 0, 0],
      radius: 100,
      density_per_100m2: 1,
    };
    const refused: Array<{
      name: string;
      params: Record<string, unknown>;
      fact: string;
      alternative: string;
    }> = [
      {
        name: 'derived candidate max+1',
        params: { ...base, density_per_100m2: (FOLIAGE_SCATTER_WORK_LIMITS.maxCandidates + 1) / Math.PI },
        fact: `limit is ${FOLIAGE_SCATTER_WORK_LIMITS.maxCandidates}`,
        alternative: 'split the area into non-overlapping chunks',
      },
      {
        name: 'radius max+1',
        params: { ...base, radius: FOLIAGE_SCATTER_WORK_LIMITS.maxRadius + 1 },
        fact: `radius must be > 0 and <= ${FOLIAGE_SCATTER_WORK_LIMITS.maxRadius}`,
        alternative: 'positive radius inside that limit',
      },
      {
        name: 'zero radius',
        params: { ...base, radius: 0 },
        fact: `radius must be > 0 and <= ${FOLIAGE_SCATTER_WORK_LIMITS.maxRadius}`,
        alternative: 'positive radius inside that limit',
      },
      {
        name: 'density max+1',
        params: { ...base, density_per_100m2: FOLIAGE_SCATTER_WORK_LIMITS.maxDensityPer100m2 + 1 },
        fact: `density_per_100m2 must be > 0 and <= ${FOLIAGE_SCATTER_WORK_LIMITS.maxDensityPer100m2}`,
        alternative: 'submit smaller regions',
      },
      {
        name: 'zero density',
        params: { ...base, density_per_100m2: 0 },
        fact: `density_per_100m2 must be > 0 and <= ${FOLIAGE_SCATTER_WORK_LIMITS.maxDensityPer100m2}`,
        alternative: 'positive density inside that limit',
      },
      {
        name: 'overflow-sized radius',
        params: { ...base, radius: Number.MAX_VALUE },
        fact: `radius must be > 0 and <= ${FOLIAGE_SCATTER_WORK_LIMITS.maxRadius}`,
        alternative: 'split a larger area',
      },
      {
        name: 'non-finite radius',
        params: { ...base, radius: Number.POSITIVE_INFINITY },
        fact: 'radius must be a finite number',
        alternative: 'split a larger area',
      },
      {
        name: 'non-finite density',
        params: { ...base, density_per_100m2: Number.NaN },
        fact: 'density_per_100m2 must be a finite number',
        alternative: 'submit smaller regions',
      },
      {
        name: 'non-finite center',
        params: { ...base, center: [0, Number.POSITIVE_INFINITY, 0] },
        fact: 'center coordinates must be a finite number',
        alternative: 'Use finite coordinates',
      },
      {
        name: 'center range max+1',
        params: { ...base, center: [FOLIAGE_SCATTER_WORK_LIMITS.maxAbsWorldCoordinate + 1, 0, 0] },
        fact: `center coordinates must be within +/-${FOLIAGE_SCATTER_WORK_LIMITS.maxAbsWorldCoordinate}`,
        alternative: 'Move the center',
      },
      {
        name: 'fractional seed',
        params: { ...base, seed: 1.5 },
        fact: 'seed must be an integer',
        alternative: 'signed 32-bit integer seed',
      },
      {
        name: 'non-finite seed',
        params: { ...base, seed: Number.POSITIVE_INFINITY },
        fact: 'seed must be a finite number',
        alternative: 'signed 32-bit integer seed',
      },
      {
        name: 'seed max+1',
        params: { ...base, seed: FOLIAGE_SCATTER_WORK_LIMITS.maxSeed + 1 },
        fact: `seed must be an integer in [${FOLIAGE_SCATTER_WORK_LIMITS.minSeed}, ${FOLIAGE_SCATTER_WORK_LIMITS.maxSeed}]`,
        alternative: 'signed 32-bit integer seed',
      },
      {
        name: 'unordered scale interval',
        params: { ...base, scale_min: 2, scale_max: 1 },
        fact: '0 < scale_min <= scale_max',
        alternative: 'smaller ordered scale interval',
      },
      {
        name: 'scale range max+1',
        params: { ...base, scale_max: FOLIAGE_SCATTER_WORK_LIMITS.maxScale + 1 },
        fact: `scale_max must be > 0 and <= ${FOLIAGE_SCATTER_WORK_LIMITS.maxScale}`,
        alternative: 'positive finite scale',
      },
      {
        name: 'zero minimum scale',
        params: { ...base, scale_min: 0 },
        fact: `scale_min must be > 0 and <= ${FOLIAGE_SCATTER_WORK_LIMITS.maxScale}`,
        alternative: 'positive finite scale',
      },
      {
        name: 'non-finite maximum scale',
        params: { ...base, scale_max: Number.POSITIVE_INFINITY },
        fact: 'scale_max must be a finite number',
        alternative: 'positive finite scale',
      },
      {
        name: 'non-finite scale',
        params: { ...base, scale_min: Number.NaN },
        fact: 'scale_min must be a finite number',
        alternative: 'positive finite scale',
      },
      {
        name: 'zero trace height',
        params: { ...base, trace_height: 0 },
        fact: `trace_height must be > 0 and <= ${FOLIAGE_SCATTER_WORK_LIMITS.maxTraceHeight}`,
        alternative: 'positive finite trace',
      },
      {
        name: 'trace height max+1',
        params: { ...base, trace_height: FOLIAGE_SCATTER_WORK_LIMITS.maxTraceHeight + 1 },
        fact: `trace_height must be > 0 and <= ${FOLIAGE_SCATTER_WORK_LIMITS.maxTraceHeight}`,
        alternative: 'positive finite trace',
      },
      {
        name: 'non-finite trace height',
        params: { ...base, trace_height: Number.POSITIVE_INFINITY },
        fact: 'trace_height must be a finite number',
        alternative: 'positive finite trace',
      },
    ];

    for (const refusal of refused) {
      const result = await handler(refusal.params);
      expect(result.isError, refusal.name).toBe(true);
      const error = JSON.parse(result.content[0]!.text) as { error: string };
      expect(error.error, refusal.name).toContain('bounded_work_limit');
      expect(error.error, refusal.name).toContain(refusal.fact);
      expect(error.error, refusal.name).toContain(refusal.alternative);
      expect(error.error, refusal.name).toContain('no Unreal request was sent');
    }
    expect(transportCalls).toBe(0);
  });
});

describe('foliage_remove_in_bounds', () => {
  it('builds a box and calls remove_instances', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, removed: 2 }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageRemoveInBoundsDescriptor)({
      foliage_type_path: '/Game/FT',
      center: [0, 0, 0],
      extent: [100, 100, 100],
    });
    const s = lastScript();
    expect(s).toContain('remove_instances');
    expect(s).toContain('_c = [0,0,0]');
  });

  it('IS classified NON_IDEMPOTENT (delete)', () => {
    expect(NON_IDEMPOTENT.has('foliage_remove_in_bounds')).toBe(true);
  });
});

describe('foliage_clear_type', () => {
  it('requires confirm:true', async () => {
    const missing = await makePyToolHandler(foliageClearTypeDescriptor)({ foliage_type_path: '/Game/FT' });
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, removed: 9 }));
    setDefaultSender(sender);
    await makePyToolHandler(foliageClearTypeDescriptor)({ foliage_type_path: '/Game/FT', confirm: true });
    expect(lastScript()).toContain('remove_instances');
  });

  it('IS classified NON_IDEMPOTENT (destructive)', () => {
    expect(NON_IDEMPOTENT.has('foliage_clear_type')).toBe(true);
  });
});

describe('foliage-domain factory catalog', () => {
  it('exports 11 net-new tools with unique names', () => {
    const names = foliagePyDescriptors.map((d) => d.name);
    expect(names).toHaveLength(11);
    expect(new Set(names).size).toBe(11);
  });

  it('every tool has a structured returns doc and a timeout', () => {
    for (const d of foliagePyDescriptors) {
      expect(d.returns).toContain('ok');
      expect(d.timeoutMs).toBeGreaterThanOrEqual(30_000);
    }
  });

  it('declares exactly five non-idempotent tools', () => {
    expect([...FOLIAGE_NON_IDEMPOTENT].sort()).toEqual(
      [
        'foliage_add_instances',
        'foliage_clear_type',
        'foliage_remove_in_bounds',
        'foliage_scatter_paint',
        'foliage_type_create',
      ].sort(),
    );
  });

  it('every generated script carries the _err path', async () => {
    for (const d of foliagePyDescriptors) {
      const { sender, lastScript } = mockStdout(emit({ ok: true }));
      setDefaultSender(sender);
      const params: Record<string, unknown> = {};
      if (d.name !== 'foliage_capability_probe' && d.name !== 'foliage_scan_types')
        params.foliage_type_path = '/Game/FT';
      if (d.name === 'foliage_type_set_params') params.density = 1;
      if (d.name === 'foliage_replace_mesh') params.new_mesh_path = '/Game/SM';
      if (d.name === 'foliage_type_create') {
        params.static_mesh_path = '/Game/SM';
        params.dest_path = '/Game/F';
        params.name = 'FT';
      }
      if (d.name === 'foliage_add_instances') params.transforms = [{ location: [0, 0, 0] }];
      if (d.name === 'foliage_scatter_paint') {
        params.center = [0, 0, 0];
        params.radius = 100;
        params.density_per_100m2 = 1;
      }
      if (d.name === 'foliage_remove_in_bounds') {
        params.center = [0, 0, 0];
        params.extent = [1, 1, 1];
      }
      if (d.name === 'foliage_clear_type') params.confirm = true;
      await makePyToolHandler(d)(params);
      expect(lastScript()).toContain('_err(_e)');
    }
  });
});
