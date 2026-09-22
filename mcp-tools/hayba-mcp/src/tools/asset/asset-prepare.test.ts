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
  });
});
