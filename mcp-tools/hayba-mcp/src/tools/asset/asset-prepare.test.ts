import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { WorkflowResultSchema } from '../workflows/contracts.js';
import { assetPrepareDescriptor, inspectAssetPreparation, prepareAsset } from './asset-prepare.js';

let ue: ScriptedUe | undefined;
afterEach(() => { ue?.restore(); ue = undefined; });
const assetPath = '/Game/Meshes/SM_Rock';
// mesh_get_info's native contract has no supports_nanite/is_foliage/is_deforming.
const mesh = { path: assetPath, name: 'SM_Rock', lod_count: 3, lod_screen_sizes: [1, 0.5, 0.25], material_slots: [] };
const input = { assetPath, policy: { intent: 'environment', lods: { reduction: 0.5 } } } as const;

describe('asset preparation policy', () => {
  it('exposes unknown native Nanite evidence and preserves auto instead of inventing eligibility', async () => {
    ue = scriptedUe().replies('mesh_get_info', mesh);
    const result = await inspectAssetPreparation({ assetPath, policy: { intent: 'environment', nanite: 'auto' } });
    expect(result.evidence).toMatchObject({ source: 'mesh_get_info', naniteSupport: null, foliage: null, deformation: null });
    expect(result.decisions).toContainEqual(expect.objectContaining({ capability: 'nanite', requested: 'auto', resolved: 'preserve', code: 'nanite_eligibility_unknown' }));
  });

  it('preserves foliage intent under Nanite auto', async () => {
    ue = scriptedUe().replies('mesh_get_info', mesh);
    const result = await inspectAssetPreparation({ assetPath, policy: { intent: 'foliage', nanite: 'auto' } });
    expect(result.decisions).toContainEqual(expect.objectContaining({ capability: 'nanite', resolved: 'preserve', reason: 'foliage intent is preserved under Nanite auto' }));
  });

  it.each([
    [{ nanite: 'enable' }, 'nanite_mutation_unavailable'],
    [{ lightmapUvs: 'require' }, 'lightmap_uvs_unavailable'],
    [{ materialInstances: 'require' }, 'material_instances_unavailable'],
    [{ lods: { count: 8, reduction: 0.5 } }, 'lod_configuration_unavailable'],
  ] as const)('refuses required unavailable policy before any LOD write: %s', async (policy, code) => {
    ue = scriptedUe().replies('mesh_get_info', mesh);
    const result = WorkflowResultSchema.parse(await prepareAsset({ assetPath, policy: { ...input.policy, ...policy } }));
    expect(result.ok).toBe(false);
    expect(result.stages).toContainEqual(expect.objectContaining({ status: 'unsupported', code }));
    expect(result.remediation).toContainEqual(expect.objectContaining({ code }));
    expect(ue.calls.map((call) => call.cmd)).toEqual(['mesh_get_info']);
  });

  it('does not mutate preserved collision and LODs', async () => {
    ue = scriptedUe().replies('mesh_get_info', mesh);
    const result = await prepareAsset({ assetPath, policy: { intent: 'environment', collision: 'preserve', lods: 'preserve' } });
    expect(result.ok).toBe(true);
    expect(result.affectedResources).toEqual([]);
    expect(ue.calls.map((call) => call.cmd)).toEqual(['mesh_get_info']);
  });

  it('retains every optional unsupported capability alongside verified LOD work', async () => {
    ue = scriptedUe().replies('mesh_get_info', mesh).replies('mesh_set_lod', (params) => ({ ok: true, ...params }));
    const result = await prepareAsset({ assetPath, policy: { ...input.policy, collision: 'simple', lightmapUvs: 'generate', materialInstances: 'create' } });
    expect(result.ok).toBe(true);
    for (const code of ['collision_unavailable', 'lightmap_uvs_unavailable', 'material_instances_unavailable']) {
      expect(result.stages).toContainEqual(expect.objectContaining({ status: 'unsupported', code }));
      expect(result.verdicts).toContainEqual(expect.objectContaining({ code, direction: 'review' }));
      expect(result.remediation).toContainEqual(expect.objectContaining({ code }));
    }
    expect(result.stages.filter((s) => s.stage.startsWith('lod:')).map((s) => s.status)).toEqual(['succeeded', 'succeeded']);
    expect(result.affectedResources.filter((r) => r.kind === 'mesh_lod')).toHaveLength(2);
  });

  it.each([{}, { ok: false }, { ok: true }, { ok: true, path: '/Game/Wrong', lod_index: 1, screen_size: 0.5, reduction_percent_triangles: 0.5 },
    { ok: true, path: assetPath, lod_index: 2, screen_size: 0.5, reduction_percent_triangles: 0.5 },
    { ok: true, path: assetPath, lod_index: 1, screen_size: 0.5, reduction_percent_triangles: 0.8 },
  ])('never treats an unverified native LOD reply as success: %j', async (reply) => {
    ue = scriptedUe().replies('mesh_get_info', mesh).replies('mesh_set_lod', reply);
    const result = WorkflowResultSchema.parse(await prepareAsset(input));
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'lod:1', status: 'failed', code: 'lod_outcome_unknown' });
    expect(result.affectedResources).toContainEqual(expect.objectContaining({ kind: 'mesh_lod_unknown', path: assetPath }));
    expect(ue.calls.filter((c) => c.cmd === 'mesh_set_lod')).toHaveLength(1);
  });

  it('keeps Plan Mode refusal approval-required with no claimed mutation', async () => {
    ue = scriptedUe().replies('mesh_get_info', mesh).replies('mesh_set_lod', { status: 'plan_mode_required' });
    const response = await assetPrepareDescriptor.handler(input, {});
    const result = JSON.parse(response.content.find((c) => c.type === 'text')!.text);
    expect(response.isError).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'lod:1', status: 'pending', code: 'plan_mode_required' });
    expect(result.affectedResources).toEqual([]);
  });

  it('catches inspection errors inside the WorkflowResult', async () => {
    ue = scriptedUe().fails('mesh_get_info', 'Asset cannot be loaded');
    const result = WorkflowResultSchema.parse(await prepareAsset(input));
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'inspect', status: 'failed', code: 'asset_inspection_failed' });
    expect(result.affectedResources).toEqual([]);
    expect(ue.called('mesh_set_lod')).toBe(false);
  });

  it('keeps an empty exception message inside a valid WorkflowResult', async () => {
    ue = scriptedUe().replies('mesh_get_info', () => { throw new Error(''); });
    const result = WorkflowResultSchema.parse(await prepareAsset(input));
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ code: 'asset_inspection_failed', summary: 'Asset preparation stage failed' });
  });

  it('retains the first LOD and marks the second unknown when the second write throws', async () => {
    ue = scriptedUe().replies('mesh_get_info', mesh).replies('mesh_set_lod', (params) => {
      if (params.lod_index === 2) throw new Error('Editor disconnected after write');
      return { ok: true, ...params };
    });
    const result = WorkflowResultSchema.parse(await prepareAsset(input));
    expect(result.ok).toBe(false);
    expect(result.stages).toContainEqual(expect.objectContaining({ stage: 'lod:1', status: 'succeeded' }));
    expect(result.stages.at(-1)).toMatchObject({ stage: 'lod:2', status: 'failed', code: 'lod_outcome_unknown' });
    expect(result.affectedResources.map((r) => r.kind)).toEqual(['asset', 'mesh_lod', 'mesh_lod_unknown']);
    expect(result.remediation).toContainEqual(expect.objectContaining({ code: 'inspect_before_retry' }));
  });

  it('uses a unique operation ID per invocation and measured stage durations', async () => {
    ue = scriptedUe().replies('mesh_get_info', mesh);
    const first = await prepareAsset({ assetPath, policy: { intent: 'environment' } });
    const second = await prepareAsset({ assetPath, policy: { intent: 'environment' } });
    expect(first.operationId).not.toBe(second.operationId);
    expect(first.stages[0]!.durationMs).toBeGreaterThan(0);
  });
});
