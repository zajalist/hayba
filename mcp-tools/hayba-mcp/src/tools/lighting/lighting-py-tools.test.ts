import { describe, it, expect, beforeEach } from 'vitest';
import { makePyToolHandler } from '../py-tool-factory.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from '../tool-executor.js';
import {
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
  lightingPyDescriptors,
  LIGHTING_NON_IDEMPOTENT,
} from './lighting-py-tools.js';

// Canned-stdout sender driving the HAYBA_JSON parse path; captures the last script
// so we can assert on generated python (mirrors foliage-py-tools.test.ts).
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

describe('lighting_capability_probe', () => {
  it('reports light/PP bindings', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, capabilities: {} }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(lightingCapabilityProbeDescriptor)({});
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('has_directional_light');
    expect(s).toContain('has_post_process_volume');
    expect(s).toContain('_light_comp');
  });
});

describe('light_list', () => {
  it('enumerates lights with pagination', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, lights: [], total: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(lightListDescriptor)({ limit: 25, offset: 5 });
    const s = lastScript();
    expect(s).toContain('_limit = 25');
    expect(s).toContain('_offset = 5');
    expect(s).toContain('_light_read');
  });
});

describe('light_get', () => {
  it('requires an actor_id and reads the light component', async () => {
    const missing = await makePyToolHandler(lightGetDescriptor)({});
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, intensity: 1 }));
    setDefaultSender(sender);
    await makePyToolHandler(lightGetDescriptor)({ actor_id: 'Sun' });
    const s = lastScript();
    expect(s).toContain("_ref = 'Sun'");
    expect(s).toContain('_light_comp');
  });
});

describe('postprocess_list_volumes', () => {
  it('enumerates PPVs', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, volumes: [], total: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(postprocessListVolumesDescriptor)({});
    expect(lastScript()).toContain('_ppvs');
  });
});

describe('postprocess_get', () => {
  it('reads values AND override flags', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, values: {}, overrides: {} }));
    setDefaultSender(sender);
    await makePyToolHandler(postprocessGetDescriptor)({});
    const s = lastScript();
    expect(s).toContain('_resolve_ppv');
    expect(s).toContain('"override_" + f');
    expect(s).toContain('overrides');
  });
});

describe('light_set', () => {
  it('guards "at least one property"', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, changed_keys: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(lightSetDescriptor)({ actor_id: 'Sun' });
    expect(lastScript()).toContain('provide at least one property');
  });

  it('emits set logic + temperature auto-enables use_temperature', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, changed_keys: ['intensity'] }));
    setDefaultSender(sender);
    await makePyToolHandler(lightSetDescriptor)({ actor_id: 'Sun', intensity: 5, temperature: 6500, color: [255, 200, 150] });
    const s = lastScript();
    expect(s).toContain('_intensity = 5');
    expect(s).toContain('_temp = 6500');
    expect(s).toContain('use_temperature');
    expect(s).toContain('_mk_color');
  });

  it('is NOT classified NON_IDEMPOTENT (set-to-value)', () => {
    expect(NON_IDEMPOTENT.has('light_set')).toBe(false);
  });
});

describe('postprocess_set', () => {
  it('requires at least one field', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, changed_keys: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(postprocessSetDescriptor)({});
    expect(lastScript()).toContain('provide at least one post-process field');
  });

  it('sets the bOverride_ flag alongside the value AND writes the struct back', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, changed_keys: ['bloom_intensity'] }));
    setDefaultSender(sender);
    await makePyToolHandler(postprocessSetDescriptor)({ bloom_intensity: 2, vignette_intensity: 0.4 });
    const s = lastScript();
    expect(s).toContain('_bloom = 2');
    // the key bOverride_ gotcha: override flag set alongside the value
    expect(s).toContain('_pp_apply(s, val, f, "override_" + f)');
    expect(s).toContain('_set(s, True, oprop)'); // _pp_apply helper flips the override bool
    // and the mutated struct copy is written back to the actor
    expect(s).toContain('_pp_write(ppv, s)');
  });

  it('is NOT classified NON_IDEMPOTENT (set-to-value)', () => {
    expect(NON_IDEMPOTENT.has('postprocess_set')).toBe(false);
  });
});

describe('exposure_set', () => {
  it('maps method + sets override flags', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, changed_keys: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(exposureSetDescriptor)({ method: 'histogram', bias: 1.5 });
    const s = lastScript();
    expect(s).toContain("_method = 'histogram'");
    expect(s).toContain('AutoExposureMethod');
    expect(s).toContain('override_auto_exposure_bias');
    expect(s).toContain('_pp_write(ppv, s)');
  });
});

describe('lumen_configure', () => {
  it('toggles GI/reflections via enums with override flags', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, changed_keys: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(lumenConfigureDescriptor)({ gi_enabled: true, reflections_enabled: false, max_trace_distance: 10000 });
    const s = lastScript();
    expect(s).toContain('DynamicGlobalIlluminationMethod');
    expect(s).toContain('ReflectionMethod');
    expect(s).toContain('override_dynamic_global_illumination_method');
    expect(s).toContain('override_lumen_max_trace_distance');
  });
});

describe('color_grading_set', () => {
  it('builds Vector4s with override flags', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, changed_keys: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(colorGradingSetDescriptor)({ saturation: 1.2, white_temp: 6500 });
    const s = lastScript();
    expect(s).toContain('_sat = 1.2');
    expect(s).toContain('Vector4');
    expect(s).toContain('color_saturation');
    expect(s).toContain('_pp_apply(s, v4, key, "override_" + key)'); // override flag for color ranges
    expect(s).toContain('override_white_temp');
  });
});

describe('fog_configure', () => {
  it('sets fog component props', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, changed_keys: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(fogConfigureDescriptor)({ density: 0.02, volumetric: true });
    const s = lastScript();
    expect(s).toContain('ExponentialHeightFog');
    expect(s).toContain('fog_density');
    expect(s).toContain('volumetric_fog');
  });

  it('is NOT classified NON_IDEMPOTENT (set-to-value)', () => {
    expect(NON_IDEMPOTENT.has('fog_configure')).toBe(false);
  });
});

describe('light_spawn', () => {
  it('requires light_type and spawns from the mapped class', async () => {
    const missing = await makePyToolHandler(lightSpawnDescriptor)({});
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_id: 'PointLight' }));
    setDefaultSender(sender);
    await makePyToolHandler(lightSpawnDescriptor)({ light_type: 'point', intensity: 5000 });
    const s = lastScript();
    expect(s).toContain("_type = 'point'");
    expect(s).toContain('spawn_actor_from_class');
    expect(s).toContain('PointLight');
  });

  it('IS classified NON_IDEMPOTENT (actor-create)', () => {
    expect(NON_IDEMPOTENT.has('light_spawn')).toBe(true);
    expect(LIGHTING_NON_IDEMPOTENT).toContain('light_spawn');
  });
});

describe('postprocess_spawn_volume', () => {
  it('spawns a PPV and sets unbound by default', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_id: 'PP' }));
    setDefaultSender(sender);
    await makePyToolHandler(postprocessSpawnVolumeDescriptor)({});
    const s = lastScript();
    expect(s).toContain('PostProcessVolume');
    expect(s).toContain('_unbound = True');
    expect(s).toContain('_set(actor, _unbound, "unbound")');
  });

  it('IS classified NON_IDEMPOTENT (actor-create)', () => {
    expect(NON_IDEMPOTENT.has('postprocess_spawn_volume')).toBe(true);
  });
});

describe('sky_setup', () => {
  it('spawns the sun/skylight/atmosphere triad', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, spawned: {} }));
    setDefaultSender(sender);
    await makePyToolHandler(skySetupDescriptor)({});
    const s = lastScript();
    expect(s).toContain('DirectionalLight');
    expect(s).toContain('SkyLight');
    expect(s).toContain('SkyAtmosphere');
  });

  it('IS classified NON_IDEMPOTENT (multi-actor spawn)', () => {
    expect(NON_IDEMPOTENT.has('sky_setup')).toBe(true);
  });
});

describe('lighting-domain factory catalog', () => {
  it('exports 14 net-new tools with unique names', () => {
    const names = lightingPyDescriptors.map((d) => d.name);
    expect(names).toHaveLength(14);
    expect(new Set(names).size).toBe(14);
  });

  it('every tool has a structured returns doc and a timeout', () => {
    for (const d of lightingPyDescriptors) {
      expect(d.returns).toContain('ok');
      expect(d.timeoutMs).toBeGreaterThanOrEqual(30_000);
    }
  });

  it('declares exactly three non-idempotent tools', () => {
    expect([...LIGHTING_NON_IDEMPOTENT].sort()).toEqual(
      ['light_spawn', 'postprocess_spawn_volume', 'sky_setup'].sort(),
    );
  });

  it('every generated script carries the _err path', async () => {
    for (const d of lightingPyDescriptors) {
      const { sender, lastScript } = mockStdout(emit({ ok: true }));
      setDefaultSender(sender);
      const params: Record<string, unknown> = {};
      if (d.name === 'light_get') params.actor_id = 'Sun';
      if (d.name === 'light_set') { params.actor_id = 'Sun'; params.intensity = 1; }
      if (d.name === 'postprocess_set') params.bloom_intensity = 1;
      if (d.name === 'exposure_set') params.bias = 1;
      if (d.name === 'lumen_configure') params.gi_enabled = true;
      if (d.name === 'color_grading_set') params.saturation = 1;
      if (d.name === 'fog_configure') params.density = 1;
      if (d.name === 'light_spawn') params.light_type = 'point';
      await makePyToolHandler(d)(params);
      expect(lastScript()).toContain('_err(_e)');
    }
  });
});
