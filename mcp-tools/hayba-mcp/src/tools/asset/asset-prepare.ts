import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { redactSecrets } from '../../security/secret-redaction.js';
import { defineTool, type ToolDescriptor } from '../register-tool.js';
import { executeCommand } from '../tool-executor.js';
import { approvalRequired, workflowNeedsApproval } from '../workflows/approval.js';
import { AssetPreparationPolicySchema, type WorkflowResult, type WorkflowStageResult, stageResult } from '../workflows/contracts.js';

const assetPrepareInputSchema = z.object({
  assetPath: z.string().min(1), policy: AssetPreparationPolicySchema,
}).strict();
export type AssetPreparationInput = z.infer<typeof assetPrepareInputSchema>;

export interface AssetPreparationDecision {
  capability: 'nanite' | 'collision' | 'lods' | 'lightmapUvs' | 'materialInstances';
  requested: unknown;
  resolved: unknown;
  reason: string;
  code?: string;
}

// These are actual mesh_get_info fields. The reader does not establish Nanite
// support, mesh usage, or deformation/material eligibility.
const meshInspectionSchema = z.object({
  path: z.string().min(1), lod_count: z.number().int().nonnegative(),
  lod_screen_sizes: z.array(z.number().min(0).max(1)),
});
type NativeMeshInspection = z.infer<typeof meshInspectionSchema>;

export interface AssetPreparationInspection {
  assetPath: string;
  decisions: AssetPreparationDecision[];
  unsupported: string[];
  evidence: { source: 'mesh_get_info'; naniteSupport: null; foliage: null; deformation: null; lodCount: number; lodScreenSizes: number[] };
}

// Workflow-internal reuse; mesh_set_lod remains a public generated native tool.
const SET_MESH_LOD_COMMAND = 'mesh_set_lod' as const;
async function inspectMesh(assetPath: string): Promise<NativeMeshInspection> {
  const mesh = meshInspectionSchema.parse(await executeCommand<unknown>('mesh_get_info', { path: assetPath }));
  if (mesh.path !== assetPath) throw new Error('Native inspection returned a different asset');
  return mesh;
}

function toInspection(input: AssetPreparationInput, mesh: NativeMeshInspection): AssetPreparationInspection {
  const policy = input.policy;
  const decisions: AssetPreparationDecision[] = [];
  const add = (capability: AssetPreparationDecision['capability'], requested: unknown, resolved: unknown, reason: string, code?: string) => {
    decisions.push({ capability, requested, resolved, reason, ...(code ? { code } : {}) });
  };
  const nanite = policy.nanite ?? 'preserve';
  if (nanite === 'preserve') add('nanite', nanite, 'preserve', 'preserved by policy');
  else if (nanite === 'auto' && policy.intent === 'foliage') add('nanite', nanite, 'preserve', 'foliage intent is preserved under Nanite auto');
  else add('nanite', nanite, 'preserve', nanite === 'auto'
    ? 'Native mesh inspection does not establish Nanite support, deformation, or material eligibility; preserve until reviewed'
    : 'Nanite mutation requires a native writer that is unavailable', nanite === 'auto' ? 'nanite_eligibility_unknown' : 'nanite_mutation_unavailable');
  for (const [capability, code, label] of [
    ['collision', 'collision_unavailable', 'collision configuration'],
    ['lightmapUvs', 'lightmap_uvs_unavailable', 'lightmap UV generation'],
    ['materialInstances', 'material_instances_unavailable', 'material instance creation'],
  ] as const) {
    const requested = policy[capability] ?? 'preserve';
    add(capability, requested, 'preserve', requested === 'preserve' ? 'preserved by policy' : `Native ${label} is unavailable`, requested === 'preserve' ? undefined : code);
  }
  const lods = policy.lods ?? 'preserve';
  if (lods === 'auto') add('lods', lods, 'preserve', 'Automatic LOD selection is unavailable', 'lod_auto_unavailable');
  else if (typeof lods === 'object' && ((lods.count !== undefined && lods.count !== mesh.lod_count)
    || (lods.reduction !== undefined && (mesh.lod_count < 2 || mesh.lod_screen_sizes.length < mesh.lod_count)))) {
    add('lods', lods, 'preserve', 'LOD policy requires matching existing LODs and inspected screen sizes for each target', 'lod_configuration_unavailable');
  } else add('lods', lods, lods, lods === 'preserve' ? 'preserved by policy' : 'Existing LOD settings can be verified and updated');
  return {
    assetPath: input.assetPath, decisions, unsupported: decisions.filter((d) => d.code).map((d) => d.capability),
    evidence: { source: 'mesh_get_info', naniteSupport: null, foliage: null, deformation: null, lodCount: mesh.lod_count, lodScreenSizes: mesh.lod_screen_sizes },
  };
}

export async function inspectAssetPreparation(input: AssetPreparationInput): Promise<AssetPreparationInspection> {
  const parsed = assetPrepareInputSchema.parse(input);
  return toInspection(parsed, await inspectMesh(parsed.assetPath));
}

/** Add opt-in policy inspection to the one existing metadata descriptor. */
export function withAssetPreparationInspection(base: ToolDescriptor): ToolDescriptor {
  return { ...base, description: `${base.description} Optional preparation_policy adds evidence and requested/resolved preparation decisions without mutation.`,
    returns: `${base.returns}; preparation?: {assetPath, decisions, unsupported, evidence}`,
    handler: async (args, session) => {
      const response = await base.handler(args, session);
      if (!args.preparation_policy || response.isError) return response;
      const inspection = await inspectAssetPreparation({ assetPath: String(args.asset_path), policy: AssetPreparationPolicySchema.parse(args.preparation_policy) });
      return { ...response, content: response.content.map((block) => block.type === 'text'
        ? { ...block, text: JSON.stringify({ ...JSON.parse(block.text), preparation: inspection }) } : block) };
    },
  };
}

export async function prepareAsset(input: AssetPreparationInput): Promise<WorkflowResult> {
  const operationId = `asset-prepare:${randomUUID()}`;
  const stages: WorkflowStageResult[] = [];
  const affectedResources: WorkflowResult['affectedResources'] = [];
  let started = performance.now();
  let activeStage = 'inspect';
  let attempted = false;
  let parsed: AssetPreparationInput | undefined;
  let ok = true;
  const record = (result: WorkflowStageResult) => stages.push({ ...result, durationMs: performance.now() - started });
  try {
    parsed = assetPrepareInputSchema.parse(input);
    const mesh = await inspectMesh(parsed.assetPath);
    const inspection = toInspection(parsed, mesh);
    record(stageResult('inspect', 'succeeded', { summary: JSON.stringify(inspection) }));
    const unsupported = inspection.decisions.filter((d) => d.code);
    const required = unsupported.find((d) => d.requested === 'require' || (d.capability === 'nanite' && d.requested !== 'auto')
      || (d.capability === 'lods' && typeof d.requested === 'object'));
    for (const d of unsupported) {
      started = performance.now();
      record(stageResult(d.capability, 'unsupported', {
        code: d.code, summary: d.reason,
        remediation: [{ code: d.code!, label: `Review ${d.capability} policy`, description: d.reason }],
      }));
    }
    if (required) ok = false;
    else if (typeof parsed.policy.lods === 'object' && parsed.policy.lods.reduction !== undefined) {
      for (let lodIndex = 1; lodIndex < mesh.lod_count; lodIndex++) {
        started = performance.now();
        activeStage = `lod:${lodIndex}`;
        attempted = true;
        const reply = await executeCommand<Record<string, unknown>>(SET_MESH_LOD_COMMAND, {
          path: parsed.assetPath, lod_index: lodIndex, screen_size: mesh.lod_screen_sizes[lodIndex],
          reduction_percent_triangles: parsed.policy.lods.reduction,
        });
        if (reply?.status === 'plan_mode_required') { record(approvalRequired(activeStage)); ok = false; break; }
        if (reply?.ok === false) throw new Error('Native LOD writer refused the requested change');
        const close = (actual: unknown, expected: number) => typeof actual === 'number' && Math.abs(actual - expected) < 1e-6;
        if (reply?.ok !== true || reply.path !== parsed.assetPath || reply.lod_index !== lodIndex
          || !close(reply.screen_size, mesh.lod_screen_sizes[lodIndex]!) || !close(reply.reduction_percent_triangles, parsed.policy.lods.reduction)) {
          throw new Error('Native LOD writer did not verify the requested asset, LOD, screen size, and reduction');
        }
        const resource = { kind: 'mesh_lod', id: `${parsed.assetPath}#LOD${lodIndex}`, path: parsed.assetPath };
        if (!affectedResources.length) affectedResources.push({ kind: 'asset', id: parsed.assetPath, path: parsed.assetPath });
        affectedResources.push(resource);
        record(stageResult(activeStage, 'succeeded', { affectedResources: [resource] }));
        attempted = false;
      }
    } else if (!unsupported.length) {
      started = performance.now();
      record(stageResult('prepare', typeof parsed.policy.lods === 'object' ? 'succeeded' : 'skipped', { summary: 'Existing settings satisfy the requested policies; no mutation requested' }));
    }
  } catch (error) {
    ok = false;
    const resources: WorkflowResult['affectedResources'] = [];
    if (attempted && parsed) {
      const asset = { kind: 'asset', id: parsed.assetPath, path: parsed.assetPath };
      if (!affectedResources.some((r) => r.kind === 'asset')) affectedResources.push(asset);
      const unknown = { kind: 'mesh_lod_unknown', id: `${parsed.assetPath}#${activeStage}`, path: parsed.assetPath };
      affectedResources.push(unknown); resources.push(asset, unknown);
    }
    record(stageResult(activeStage, 'failed', {
      code: attempted ? 'lod_outcome_unknown' : 'asset_inspection_failed',
      summary: redactSecrets(error instanceof Error ? error.message : String(error)).value || 'Asset preparation stage failed',
      affectedResources: resources,
      remediation: [{ code: 'inspect_before_retry', label: 'Inspect the asset and completed LODs before retrying' }],
    }));
  }
  const pending = workflowNeedsApproval({ stages });
  return {
    ok, operationId,
    summary: pending ? 'Asset preparation awaits Plan Mode approval'
      : !ok ? stages.find((s) => s.status === 'failed')?.summary ?? stages.find((s) => s.status === 'unsupported')?.summary ?? 'Asset preparation stopped'
        : affectedResources.length ? 'Supported LOD reductions applied; review any unsupported policies' : 'Asset preparation inspected; review any unsupported policies',
    stages, affectedResources,
    verdicts: stages.filter((s) => s.code).map((s) => ({ code: s.code!, message: s.summary ?? s.code!,
      severity: s.status === 'failed' || (!ok && s.status === 'unsupported') ? 'error' : 'warning',
      direction: s.status === 'failed' || (!ok && s.status === 'unsupported') ? 'block' : 'review' })),
    remediation: stages.flatMap((s) => s.remediation),
    undo: { supported: false, description: 'Completed LOD commands use editor transactions; the workflow does not automatically roll back partial work' },
  };
}

export const assetPrepareDescriptor = defineTool({
  name: 'asset_prepare',
  description: 'Inspect and apply supported StaticMesh preparation policies, retaining partial work and unsupported capability results.',
  schema: assetPrepareInputSchema.shape,
  inputSchema: assetPrepareInputSchema,
  meta: { cost: 'medium', effects: ['modifies_asset'], when: 'preparing a StaticMesh after reviewing its policy decisions', not_when: 'only inspecting eligibility' },
  cost: 'medium', returns: 'WorkflowResult with per-capability decisions, verified LOD stages, and remediation.',
  handler: async (args) => {
    const result = await prepareAsset(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok && !workflowNeedsApproval(result) };
  },
});
