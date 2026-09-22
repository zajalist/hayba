import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../../security/secret-redaction.js';
import { prepareAsset, type AssetPreparationInput } from '../asset/asset-prepare.js';
import { defineTool } from '../register-tool.js';
import { executeCommand } from '../tool-executor.js';
import type { SessionManager } from '../types.js';
import { approvalRequired, workflowNeedsApproval } from '../workflows/approval.js';
import {
  WorldIngestRequestSchema, stageResult,
  type WorldIngestRequest, type WorkflowResult, type WorkflowStageResult,
} from '../workflows/contracts.js';
import { worldInspectDescriptor, type WorldCapabilityReport } from './world-inspect.js';

type ResourceRef = WorkflowResult['affectedResources'][number];
// Workflow-internal reuse; level_save remains a public generated native tool.
const SAVE_LEVEL_COMMAND = 'level_save' as const;
type PartitionPolicy = Exclude<NonNullable<WorldIngestRequest['partition']>, { mode: 'preserve' }>;

/**
 * Engine boundary. Read-only inspection is separate from every mutation.
 * Mutators return verified terminal results, including known resources on partial
 * failure. Imported StaticMesh resources use kind `asset` for asset preparation.
 */
export interface WorldIngestDependencies {
  inspectWorld(): Promise<WorldCapabilityReport>;
  /** Read-only support/source preflight; must not create, configure, or save anything. */
  preflight?(request: WorldIngestRequest, report: WorldCapabilityReport): Promise<WorkflowStageResult>;
  importTerrain(request: WorldIngestRequest, report: WorldCapabilityReport): Promise<WorkflowStageResult>;
  configurePartition?(policy: PartitionPolicy): Promise<WorkflowStageResult>;
  configureHlod?(policy: NonNullable<PartitionPolicy['hlod']>): Promise<WorkflowStageResult>;
  prepareAsset?(input: AssetPreparationInput): Promise<WorkflowResult>;
  saveAndVerify(resources: ResourceRef[], report: WorldCapabilityReport): Promise<WorkflowStageResult>;
  validateWorld?(resources: ResourceRef[], report: WorldCapabilityReport): Promise<WorkflowStageResult>;
  signal?: AbortSignal;
  /** Internal compatibility seam: legacy landscape aliases never save. */
  persistence?: 'save_and_verify' | 'legacy_import_only';
}

interface Context {
  request: WorldIngestRequest;
  dependencies: WorldIngestDependencies;
  report?: WorldCapabilityReport;
  resources: ResourceRef[];
  stageResources: ResourceRef[];
  blocked?: boolean;
}

function partitionNeedsWrite(context: Context): boolean {
  const policy = context.request.partition;
  return !!policy && policy.mode !== 'preserve'
    && (!context.report!.facts.worldPartition.enabled || !!policy.runtimeGrid || !!policy.dataLayers);
}

function hlodRequested(policy: PartitionPolicy): boolean {
  return !!policy.hlod && (!!policy.hlod.layer || policy.hlod.build === 'auto' || policy.hlod.build === 'require');
}

function partitionLimitations(context: Context): Array<{ code: string; required: boolean }> {
  const policy = context.request.partition;
  if (!policy || policy.mode === 'preserve') return [];
  const issues: Array<{ code: string; required: boolean }> = [];
  if (!context.report!.facts.capabilities.worldPartition) {
    issues.push({ code: 'world_partition_unavailable', required: policy.mode === 'require' });
  } else if (partitionNeedsWrite(context) && !context.dependencies.configurePartition) {
    issues.push({ code: 'world_partition_configuration_unavailable', required: policy.mode === 'require' });
  }
  if (hlodRequested(policy) && (!context.report!.facts.capabilities.hlod || !context.dependencies.configureHlod)) {
    issues.push({ code: 'hlod_unavailable', required: policy.mode === 'require' || policy.hlod?.build === 'require' });
  }
  return issues;
}

async function inspect(context: Context): Promise<WorkflowStageResult> {
  context.report = await context.dependencies.inspectWorld();
  if (!context.report.facts.worldPackage || !context.report.facts.currentLevel || context.report.facts.worldType !== 'Editor') {
    context.blocked = true;
    return context.report.blockingErrors.find((result) => result.stage === 'inspect')
      ?? stageResult('inspect', 'failed', { code: 'world_identity_unavailable', summary: 'A usable editor world and current level are required before mutation' });
  }
  const failure = context.report.blockingErrors.find((result) => result.stage === 'inspect');
  if (failure) {
    context.blocked = true;
    return failure;
  }
  return stageResult('inspect', 'succeeded', { warnings: context.report.warnings.map((result) => result.code ?? result.stage) });
}

async function normalize(context: Context): Promise<WorkflowStageResult> {
  context.request = WorldIngestRequestSchema.parse(context.request);
  context.request.partition ??= context.report!.recommendedDefaults.partition;
  context.request.validation ??= context.report!.recommendedDefaults.validation;
  if (context.request.source.kind === 'heightmap') {
    context.request.terrain = { worldSizeKm: 8, maxHeightM: 600, actorLabel: 'Hayba_Terrain', ...context.request.terrain };
  }
  if (context.dependencies.preflight) {
    const result = await context.dependencies.preflight(context.request, context.report!);
    if (result.status === 'unsupported') context.blocked = true;
    return result;
  }
  return stageResult('normalize');
}

async function plan(context: Context): Promise<WorkflowStageResult> {
  const limitations = partitionLimitations(context);
  if (context.request.validation?.mode === 'require' && !context.dependencies.validateWorld) {
    limitations.push({ code: 'validation_unavailable', required: true });
  }
  if (context.request.materials?.mode === 'require' || context.request.materials?.mode === 'create') {
    limitations.push({ code: 'material_creation_unavailable', required: context.request.materials.mode === 'require' });
  }
  const assetPolicy = context.request.assets;
  if (assetPolicy && !context.dependencies.prepareAsset) {
    limitations.push({ code: 'asset_preparation_unavailable', required: assetPolicy.nanite === 'enable'
      || assetPolicy.nanite === 'disable' || assetPolicy.lightmapUvs === 'require' || assetPolicy.materialInstances === 'require' });
  }
  const required = limitations.find((issue) => issue.required);
  if (required) {
    context.blocked = true;
    return stageResult('plan', 'unsupported', { code: required.code, warnings: limitations.map((issue) => issue.code) });
  }
  return stageResult('plan', 'succeeded', {
    warnings: limitations.map((issue) => issue.code),
    summary: JSON.stringify({ request: context.request, capabilities: context.report!.facts.capabilities,
      irreversibleSteps: context.dependencies.persistence === 'legacy_import_only' ? [] : ['saveVerify: persists changes to disk'], automaticRollback: false }),
  });
}

async function terrain(context: Context): Promise<WorkflowStageResult> {
  return context.dependencies.importTerrain(context.request, context.report!);
}

/** Current native support is deliberately narrower than the extensible request contract. */
export function createNativeWorldIngestDependencies(session: SessionManager = {}, options: { persistence?: WorldIngestDependencies['persistence'] } = {}): WorldIngestDependencies {
  const importOnly = options.persistence === 'legacy_import_only';
  const inspectWorld = async (): Promise<WorldCapabilityReport> => {
    const response = await worldInspectDescriptor.handler({}, session);
    const text = response.content.find((block) => block.type === 'text');
    if (response.isError || !text) throw new Error('World inspection returned no usable report');
    return JSON.parse(text.text) as WorldCapabilityReport;
  };
  return {
    inspectWorld,
    prepareAsset,
    persistence: options.persistence,
    async preflight(request, report) {
      const code = request.source.kind !== 'heightmap' ? 'source_kind_unavailable'
        : request.destination.mode !== 'open_world' ? 'destination_mode_unavailable'
        : request.terrain?.scale ? 'terrain_scale_unavailable'
        : request.execution?.planMode ? 'plan_mode_control_unavailable'
        : request.source.format && !['png', 'r16'].includes(request.source.format.toLowerCase()) ? 'heightmap_format_unavailable'
        : !importOnly && report.facts.worldPartition.enabled ? 'external_actor_persistence_unavailable'
        : !importOnly && report.facts.saveReady !== true ? 'world_save_not_ready'
        : undefined;
      return stageResult('normalize', code ? 'unsupported' : 'succeeded', {
        warnings: importOnly ? ['legacy_import_only: imported changes remain unsaved'] : [],
        ...(code ? { code, remediation: [{ code: 'review_request', label: 'Use an existing writable world and a supported heightmap request' }] } : {}),
      });
    },
    async importTerrain(request, before) {
      if (request.source.kind !== 'heightmap') return stageResult('terrain', 'unsupported', { code: 'source_kind_unavailable' });
      let failure: string | undefined;
      try {
        const reply = await executeCommand('landscape_import', {
          heightmapPath: request.source.path,
          worldSizeKm: request.terrain!.worldSizeKm,
          maxHeightM: request.terrain!.maxHeightM,
          actorLabel: request.terrain!.actorLabel,
          ...(request.terrain?.material === undefined ? {} : { landscapeMaterial: request.terrain.material }),
        });
        if (reply?.status === 'plan_mode_required') return approvalRequired('terrain');
        if (reply?.ok === false) failure = 'Native import was refused';
      } catch (error) {
        failure = errorMessage(error);
      }
      let after: WorldCapabilityReport;
      try {
        after = await inspectWorld();
      } catch (error) {
        return stageResult('terrain', 'failed', {
          code: 'terrain_outcome_unknown', summary: failure ?? errorMessage(error),
          warnings: ['Post-import inspection failed; affected resources could not be enumerated'],
          remediation: [{ code: 'inspect_before_retry', label: 'Inspect the world before retrying the import' }],
        });
      }
      const previous = new Set(before.facts.landscapeActors.map((actor) => actor.path));
      const affectedResources = after.facts.landscapeActors
        .filter((actor) => typeof actor.path === 'string' && !previous.has(actor.path))
        .map((actor) => ({ kind: 'landscape', id: String(actor.path), path: String(actor.path) }));
      const verified = !failure && affectedResources.length > 0 && after.facts.currentLevel === before.facts.currentLevel
        && after.facts.worldPackage === before.facts.worldPackage;
      return stageResult('terrain', verified ? 'succeeded' : 'failed', {
        affectedResources,
        ...(verified ? {} : { code: failure ? 'terrain_import_failed' : 'terrain_not_verified',
          summary: failure ?? 'Import returned without an observable new landscape in the original world',
          remediation: [{ code: 'inspect_before_retry', label: 'Inspect the world and retained resources before retrying' }],
        }),
      });
    },
    async saveAndVerify(resources, before) {
      if (before.facts.worldPartition.enabled) return stageResult('saveVerify', 'unsupported', {
        code: 'external_actor_persistence_unavailable',
        summary: 'Native level_save verifies only the map package; external actor packages cannot be verified',
        remediation: [{ code: 'save_external_actors', label: 'Save and verify the imported external actor packages in the editor' }],
      });
      const current = await inspectWorld();
      if (current.facts.currentLevel !== before.facts.currentLevel || current.facts.worldPackage !== before.facts.worldPackage || current.facts.saveReady !== true) {
        return stageResult('saveVerify', 'failed', { code: 'world_changed_before_save', summary: 'Original world is no longer open and save-ready' });
      }
      // Native world_inspect reports each actor's actual owning package. Never
      // assume a world or object path identifies the package level_save writes.
      const affected = resources.filter((resource) => resource.kind === 'landscape').map((resource) =>
        current.facts.landscapeActors.find((actor) => actor.path === resource.path));
      if (!affected.length || affected.some((actor) => actor?.package !== before.facts.currentLevel)) {
        return stageResult('saveVerify', 'unsupported', { code: 'affected_package_persistence_unavailable',
          summary: 'Imported resource packages are unknown or differ from the intended current level',
          remediation: [{ code: 'save_affected_packages', label: 'Inspect and save the imported resource packages explicitly' }] });
      }
      const saved = await executeCommand<{ status?: string; ok?: boolean; path?: string; saved?: boolean; verified?: boolean; dirty?: boolean }>(SAVE_LEVEL_COMMAND, { path: before.facts.currentLevel });
      if (saved?.status === 'plan_mode_required') return approvalRequired('saveVerify');
      return stageResult('saveVerify', saved?.ok !== false && saved?.path === before.facts.currentLevel && saved.saved === true && saved.verified === true && saved.dirty === false ? 'succeeded' : 'failed', {
        summary: 'Save requires native readback of a clean package that exists on disk',
      });
    },
    async validateWorld(resources, before) {
      const after = await inspectWorld();
      const paths = new Set(after.facts.landscapeActors.map((actor) => actor.path));
      const verified = after.facts.currentLevel === before.facts.currentLevel && after.facts.worldPackage === before.facts.worldPackage
        && resources.filter((resource) => resource.kind === 'landscape').every((resource) => paths.has(resource.path));
      return stageResult('validate', verified ? 'succeeded' : 'failed', {
        summary: 'Validation checks the current level and presence of imported landscapes; no geometry or performance validation',
      });
    },
  };
}

export const worldIngestDescriptor = defineTool({
  name: 'world_ingest',
  description: 'Inspect, plan, import, prepare, save, and verify world content with explicit capability and partial-failure results.',
  schema: WorldIngestRequestSchema.shape,
  inputSchema: WorldIngestRequestSchema,
  meta: {
    cost: 'high', effects: ['imports_landscape', 'modifies_level', 'writes-to-disk'],
    when: 'planning or ingesting terrain with explicit partition and preparation policies',
    not_when: 'only inspecting the open world or preparing an existing mesh',
  },
  cost: 'high', returns: 'WorkflowResult with ordered stages, retained resources, verdicts, and remediation.',
  handler: async (request, session) => {
    const result = await runWorldIngest(WorldIngestRequestSchema.parse(request), createNativeWorldIngestDependencies(session));
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok && !workflowNeedsApproval(result) };
  },
});

async function partition(context: Context): Promise<WorkflowStageResult> {
  const policy = context.request.partition;
  if (!policy || policy.mode === 'preserve') return stageResult('partition', 'skipped');
  const limitations = partitionLimitations(context);
  const results: WorkflowStageResult[] = [];
  if (partitionNeedsWrite(context) && !limitations.some((issue) => issue.code.startsWith('world_partition'))) {
    const { hlod: _hlod, ...configuration } = policy;
    const result = completedStageResult(await context.dependencies.configurePartition!(configuration));
    retain(context, result.affectedResources);
    if (result.code === 'plan_mode_required') return result;
    if (result.code === 'stage_incomplete') return result;
    results.push(result);
  }
  if (!results.some((result) => result.status === 'failed') && hlodRequested(policy)
    && !limitations.some((issue) => issue.code === 'hlod_unavailable')) {
    const result = completedStageResult(await context.dependencies.configureHlod!(policy.hlod!));
    retain(context, result.affectedResources);
    if (result.code === 'plan_mode_required') return result;
    if (result.code === 'stage_incomplete') return result;
    results.push(result);
  }
  const failure = results.find((result) => result.status === 'failed');
  const unsupported = results.find((result) => result.status === 'unsupported');
  if ((unsupported && policy.mode === 'require') || (unsupported && policy.hlod?.build === 'require')) context.blocked = true;
  return stageResult('partition', failure ? 'failed' : limitations.length || unsupported ? 'unsupported' : 'succeeded', {
    code: failure?.code ?? unsupported?.code ?? limitations[0]?.code,
    affectedResources: results.flatMap((result) => result.affectedResources),
    warnings: [...limitations.map((issue) => issue.code), ...results.flatMap((result) => result.warnings)],
    remediation: results.flatMap((result) => result.remediation),
    summary: results.length ? 'Requested supported partition settings applied' : 'Existing partition settings preserved',
  });
}

async function assets(context: Context): Promise<WorkflowStageResult> {
  const materialUnsupported = context.request.materials?.mode === 'create';
  const meshes = context.resources.filter((entry) => entry.kind === 'asset');
  const warnings: string[] = materialUnsupported ? ['material_creation_unavailable'] : [];
  const remediation: WorkflowResult['remediation'] = [];
  let unsupported = materialUnsupported;
  if (context.request.assets && meshes.length && !context.dependencies.prepareAsset) {
    return stageResult('assets', 'unsupported', { code: 'asset_preparation_unavailable' });
  }
  for (const resource of context.request.assets ? meshes : []) {
    const result = await context.dependencies.prepareAsset!({ assetPath: resource.path ?? resource.id, policy: context.request.assets! });
    retain(context, result.affectedResources);
    if (workflowNeedsApproval(result)) return { ...approvalRequired('assets'), affectedResources: result.affectedResources };
    warnings.push(...result.stages.flatMap((stage) => stage.warnings), ...result.verdicts.filter((verdict) => verdict.severity !== 'info').map((verdict) => verdict.message));
    remediation.push(...result.remediation);
    unsupported ||= result.stages.some((stage) => stage.status === 'unsupported');
    if (!result.ok) return stageResult('assets', 'failed', {
      code: 'asset_preparation_failed', summary: result.summary,
      affectedResources: result.affectedResources, remediation, warnings,
    });
  }
  return stageResult('assets', unsupported ? 'unsupported' : context.request.assets && meshes.length ? 'succeeded' : 'skipped', {
    ...(unsupported ? { code: materialUnsupported ? 'material_creation_unavailable' : 'asset_preparation_partial' } : {}),
    warnings, remediation,
    summary: meshes.length ? 'Mesh preparation results aggregated' : 'No imported meshes require preparation',
  });
}

function retain(context: Context, resources: ResourceRef[]): void {
  for (const resource of resources) {
    if (!context.resources.some((entry) => entry.kind === resource.kind && entry.id === resource.id)) context.resources.push(resource);
    if (!context.stageResources.some((entry) => entry.kind === resource.kind && entry.id === resource.id)) context.stageResources.push(resource);
  }
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).value || 'Workflow stage failed';
}

function completedStageResult(result: WorkflowStageResult): WorkflowStageResult {
  if (result.status === 'pending' && result.code === 'plan_mode_required') return result;
  return result.status === 'pending' || result.status === 'running'
    ? { ...result, status: 'failed', code: 'stage_incomplete', summary: 'Dependency returned without completing the stage' }
    : result;
}

async function saveVerify(context: Context): Promise<WorkflowStageResult> {
  if (context.dependencies.persistence === 'legacy_import_only') return stageResult('saveVerify', 'skipped', {
    code: 'legacy_import_only', summary: 'Legacy import leaves changes unsaved; save explicitly after review',
  });
  return context.dependencies.saveAndVerify(context.resources, context.report!);
}

async function validate(context: Context): Promise<WorkflowStageResult> {
  if (context.request.validation?.mode === 'skip') return stageResult('validate', 'skipped');
  const result = context.dependencies.validateWorld
    ? await context.dependencies.validateWorld(context.resources, context.report!)
    : stageResult('validate', 'unsupported', { code: 'validation_unavailable' });
  if (result.status === 'unsupported' && context.request.validation?.mode === 'require') context.blocked = true;
  return result;
}

export async function runWorldIngest(request: WorldIngestRequest, dependencies: WorldIngestDependencies): Promise<WorkflowResult> {
  const context: Context = { request, dependencies, resources: [], stageResources: [] };
  const stages: WorkflowStageResult[] = [];
  for (const run of [inspect, normalize, plan, terrain, partition, assets, saveVerify, validate]) {
    const started = performance.now();
    context.stageResources = [];
    let result: WorkflowStageResult;
    if (dependencies.signal?.aborted) {
      context.blocked = true;
      result = stageResult(run.name, 'skipped', { code: 'cancelled', summary: 'Cancelled before starting the next stage' });
    } else {
      try {
        result = context.request.execution?.dryRun && stages.length >= 3
          ? stageResult(run.name, 'skipped', { code: 'dry_run', summary: 'Execution deferred by dry run' })
          : await run(context);
      } catch (error) {
        result = stageResult(run.name, 'failed', {
          code: `${run.name}_failed`, summary: errorMessage(error),
          remediation: [{ code: 'inspect_before_retry', label: 'Inspect affected resources before retrying' }],
        });
      }
    }
    retain(context, result.affectedResources);
    result = completedStageResult(result);
    result = { ...result, stage: run.name, durationMs: performance.now() - started, affectedResources: [...context.stageResources] };
    stages.push(result);
    if (result.code === 'plan_mode_required') context.blocked = true;
    if (result.status === 'unsupported' && ['inspect', 'normalize', 'plan', 'terrain', 'saveVerify'].includes(run.name)) context.blocked = true;
    if (context.blocked || result.status === 'failed') break;
  }
  const ok = !context.blocked && !stages.some((result) => result.status === 'failed');
  return {
    ok, operationId: `world-ingest:${randomUUID()}`,
    summary: workflowNeedsApproval({ stages }) ? 'World ingestion awaits Plan Mode approval'
      : !ok ? 'World ingestion stopped; inspect retained resources before retrying'
      : request.execution?.dryRun ? 'World ingestion dry run completed'
        : stages.some((result) => result.status === 'unsupported') ? 'World ingestion completed with unsupported optional capabilities'
          : 'World ingestion completed',
    stages, affectedResources: context.resources,
    verdicts: stages.filter((result) => result.status === 'unsupported' || result.status === 'failed' || result.code === 'cancelled' || result.code === 'plan_mode_required').map((result) => ({
      code: result.code ?? `${result.stage}_${result.status}`, message: result.summary ?? `${result.stage}: ${result.code ?? result.status}`,
      severity: !ok && result === stages.at(-1) && result.code !== 'plan_mode_required' ? 'error' : 'warning',
      direction: !ok && result === stages.at(-1) && result.code !== 'plan_mode_required' ? 'block' : 'review',
    })),
    remediation: stages.flatMap((result) => result.remediation),
    undo: { supported: false, description: 'No automatic rollback; completed resources are retained for inspection' },
  };
}
