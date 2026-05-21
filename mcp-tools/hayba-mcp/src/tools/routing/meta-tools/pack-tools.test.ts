import { describe, it, expect, vi } from 'vitest';
import { PackRegistry, type PackDef } from '../pack-registry.js';
import { packListHandler } from './pack-list.js';
import { packLoadHandler } from './pack-load.js';

const fixture: PackDef[] = [
  { name: 'biome', kind: 'workflow', description: 'b', tools: ['create_pcg_graph'] },
];

describe('pack meta-tools', () => {
  it('pack_list returns loaded flag and toolCount', async () => {
    const reg = new PackRegistry(fixture, vi.fn());
    const res = await packListHandler({}, { registry: reg });
    expect(res.packs[0]).toMatchObject({ name: 'biome', loaded: false, toolCount: 1 });
  });

  it('pack_load happy path returns addedTools', async () => {
    const reg = new PackRegistry(fixture, vi.fn());
    const res = await packLoadHandler({ name: 'biome' }, { registry: reg });
    expect(res).toEqual({ ok: true, addedTools: ['create_pcg_graph'] });
  });

  it('pack_load unknown returns ok:false with available list', async () => {
    const reg = new PackRegistry(fixture, vi.fn());
    const res = await packLoadHandler({ name: 'nope' }, { registry: reg });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.available).toEqual(['biome']);
  });
});
