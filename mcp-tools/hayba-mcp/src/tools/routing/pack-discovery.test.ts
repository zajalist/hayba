import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { deriveDomainPacks, loadWorkflowPacks } from './pack-discovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('pack-discovery', () => {
  it('derives domain packs from tool->dir mapping', () => {
    const toolDirs = new Map<string, string | null>([
      ['actor_spawn', 'actor'],
      ['actor_list',  'actor'],
      ['scene_export', 'scene'],
      ['create_pcg_graph', null],            // root-level, no explicit pack
      ['hayba_planet_dynamo_field', null],   // root-level
    ]);
    const explicitPacks = new Map<string, string>([
      ['hayba_planet_dynamo_field', 'planet'],
    ]);
    const packs = deriveDomainPacks(toolDirs, explicitPacks);
    expect(packs.find(p => p.name === 'actor')?.tools.sort()).toEqual(['actor_list', 'actor_spawn']);
    expect(packs.find(p => p.name === 'scene')?.tools).toEqual(['scene_export']);
    expect(packs.find(p => p.name === 'planet')?.tools).toEqual(['hayba_planet_dynamo_field']);
    expect(packs.find(p => p.name === 'core')?.tools).toEqual(['create_pcg_graph']);
  });

  it('loads workflow packs from yaml', () => {
    const packs = loadWorkflowPacks(resolve(__dirname, 'packs.yaml'));
    expect(packs.find(p => p.name === 'biome')?.kind).toBe('workflow');
    expect(packs.find(p => p.name === 'editor')?.autoLoadOn).toBe('ue_connected');
  });
});
