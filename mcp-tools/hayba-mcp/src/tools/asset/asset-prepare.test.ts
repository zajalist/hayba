import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { inspectAssetPreparation, prepareAsset } from './asset-prepare.js';

let ue: ScriptedUe | undefined;
afterEach(() => {
  ue?.restore();
  ue = undefined;
});

const staticEnvironment = {
  asset_path: '/Game/Meshes/SM_Rock',
  supports_nanite: true,
  is_deforming: false,
  is_foliage: false,
  lod_count: 2,
  lod_screen_sizes: [1, 0.5],
};

describe('asset preparation policy', () => {
  it('resolves an eligible static environment mesh to Nanite enable under auto', async () => {
    ue = scriptedUe().replies('mesh_get_info', staticEnvironment);

    const result = await inspectAssetPreparation({
      assetPath: '/Game/Meshes/SM_Rock',
      policy: { intent: 'environment', nanite: 'auto' },
    });

    expect(result.decisions).toContainEqual({
      capability: 'nanite', requested: 'auto', resolved: 'enable', reason: 'static environment mesh is eligible for Nanite',
    });
  });

  it('preserves a deforming foliage mesh under Nanite auto', async () => {
    ue = scriptedUe().replies('mesh_get_info', { ...staticEnvironment, is_foliage: true, is_deforming: true });

    const result = await inspectAssetPreparation({
      assetPath: '/Game/Meshes/SM_Tree',
      policy: { intent: 'foliage', nanite: 'auto' },
    });

    expect(result.decisions).toContainEqual({
      capability: 'nanite', requested: 'auto', resolved: 'preserve', reason: 'foliage or deforming meshes are preserved under Nanite auto',
    });
  });

  it('keeps Nanite auto inspectable with the native unsupported reason', async () => {
    ue = scriptedUe().replies('mesh_get_info', { ...staticEnvironment, supports_nanite: false });

    const result = await inspectAssetPreparation({
      assetPath: '/Game/Meshes/SM_Rock',
      policy: { intent: 'environment', nanite: 'auto' },
    });

    expect(result.decisions).toContainEqual({
      capability: 'nanite', requested: 'auto', resolved: 'preserve', reason: 'native inspection reports Nanite unsupported',
    });
  });

  it('rejects explicit Nanite enable when inspection says it is unsupported before mutating', async () => {
    ue = scriptedUe().replies('mesh_get_info', { ...staticEnvironment, supports_nanite: false });

    const result = await prepareAsset({
      assetPath: '/Game/Meshes/SM_Rock',
      policy: { intent: 'environment', nanite: 'enable' },
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Nanite is unsupported');
    expect(ue.calls).toHaveLength(1);
  });

  it.each([
    [{ intent: 'environment', lightmapUvs: 'require' } as const, 'lightmap UV generation'],
    [{ intent: 'environment', materialInstances: 'require' } as const, 'material instance creation'],
  ])('fails a required unavailable capability before mutation: %s', async (policy, capability) => {
    ue = scriptedUe().replies('mesh_get_info', staticEnvironment);

    const result = await prepareAsset({ assetPath: '/Game/Meshes/SM_Rock', policy });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain(capability);
    expect(ue.calls).toHaveLength(1);
  });

  it('does not mutate collision or LODs when both policies preserve them', async () => {
    ue = scriptedUe().replies('mesh_get_info', staticEnvironment);

    const result = await prepareAsset({
      assetPath: '/Game/Meshes/SM_Rock',
      policy: { intent: 'environment', collision: 'preserve', lods: 'preserve' },
    });

    expect(result.ok).toBe(true);
    expect(ue.calls).toHaveLength(1);
    expect(ue.calls[0]?.cmd).toBe('mesh_get_info');
  });

  it('applies supported LOD reduction only after inspection and all refusal checks', async () => {
    ue = scriptedUe()
      .replies('mesh_get_info', staticEnvironment)
      .replies('mesh_set_lod', { ok: true });

    const result = await prepareAsset({
      assetPath: '/Game/Meshes/SM_Rock',
      policy: { intent: 'environment', lods: { count: 2, reduction: 0.5 } },
    });

    expect(result.ok).toBe(true);
    expect(ue.calls.map((call) => call.cmd)).toEqual(['mesh_get_info', 'mesh_set_lod']);
    expect(ue.paramsFor('mesh_set_lod')).toEqual({
      path: '/Game/Meshes/SM_Rock', lod_index: 1, screen_size: 0.5, reduction_percent_triangles: 0.5,
    });
  });

  it('refuses LOD reduction when inspection lacks a screen size for every existing LOD', async () => {
    ue = scriptedUe()
      .replies('mesh_get_info', { ...staticEnvironment, lod_screen_sizes: [1] })
      .replies('mesh_set_lod', { ok: true });

    const result = await prepareAsset({
      assetPath: '/Game/Meshes/SM_Rock',
      policy: { intent: 'environment', lods: { reduction: 0.5 } },
    });

    expect(result.ok).toBe(false);
    expect(ue.calls.map((call) => call.cmd)).toEqual(['mesh_get_info']);
  });

  it.each([
    ['collision', { collision: 'simple' }],
    ['lightmapUvs', { lightmapUvs: 'generate' }],
    ['materialInstances', { materialInstances: 'create' }],
  ] as const)('preserves unavailable optional %s rather than claiming a mutation', async (capability, requested) => {
    ue = scriptedUe().replies('mesh_get_info', staticEnvironment);

    const result = await inspectAssetPreparation({
      assetPath: '/Game/Meshes/SM_Rock', policy: { intent: 'environment', ...requested },
    });

    expect(result.decisions.find((item) => item.capability === capability)?.resolved).toBe('preserve');
  });
});
