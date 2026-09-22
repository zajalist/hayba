import { z } from 'zod';
import { defineTool, type ToolDescriptor } from '../register-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { executeCommand } from '../tool-executor.js';
import {
  AssetPreparationPolicySchema,
  type AssetPreparationPolicy,
  type WorkflowResult,
  stageResult,
} from '../workflows/contracts.js';

const assetPrepareInputSchema = z.object({
  assetPath: z.string().min(1),
  policy: AssetPreparationPolicySchema,
}).strict();

export type AssetPreparationInput = z.infer<typeof assetPrepareInputSchema>;

export interface AssetPreparationDecision {
  capability: 'nanite' | 'collision' | 'lods' | 'lightmapUvs' | 'materialInstances';
  requested: unknown;
  resolved: unknown;
  reason: string;
}

export interface AssetPreparationInspection {
  assetPath: string;
  decisions: AssetPreparationDecision[];
  unsupported: string[];
}

interface NativeMeshInspection {
  supports_nanite?: boolean;
  is_foliage?: boolean;
  is_deforming?: boolean;
  lod_count?: number;
  lod_screen_sizes?: number[];
}

// This is the only place workflow code knows the current native command names.
// Keep it local: the workflow contract is deliberately independent from the UE
// command catalog and can survive a native rename without changing callers.
const nativeMesh = {
  inspect: (assetPath: string) => executeCommand<NativeMeshInspection>('mesh_get_info', { path: assetPath }),
  setLod: (assetPath: string, lodIndex: number, screenSize: number, reduction?: number) =>
    executeCommand('mesh_set_lod', {
      path: assetPath,
      lod_index: lodIndex,
      screen_size: screenSize,
      ...(reduction === undefined ? {} : { reduction_percent_triangles: reduction }),
    }),
};

function decision(
  capability: AssetPreparationDecision['capability'], requested: unknown, resolved: unknown, reason: string,
): AssetPreparationDecision {
  return { capability, requested, resolved, reason };
}

function inspectDecisions(policy: AssetPreparationPolicy, mesh: NativeMeshInspection): AssetPreparationInspection['decisions'] {
  const nanite = policy.nanite ?? 'preserve';
  const foliageOrDeforming = mesh.is_foliage === true || mesh.is_deforming === true || policy.intent === 'foliage';
  const eligibleIntent = policy.intent === 'environment' || policy.intent === 'hero';
  const naniteEligible = mesh.supports_nanite === true && !foliageOrDeforming && eligibleIntent;
  const naniteDecision = nanite === 'auto'
    ? mesh.supports_nanite === false
      ? decision('nanite', nanite, 'preserve', 'native inspection reports Nanite unsupported')
      : foliageOrDeforming
        ? decision('nanite', nanite, 'preserve', 'foliage or deforming meshes are preserved under Nanite auto')
        : naniteEligible
          ? decision('nanite', nanite, 'enable', 'static environment mesh is eligible for Nanite')
          : decision('nanite', nanite, 'preserve', 'mesh intent is not automatically eligible for Nanite')
    : decision('nanite', nanite, nanite, nanite === 'enable' && mesh.supports_nanite === false
      ? 'native inspection reports Nanite unsupported'
      : 'requested explicitly');

  const collision = policy.collision ?? 'preserve';
  const lods = policy.lods ?? 'preserve';
  const lightmapUvs = policy.lightmapUvs ?? 'preserve';
  const materialInstances = policy.materialInstances ?? 'preserve';
  return [
    naniteDecision,
    decision('collision', collision, 'preserve', collision === 'preserve' ? 'preserved by policy' : 'native collision writer is unavailable; skipped'),
    decision('lods', lods, lods, lods === 'preserve' ? 'preserved by policy' : 'native LOD writer can update existing LOD reduction settings'),
    decision('lightmapUvs', lightmapUvs, lightmapUvs === 'require' ? lightmapUvs : 'preserve', lightmapUvs === 'preserve' ? 'preserved by policy' : 'native lightmap UV generation is unavailable; skipped'),
    decision('materialInstances', materialInstances, materialInstances === 'require' ? materialInstances : 'preserve', materialInstances === 'preserve' ? 'preserved by policy' : 'native material instance creation is unavailable; skipped'),
  ];
}

function toInspection(input: AssetPreparationInput, mesh: NativeMeshInspection): AssetPreparationInspection {
  const parsed = assetPrepareInputSchema.parse(input);
  const decisions = inspectDecisions(parsed.policy, mesh);
  const unsupported = decisions
    .filter((d) => d.reason.includes('unavailable') || d.reason.includes('unsupported'))
    .map((d) => d.capability);
  return { assetPath: parsed.assetPath, decisions, unsupported };
}

export async function inspectAssetPreparation(input: AssetPreparationInput): Promise<AssetPreparationInspection> {
  const parsed = assetPrepareInputSchema.parse(input);
  return toInspection(parsed, await nativeMesh.inspect(parsed.assetPath));
}

function fail(assetPath: string, summary: string, inspection: AssetPreparationInspection): WorkflowResult {
  return {
    ok: false,
    operationId: `asset-prepare:${assetPath}`,
    summary,
    stages: [stageResult('inspect'), stageResult('prepare', 'failed', { code: 'unsupported_policy' })],
    affectedResources: [{ kind: 'asset', id: assetPath, path: assetPath }],
    verdicts: [{ code: 'unsupported_policy', message: summary, severity: 'error', direction: 'block' }],
    remediation: inspection.unsupported.map((capability) => ({
      code: `unsupported_${capability}`,
      label: `Review ${capability} policy`,
    })),
  };
}

function requiredCapabilityFailure(input: AssetPreparationInput, inspection: AssetPreparationInspection, mesh: NativeMeshInspection): string | undefined {
  const d = (capability: AssetPreparationDecision['capability']) => inspection.decisions.find((x) => x.capability === capability);
  if (input.policy.nanite === 'enable' && d('nanite')?.reason.includes('unsupported')) return 'Nanite is unsupported by native inspection';
  if (input.policy.nanite === 'enable' || input.policy.nanite === 'disable') return 'Nanite mutation requires a native writer that is unavailable';
  if (input.policy.lightmapUvs === 'require') return 'lightmap UV generation is required but unavailable';
  if (input.policy.materialInstances === 'require') return 'material instance creation is required but unavailable';
  if (typeof input.policy.lods === 'object') {
    if (input.policy.lods.count !== undefined && input.policy.lods.count !== mesh.lod_count) {
      return `requested ${input.policy.lods.count} LODs but native writer can only edit the ${mesh.lod_count ?? 0} existing LODs`;
    }
    if (input.policy.lods.reduction !== undefined && (!mesh.lod_count || mesh.lod_count < 2 || !mesh.lod_screen_sizes || mesh.lod_screen_sizes.length < mesh.lod_count)) {
      return 'LOD reduction requires inspected screen sizes for at least two existing LODs';
    }
  }
  return undefined;
}

async function applyLodReduction(input: AssetPreparationInput, mesh: NativeMeshInspection): Promise<void> {
  const policy = input.policy.lods;
  if (typeof policy !== 'object' || policy.reduction === undefined) return;
  for (let lodIndex = 1; lodIndex < (mesh.lod_count ?? 0); lodIndex++) {
    await nativeMesh.setLod(input.assetPath, lodIndex, mesh.lod_screen_sizes![lodIndex]!, policy.reduction);
  }
}

export async function prepareAsset(input: AssetPreparationInput): Promise<WorkflowResult> {
  const parsed = assetPrepareInputSchema.parse(input);
  const mesh = await nativeMesh.inspect(parsed.assetPath);
  const inspection = toInspection(parsed, mesh);
  const refusal = requiredCapabilityFailure(parsed, inspection, mesh);
  if (refusal) return fail(parsed.assetPath, refusal, inspection);

  await applyLodReduction(parsed, mesh);
  return {
    ok: true,
    operationId: `asset-prepare:${parsed.assetPath}`,
    summary: typeof parsed.policy.lods === 'object' && parsed.policy.lods.reduction !== undefined
      ? 'asset preparation policy inspected and supported LOD reductions applied'
      : 'asset preparation policy inspected; no supported mutations requested',
    stages: [stageResult('inspect'), stageResult('prepare', typeof parsed.policy.lods === 'object' && parsed.policy.lods.reduction !== undefined ? 'succeeded' : 'skipped', { summary: 'supported requested mutations applied or skipped' })],
    affectedResources: [{ kind: 'asset', id: parsed.assetPath, path: parsed.assetPath }],
    verdicts: [{ code: 'asset_preparation_complete', message: 'Supported policies were applied; unavailable optional policies were skipped', severity: 'info', direction: 'proceed' }],
    remediation: [],
  };
}

const inspectMeta: HaybaToolMeta = {
  cost: 'low', effects: [],
  when: 'checking which asset preparation policies are eligible before changing a StaticMesh',
  not_when: 'you already need to apply a supported preparation policy',
};
const prepareMeta: HaybaToolMeta = {
  cost: 'medium', effects: ['writes-to-disk'],
  when: 'preparing a StaticMesh after reviewing its policy decisions',
  not_when: 'you only need an eligibility report',
};

export const assetInspectDescriptor: ToolDescriptor = defineTool({
  name: 'asset_inspect_preparation',
  description: 'Inspect a StaticMesh preparation policy and report each requested/resolved capability decision without mutation.',
  schema: assetPrepareInputSchema.shape,
  meta: inspectMeta,
  cost: 'low',
  returns: '{assetPath, decisions:[{capability,requested,resolved,reason}], unsupported[]}',
  handler: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await inspectAssetPreparation(args)) }] }),
});

export const assetPrepareDescriptor: ToolDescriptor = defineTool({
  name: 'asset_prepare',
  description: 'Inspect then apply supported StaticMesh preparation policies; refuses hard requirements before any mutation.',
  schema: assetPrepareInputSchema.shape,
  meta: prepareMeta,
  cost: 'medium',
  returns: 'WorkflowResult',
  handler: async (args) => {
    const result = await prepareAsset(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok };
  },
});
