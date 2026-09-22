import { z } from 'zod';

const PathSchema = z.string().min(1);

export const RuntimeGridPolicySchema = z.object({
  cellSize: z.number().positive().optional(),
  loadingRange: z.number().positive().optional(),
  name: z.string().min(1).optional(),
}).strict();

export const DataLayerPolicySchema = z.object({
  include: z.array(z.string().min(1)).optional(),
  exclude: z.array(z.string().min(1)).optional(),
}).strict();

export const HlodPolicySchema = z.object({
  layer: z.string().min(1).optional(),
  build: z.enum(['preserve', 'auto', 'require']).optional(),
}).strict();

export const PartitionOptionsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('preserve') }).strict(),
  z.object({
    mode: z.literal('configure'),
    runtimeGrid: RuntimeGridPolicySchema.optional(),
    dataLayers: DataLayerPolicySchema.optional(),
    hlod: HlodPolicySchema.optional(),
  }).strict(),
  z.object({
    mode: z.literal('require'),
    runtimeGrid: RuntimeGridPolicySchema.optional(),
    dataLayers: DataLayerPolicySchema.optional(),
    hlod: HlodPolicySchema.optional(),
  }).strict(),
]);

export const WorldSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('heightmap'), path: PathSchema, format: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal('landscape_export'), path: PathSchema }).strict(),
  z.object({ kind: z.literal('mesh_terrain'), path: PathSchema }).strict(),
  z.object({
    kind: z.literal('connector_artifact'),
    connector: z.string().min(1),
    artifactId: z.string().min(1),
  }).strict(),
]);

export const WorldDestinationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('open_world') }).strict(),
  z.object({ mode: z.literal('new_world'), path: PathSchema.optional() }).strict(),
  z.object({ mode: z.literal('managed_update'), importId: z.string().min(1) }).strict(),
]);

export const TerrainOptionsSchema = z.object({
  scale: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional(),
  material: z.string().min(1).optional(),
}).strict();

const LodPolicySchema = z.object({
  count: z.number().int().positive().optional(),
  reduction: z.number().min(0).max(1).optional(),
}).strict();

export const AssetPreparationPolicySchema = z.object({
  intent: z.enum(['environment', 'hero', 'foliage', 'terrain', 'custom']),
  nanite: z.enum(['preserve', 'auto', 'enable', 'disable']).optional(),
  collision: z.enum(['preserve', 'auto', 'simple', 'complex', 'none']).optional(),
  lods: z.union([z.enum(['preserve', 'auto']), LodPolicySchema]).optional(),
  lightmapUvs: z.enum(['preserve', 'generate', 'require']).optional(),
  materialInstances: z.enum(['preserve', 'create', 'require']).optional(),
}).strict();

export const MaterialPolicySchema = z.object({
  mode: z.enum(['preserve', 'create', 'require']).optional(),
}).strict();

export const ValidationPolicySchema = z.object({
  mode: z.enum(['skip', 'report', 'require']).optional(),
}).strict();

export const ExecutionPolicySchema = z.object({
  dryRun: z.boolean().optional(),
  planMode: z.boolean().optional(),
}).strict();

export const WorldIngestRequestSchema = z.object({
  source: WorldSourceSchema,
  destination: WorldDestinationSchema,
  terrain: TerrainOptionsSchema.optional(),
  partition: PartitionOptionsSchema.optional(),
  assets: AssetPreparationPolicySchema.optional(),
  materials: MaterialPolicySchema.optional(),
  validation: ValidationPolicySchema.optional(),
  execution: ExecutionPolicySchema.optional(),
}).strict();

export const ResourceRefSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  path: z.string().min(1).optional(),
}).strict();

export const DirectionalVerdictSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  direction: z.enum(['proceed', 'review', 'block']),
}).strict();

export const UndoDescriptorSchema = z.object({
  supported: z.boolean(),
  description: z.string().min(1),
}).strict();

export const RemediationActionSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
}).strict();

export const WorkflowStageStatusSchema = z.enum([
  'pending', 'running', 'succeeded', 'failed', 'skipped', 'unsupported',
]);

export const WorkflowStageResultSchema = z.object({
  stage: z.string().min(1),
  status: WorkflowStageStatusSchema,
  durationMs: z.number().nonnegative(),
  affectedResources: z.array(ResourceRefSchema),
  warnings: z.array(z.string().min(1)),
  remediation: z.array(RemediationActionSchema),
  code: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
}).strict();

export const WorkflowResultSchema = z.object({
  ok: z.boolean(),
  operationId: z.string().min(1),
  summary: z.string().min(1),
  stages: z.array(WorkflowStageResultSchema),
  affectedResources: z.array(ResourceRefSchema),
  verdicts: z.array(DirectionalVerdictSchema),
  undo: UndoDescriptorSchema.optional(),
  remediation: z.array(RemediationActionSchema),
}).strict();

export type WorldIngestRequest = z.infer<typeof WorldIngestRequestSchema>;
export type AssetPreparationPolicy = z.infer<typeof AssetPreparationPolicySchema>;
export type WorkflowResult = z.infer<typeof WorkflowResultSchema>;
export type WorkflowStageResult = z.infer<typeof WorkflowStageResultSchema>;

type StageResultDetails = Partial<Omit<WorkflowStageResult, 'stage' | 'status'>>;

export function stageResult(
  stage: string,
  status: WorkflowStageResult['status'] = 'succeeded',
  details: StageResultDetails = {},
): WorkflowStageResult {
  return WorkflowStageResultSchema.parse({
    stage,
    status,
    durationMs: 0,
    affectedResources: [],
    warnings: [],
    remediation: [],
    ...details,
  });
}

export function unsupportedStage(stage: string, code: string): WorkflowStageResult {
  return stageResult(stage, 'unsupported', { code });
}
