import { describe, it, expect, beforeEach } from 'vitest';
import { makePyToolHandler } from '../py-tool-factory.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from '../tool-executor.js';
import {
  niagaraCapabilityProbeDescriptor,
  niagaraSystemsDescriptor,
  niagaraSystemInspectDescriptor,
  niagaraParamListDescriptor,
  niagaraSpawnTransientDescriptor,
  niagaraPlaceActorDescriptor,
  niagaraParamSetDescriptor,
  niagaraSetUserParamDefaultDescriptor,
  niagaraComponentInspectDescriptor,
  niagaraListComponentsDescriptor,
  niagaraActivateDescriptor,
  niagaraAdvanceSimulationDescriptor,
  niagaraValidateDescriptor,
  niagaraCreateFromTemplateDescriptor,
  niagaraPyDescriptors,
  NIAGARA_NON_IDEMPOTENT,
} from './niagara-py-tools.js';

// Canned-stdout sender driving the HAYBA_JSON parse path; captures the last
// script so we can assert on generated python (mirrors sequencer-py-tools.test.ts).
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

describe('niagara_capability_probe', () => {
  it('probes classes, spawn entry points and setter list', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, niagara_available: true, capabilities: {} }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraCapabilityProbeDescriptor)({});
    const s = lastScript();
    expect(s).toContain('NiagaraSystem');
    expect(s).toContain('spawn_system_at_location');
    expect(s).toContain('component_setters');
  });
});

describe('niagara_systems', () => {
  it('queries the AssetRegistry filtering NiagaraSystem with pagination', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, systems: [], count: 0, has_more: false, next_offset: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraSystemsDescriptor)({});
    const s = lastScript();
    expect(s).toContain('get_asset_registry');
    expect(s).toContain('NiagaraSystem');
    expect(s).toContain('next_offset');
  });
});

describe('niagara_system_inspect', () => {
  it('probes emitters and user params defensively and surfaces warnings', async () => {
    const missing = await makePyToolHandler(niagaraSystemInspectDescriptor)({});
    expect(missing.isError).toBe(true);
    const { sender, lastScript } = mockStdout(emit({ ok: true, system_path: '/Game/VFX/NS', emitters: [], user_params: [], warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraSystemInspectDescriptor)({ system_path: '/Game/VFX/NS' });
    const s = lastScript();
    expect(s).toContain('_emitters(sys)');
    expect(s).toContain('_user_params(sys)');
    expect(s).toContain('effect_type');
    expect(s).toContain('warnings');
  });
});

describe('niagara_param_list', () => {
  it('lists exposed user params with warnings surface', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, system_path: '/Game/NS', user_params: [], count: 0, warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraParamListDescriptor)({ system_path: '/Game/NS' });
    const s = lastScript();
    expect(s).toContain('_user_params(sys)');
    expect(s).toContain('warnings');
  });
});

describe('niagara_spawn_transient', () => {
  it('embeds transform + flags and calls spawn_system_at_location', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, component_path: '/x', spawned_path: '/Game/NS' }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraSpawnTransientDescriptor)({
      system_path: '/Game/NS', location: [1, 2, 3], auto_destroy: true,
    });
    const s = lastScript();
    expect(s).toContain('spawn_system_at_location');
    expect(s).toContain('_loc = [1, 2, 3]');
    expect(s).toContain('_ad = True');
  });

  it('supports dry_run without spawning', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, dry_run: true, system_path: '/Game/NS' }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraSpawnTransientDescriptor)({ system_path: '/Game/NS', dry_run: true });
    expect(lastScript()).toContain('_dry = True');
  });
});

describe('niagara_place_actor', () => {
  it('spawns a persistent NiagaraActor and surfaces an asset-assigned set-success flag', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, actor_path: '/a', asset_assigned: true, warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraPlaceActorDescriptor)({ system_path: '/Game/NS', location: [0, 0, 0] });
    const s = lastScript();
    expect(s).toContain('NiagaraActor');
    expect(s).toContain('spawn_actor_from_class');
    expect(s).toContain('asset_assigned');
    // ok reflects the set-success flag, not an unconditional True
    expect(s).toContain('"ok": bool(asset_set)');
  });
});

describe('niagara_param_set', () => {
  it('validates value_type enum', async () => {
    const bad = await makePyToolHandler(niagaraParamSetDescriptor)({
      component: '/c', param_name: 'User.Color', value_type: 'bogus', value: 1,
    });
    expect(bad.isError).toBe(true);
  });

  it('surfaces a set-success flag (applied) and never reports ok:true on an unapplied set', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: false, applied: false, warnings: ['no setter'] }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraParamSetDescriptor)({
      component: '/c', param_name: 'User.Rate', value_type: 'float', value: 2.5,
    });
    const s = lastScript();
    expect(s).toContain('applied = _apply_var(comp, _name, _vt, _val)');
    // ok is bound to the applied flag — the W4T1 no-silent-partial-success rule
    expect(s).toContain('"ok": bool(applied)');
    expect(s).toContain('"applied": bool(applied)');
    expect(s).toContain('value NOT applied');
  });

  it('embeds vector values via json.loads', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, applied: true, warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraParamSetDescriptor)({
      component: '/c', param_name: 'User.Vel', value_type: 'vec3', value: [1, 0, 0],
    });
    expect(lastScript()).toContain('_val = json.loads(');
  });
});

describe('niagara_set_user_param_default', () => {
  it('surfaces applied set-success flag and optional save', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, applied: true, saved: true, warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraSetUserParamDefaultDescriptor)({
      system_path: '/Game/NS', param_name: 'User.Rate', value_type: 'float', value: 3, save: true,
    });
    const s = lastScript();
    expect(s).toContain('"ok": bool(applied)');
    expect(s).toContain('"applied": bool(applied)');
    expect(s).toContain('save_asset');
  });
});

describe('niagara_component_inspect', () => {
  it('reads active/paused/system for a live component', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, component_path: '/c', active: true }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraComponentInspectDescriptor)({ component: '/c' });
    const s = lastScript();
    expect(s).toContain('is_active');
    expect(s).toContain('is_paused');
    expect(s).toContain('system_path');
  });
});

describe('niagara_list_components', () => {
  it('enumerates level actors with filter + pagination', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, components: [], count: 0, has_more: false, next_offset: 0 }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraListComponentsDescriptor)({ system_filter: 'Fire', active_only: true });
    const s = lastScript();
    expect(s).toContain('get_all_level_actors');
    expect(s).toContain('NiagaraComponent');
    expect(s).toContain('_active_only = True');
    expect(s).toContain("_filter = 'Fire'");
  });
});

describe('niagara_activate', () => {
  it('surfaces applied set-success flag and probes activate/deactivate', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, active: true, applied: true, warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraActivateDescriptor)({ component: '/c', reset: true });
    const s = lastScript();
    expect(s).toContain('comp.activate');
    expect(s).toContain('"ok": bool(done)');
    expect(s).toContain('"applied": bool(done)');
  });
});

describe('niagara_advance_simulation', () => {
  it('embeds seconds/dt and probes advance_simulation arg order', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, advanced_seconds: 1, applied: true, warnings: [] }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraAdvanceSimulationDescriptor)({ component: '/c', seconds: 1, tick_dt: 0.0167 });
    const s = lastScript();
    expect(s).toContain('advance_simulation');
    expect(s).toContain('_secs = 1');
    expect(s).toContain('"applied": bool(done)');
  });
});

describe('niagara_validate', () => {
  it('flags gpu-without-fixed-bounds and missing effect type', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, system_path: '/Game/NS', violations: [], fixed: [] }));
    setDefaultSender(sender);
    const res = await makePyToolHandler(niagaraValidateDescriptor)({ system_path: '/Game/NS' });
    expect(res.isError).toBeUndefined();
    const s = lastScript();
    expect(s).toContain('gpu_without_fixed_bounds');
    expect(s).toContain('missing_effect_type');
    expect(s).toContain('no_emitters');
  });
});

describe('niagara_create_from_template', () => {
  it('duplicates a template with an engine-limit note', async () => {
    const { sender, lastScript } = mockStdout(emit({ ok: true, new_system_path: '/Game/VFX/NS2', created: true, note: 'x' }));
    setDefaultSender(sender);
    await makePyToolHandler(niagaraCreateFromTemplateDescriptor)({
      template_path: '/Game/NS', dest_path: '/Game/VFX', name: 'NS2',
    });
    const s = lastScript();
    expect(s).toContain('duplicate_asset');
    expect(s).toContain('UE Python limit');
  });
});

describe('niagara-domain factory catalog', () => {
  it('exports 14 tools with unique names', () => {
    const names = niagaraPyDescriptors.map((d) => d.name);
    expect(names).toHaveLength(14);
    expect(new Set(names).size).toBe(14);
  });

  it('every tool has a 30s timeout and structured returns', () => {
    for (const d of niagaraPyDescriptors) {
      expect(d.timeoutMs).toBe(30_000);
      expect(d.returns).toContain('ok');
    }
  });

  it('uses names that do NOT collide with the C++ HaybaMCPNiagara commands', () => {
    const cpp = new Set(['niagara_list', 'niagara_spawn', 'niagara_set_param']);
    for (const d of niagaraPyDescriptors) {
      expect(cpp.has(d.name)).toBe(false);
    }
  });

  it('classifies spawn/place/create + cumulative advance_simulation NON_IDEMPOTENT', () => {
    expect([...NIAGARA_NON_IDEMPOTENT].sort()).toEqual(
      ['niagara_advance_simulation', 'niagara_create_from_template', 'niagara_place_actor', 'niagara_spawn_transient'],
    );
    for (const name of NIAGARA_NON_IDEMPOTENT) {
      expect(NON_IDEMPOTENT.has(name)).toBe(true);
    }
  });

  it('does NOT classify set-to-value / read tools as non-idempotent', () => {
    for (const name of [
      'niagara_param_set', 'niagara_set_user_param_default', 'niagara_activate',
      'niagara_systems', 'niagara_system_inspect',
      'niagara_param_list', 'niagara_component_inspect', 'niagara_list_components',
      'niagara_validate', 'niagara_capability_probe',
    ]) {
      expect(NON_IDEMPOTENT.has(name)).toBe(false);
    }
  });
});
