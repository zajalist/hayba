import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as h from './architecture-handlers.js';

function defaultsFixture() {
  return {
    roofType: 'gabled',
    proportions: { columnSlenderness: 1, storyHeight: 1, doorAspect: 1 },
    palette: ['#aaaaaa'],
    ornamentDensity: 'moderate' as const,
    technique: '',
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-'));
  h.__setDataRoot(root);
});

describe('architecture mcp handlers', () => {
  it('create_culture + get_culture round-trip', async () => {
    await h.architecture_create_culture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    const c = await h.architecture_get_culture({ id: 'a' });
    expect(c.id).toBe('a');
    expect(c.materials.length).toBeGreaterThan(0); // seeded from presets
  });

  it('list_cultures returns created culture', async () => {
    await h.architecture_create_culture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    const list = await h.architecture_list_cultures({});
    expect(list).toEqual([{ id: 'a', name: 'A', eraCount: 0 }]);
  });

  it('add_era / update_era / delete_era round-trip', async () => {
    await h.architecture_create_culture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    await h.architecture_add_era({ cultureId: 'a', era: { id: 'e1', name: 'E1', dateRange: [0, 100], defaults: defaultsFixture(), typologyMix: {}, rules: [] } });
    await h.architecture_update_era({ cultureId: 'a', eraId: 'e1', partial: { name: 'E1b' } });
    const c = await h.architecture_get_culture({ id: 'a' });
    expect(c.eras[0].name).toBe('E1b');
    await h.architecture_delete_era({ cultureId: 'a', eraId: 'e1' });
    expect((await h.architecture_get_culture({ id: 'a' })).eras).toEqual([]);
  });

  it('add_material persists', async () => {
    await h.architecture_create_culture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    await h.architecture_add_material({ cultureId: 'a', material: { id: 'sandstone-2', name: 'Sandstone 2', color: '#aaaaaa', grain: '', properties: { durability: 0.5, cost: 0.5, workability: 0.5 } } });
    const c = await h.architecture_get_culture({ id: 'a' });
    expect(c.materials.some(m => m.id === 'sandstone-2')).toBe(true);
  });

  it('add_ornament + update_ornament + delete_ornament', async () => {
    await h.architecture_create_culture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    await h.architecture_add_ornament({ cultureId: 'a', ornament: { id: 'spiral-x', name: 'Spiral X', description: '', referenceImagePaths: [], scenarioWeights: {} } });
    await h.architecture_update_ornament({ cultureId: 'a', ornamentId: 'spiral-x', partial: { name: 'Spiral X v2' } });
    const c = await h.architecture_get_culture({ id: 'a' });
    expect(c.ornaments.find(o => o.id === 'spiral-x')?.name).toBe('Spiral X v2');
    await h.architecture_delete_ornament({ cultureId: 'a', ornamentId: 'spiral-x' });
    expect((await h.architecture_get_culture({ id: 'a' })).ornaments.some(o => o.id === 'spiral-x')).toBe(false);
  });

  it('add_tag_axis persists', async () => {
    await h.architecture_create_culture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    await h.architecture_add_tag_axis({ cultureId: 'a', axis: { id: 'religion', label: 'Religion', values: [{ id: 'pagan', label: 'Pagan' }, { id: 'christian', label: 'Christian' }] } });
    expect((await h.architecture_get_culture({ id: 'a' })).tagAxes.some(a => a.id === 'religion')).toBe(true);
  });

  it('add_rule culture-scope vs era-scope', async () => {
    await h.architecture_create_culture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    await h.architecture_add_era({ cultureId: 'a', era: { id: 'e1', name: 'E1', dateRange: [0, 100], defaults: defaultsFixture(), typologyMix: {}, rules: [] } });
    await h.architecture_add_rule({ cultureId: 'a', rule: { id: 'r-culture', priority: 10, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'limestone' } }, scope: 'culture' });
    await h.architecture_add_rule({ cultureId: 'a', rule: { id: 'r-era', priority: 5, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'mudbrick' } }, scope: { era: 'e1' } });
    const c = await h.architecture_get_culture({ id: 'a' });
    expect(c.rules.some(r => r.id === 'r-culture')).toBe(true);
    expect(c.eras[0].rules.some(r => r.id === 'r-era')).toBe(true);
  });

  it('resolve_rules returns rule assigns', async () => {
    await h.architecture_create_culture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    await h.architecture_add_era({ cultureId: 'a', era: { id: 'e1', name: 'E1', dateRange: [0, 100], defaults: defaultsFixture(), typologyMix: {}, rules: [] } });
    await h.architecture_add_rule({ cultureId: 'a', rule: { id: 'r1', priority: 10, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'limestone' } }, scope: 'culture' });
    const r = await h.architecture_resolve_rules({ cultureId: 'a', eraId: 'e1', scenario: 'temple', tagState: {} });
    expect(r.materialId).toBe('limestone');
  });

  it('validate_culture surfaces issues', async () => {
    await h.architecture_create_culture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    await h.architecture_add_rule({ cultureId: 'a', rule: { id: 'r1', priority: 1, conditions: { tagMatches: { ghost: 'x' } }, assigns: {} }, scope: 'culture' });
    const v = await h.architecture_validate_culture({ id: 'a' });
    expect(v.ok).toBe(false);
  });

  it('update_culture top-level merge replaces arrays', async () => {
    await h.architecture_create_culture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    await h.architecture_update_culture({ id: 'a', partial: { region: 'New region' } });
    expect((await h.architecture_get_culture({ id: 'a' })).region).toBe('New region');
  });

  it('delete_culture removes it', async () => {
    await h.architecture_create_culture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    await h.architecture_delete_culture({ id: 'a' });
    expect(await h.architecture_list_cultures({})).toEqual([]);
  });
});
