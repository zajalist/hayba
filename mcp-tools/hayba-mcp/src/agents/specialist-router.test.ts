import { describe, expect, it } from 'vitest';
import { loadAgentsManifest } from './agent-registry.js';
import { selectSpecialist } from './specialist-router.js';

const manifest = loadAgentsManifest();
const available = ['asset_search', 'scene_export', 'docs_search', 'pcg_validate', 'actor_list', 'world_inspect', 'metasound_get_graph'];

describe('selectSpecialist', () => {
  it.each([
    ['Find Content Browser assets by path', 'asset-manager'],
    ['Validate PCG node connectivity', 'node-expert'],
    ['Apply spatial composition layout', 'pattern-expert'],
    ['Construct blueprint logic graphs', 'blueprint-generator'],
    ['Concept art moodboard with strong silhouettes', 'concept-artist'],
    ['Import terrain heightmap into a partition landscape', 'world-builder'],
    ['Adjust lighting and atmosphere', 'lighting-artist'],
    ['Create a cinematic camera shot', 'cinematic-designer'],
    ['Check production readiness and regression tests', 'quality-reviewer'],
  ])('routes %s using manifest guidance', (intent, id) => {
    expect(selectSpecialist(intent, manifest, available).id).toBe(id);
  });

  it('routes audio work when its tools are enabled', () => {
    expect(selectSpecialist('Design metasound ambience and attenuation', manifest, available).id).toBe('audio-designer');
  });

  it('offers the canonical Sequencer tools to cinematic work', () => {
    expect(selectSpecialist('Create cinematic camera shots', manifest, ['seq_new', 'asset_delete'], 'cinematic-designer').toolNames)
      .toEqual(['seq_new']);
  });

  it('pins a specialist regardless of intent and intersects its globs with enabled names', () => {
    expect(selectSpecialist('Validate PCG nodes', manifest, available, 'asset-manager')).toEqual({
      id: 'asset-manager',
      toolNames: ['asset_search', 'scene_export'],
      reason: 'pinned',
    });
  });

  it('rejects an unknown pin and names the available profiles', () => {
    expect(() => selectSpecialist('assets', manifest, available, 'missing')).toThrow(
      /unknown archetype id "missing".*director/,
    );
  });

  it('keeps a pin with no enabled tools without granting additional capabilities', () => {
    expect(selectSpecialist('assets', manifest, ['actor_list'], 'asset-manager')).toMatchObject({
      id: 'asset-manager',
      toolNames: [],
    });
  });

  it('falls back to the coordinator for unmatched or ambiguous intent independent of manifest order', () => {
    for (const archetypes of [manifest.archetypes, [...manifest.archetypes].reverse()]) {
      expect(selectSpecialist('hello', { ...manifest, archetypes }, available)).toMatchObject({
        id: 'director',
        reason: 'no_match',
      });
      expect(selectSpecialist('asset node', { ...manifest, archetypes }, available)).toMatchObject({
        id: 'director',
        reason: 'ambiguous',
      });
    }
  });

  it('does not automatically select a specialist with no enabled matching tools', () => {
    expect(selectSpecialist('Content Browser assets', manifest, ['actor_list'])).toMatchObject({
      id: 'director',
      toolNames: ['actor_list'],
    });
  });

  it('uses literal glob characters and deduplicates enabled tool names', () => {
    const custom = {
      ...manifest,
      archetypes: manifest.archetypes.map((profile) =>
        profile.id === 'asset-manager' ? { ...profile, tool_filter: ['asset.v1_*'] } : profile,
      ),
    };
    expect(
      selectSpecialist('', custom, ['assetXv1_search', 'asset.v1_search', 'asset.v1_search'], 'asset-manager')
        .toolNames,
    ).toEqual(['asset.v1_search']);
  });
});
