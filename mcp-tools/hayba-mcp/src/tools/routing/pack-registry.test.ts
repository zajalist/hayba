import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PackRegistry, type PackDef, type OnPacksChanged } from './pack-registry.js';

const fixture: PackDef[] = [
  { name: 'actor',  kind: 'domain',   description: 'd', tools: ['actor_spawn', 'actor_list'] },
  { name: 'biome',  kind: 'workflow', description: 'd', tools: ['actor_spawn', 'create_pcg_graph'] },
  { name: 'editor', kind: 'workflow', description: 'd', tools: ['editor_capture_viewport'], autoLoadOn: 'ue_connected' },
];

describe('PackRegistry', () => {
  let reg: PackRegistry;
  // Typed explicitly: vitest 4 infers vi.fn() as Mock<Constructable | Procedure>,
  // which is not assignable to a plain () => void | Promise<void>.
  let onChange: OnPacksChanged;

  beforeEach(() => {
    onChange = vi.fn<OnPacksChanged>();
    reg = new PackRegistry(fixture, onChange);
  });

  it('lists packs with loaded flag false initially', () => {
    const list = reg.listPacks();
    expect(list.find(p => p.name === 'actor')?.loaded).toBe(false);
  });

  it('loadPack returns added tools and fires onChange', async () => {
    const r = await reg.loadPack('biome');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.addedTools.sort()).toEqual(['actor_spawn', 'create_pcg_graph']);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('loadPack is idempotent (no double-add)', async () => {
    await reg.loadPack('biome');
    const r2 = await reg.loadPack('biome');
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.addedTools).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('loadPack on unknown pack returns ok:false + available list', async () => {
    const r = await reg.loadPack('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.available).toContain('biome');
  });

  it('maybeAutoLoad("ue_connected") loads editor pack', async () => {
    await reg.maybeAutoLoad('ue_connected');
    expect(reg.isLoaded('editor')).toBe(true);
  });

  it('loadedTools returns union of loaded packs', async () => {
    await reg.loadPack('biome');
    await reg.loadPack('actor');
    expect(reg.loadedTools().sort()).toEqual(['actor_list', 'actor_spawn', 'create_pcg_graph']);
  });
});
