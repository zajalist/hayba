import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { errorResult, okResult } from '../tool-result.js';

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const userCap = count.max(100_000_000);
const name = z.string().min(1).max(128);
const unknown = z.literal('unknown');
const snapshot = z.object({
  world: name,
  folder_scope: z.string().max(1024),
  coverage: z.object({
    scope: z.literal('currently_loaded_editor_actors'),
    folder_scope_kind: z.literal('path_aggregate_across_loaded_folder_roots'),
    folder_identity: z.literal('folder_path_only_root_identity_not_measured'),
    scan_complete: z.boolean(),
    scanned_actor_count: count,
    scan_limit_actors: count,
    world_partition_enabled: z.boolean(),
    unloaded_world_partition_actors: unknown,
    unloaded_pcg_generated_instances: unknown,
    internal_hayba_actors: z.literal('excluded'),
  }),
  measured_structure: z.object({
    loaded_actor_count: count,
    loaded_ism_hism_instance_count: count,
    folder_rows_scope: z.literal('path_aggregate_across_loaded_folder_roots'),
  }),
  production_performance_verdict: z.literal('unknown_not_measured'),
}).superRefine((v, ctx) => {
  if (v.coverage.scanned_actor_count > v.coverage.scan_limit_actors)
    ctx.addIssue({ code: 'custom', path: ['coverage', 'scanned_actor_count'], message: 'Scanned actor count exceeds scan limit' });
  if (v.measured_structure.loaded_actor_count > v.coverage.scanned_actor_count)
    ctx.addIssue({ code: 'custom', path: ['measured_structure', 'loaded_actor_count'], message: 'Loaded actor count exceeds scanned actor count' });
  if (!v.coverage.scan_complete && v.coverage.scanned_actor_count !== v.coverage.scan_limit_actors)
    ctx.addIssue({ code: 'custom', path: ['coverage', 'scan_complete'], message: 'A truncated native scan stops at its scan limit' });
});

const series = z.object({
  sample_count: z.number().int().min(0).max(600),
  min: z.number().finite().nonnegative().optional(),
  mean: z.number().finite().nonnegative().optional(),
  p50: z.number().finite().nonnegative().optional(),
  p95: z.number().finite().nonnegative().optional(),
  max: z.number().finite().nonnegative().optional(),
}).superRefine((v, ctx) => {
  for (const key of ['min', 'mean', 'p50', 'p95', 'max'] as const) {
    if ((v.sample_count > 0) !== (v[key] !== undefined)) ctx.addIssue({ code: 'custom', message: `${key} presence must match sample_count` });
  }
});
const capture = z.object({
  capture_id: z.string().min(1).max(64),
  status: z.literal('complete'),
  pie_instance: z.number().int().min(0).max(1024),
  warmup_frames_requested: z.number().int().min(0).max(120),
  sample_frames_requested: z.number().int().min(1).max(600),
  sample_frames_collected: z.number().int().min(0).max(600),
  samples_truncated: z.literal(false),
  timing_scope: z.literal('observed_core_ticker_interval_whole_editor_proxy_not_pie_exclusive'),
  memory_scope: z.literal('whole_editor_process_used_physical'),
  editor_ticker_interval_ms: series,
  editor_game_thread_ms: series,
  editor_render_thread_ms: series,
  process_used_physical_mb: series,
  tagged_runtime_actors: z.object({ tag: name, scope: z.literal('selected_pie_world_actor_tags'), ready: z.boolean(), max_actors_scanned: count, scan_truncated: z.boolean().optional(), count_is_lower_bound: z.boolean().optional(), count_in_scanned_prefix: count.optional(), actors_scanned: count.optional() }).superRefine((v, ctx) => {
    if (v.ready) {
      if (v.scan_truncated === undefined || v.count_is_lower_bound === undefined || v.count_in_scanned_prefix === undefined || v.actors_scanned === undefined)
        ctx.addIssue({ code: 'custom', message: 'Ready tagged scan requires counts and truncation flags' });
      if (v.scan_truncated !== v.count_is_lower_bound)
        ctx.addIssue({ code: 'custom', message: 'Lower-bound flag must match truncation' });
      if (v.actors_scanned !== undefined && v.actors_scanned > v.max_actors_scanned)
        ctx.addIssue({ code: 'custom', message: 'Tagged actors scanned exceeds bound' });
      if (v.count_in_scanned_prefix !== undefined && v.actors_scanned !== undefined && v.count_in_scanned_prefix > v.actors_scanned)
        ctx.addIssue({ code: 'custom', message: 'Tag matches exceed actors scanned' });
    } else if (v.scan_truncated !== undefined || v.count_is_lower_bound !== undefined || v.count_in_scanned_prefix !== undefined || v.actors_scanned !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'Unready tagged scan must not claim counts' });
    }
  }).optional(),
  gpu_time: z.literal('unknown_unsupported'),
  real_wp_cell_count: z.literal('unknown_unsupported'),
  npc_ai_cost: z.literal('unknown_unsupported'),
  performance_verdict: z.literal('unknown_no_pie_exclusive_measurement'),
}).superRefine((v, ctx) => {
  if (v.sample_frames_collected !== v.sample_frames_requested)
    ctx.addIssue({ code: 'custom', path: ['sample_frames_collected'], message: 'Complete native capture must collect requested samples' });
  for (const key of ['editor_ticker_interval_ms', 'editor_game_thread_ms', 'editor_render_thread_ms', 'process_used_physical_mb'] as const) {
    if (v[key].sample_count > v.sample_frames_collected)
      ctx.addIssue({ code: 'custom', path: [key, 'sample_count'], message: 'Metric samples exceed collected ticker samples' });
  }
});
const side = z.object({ scenario_id: name, protocol_id: name, snapshot, capture: capture.optional() });
export const schema = z.object({
  baseline: side,
  candidate: side,
  max_loaded_actors: userCap.optional().describe('Optional caller-supplied loaded actor cap. Headroom and verdict require two complete, matching scans.'),
  max_loaded_ism_instances: userCap.optional().describe('Optional caller-supplied loaded ISM/HISM instance cap. This is not a runtime performance budget.'),
}).strict().refine((v) => JSON.stringify(v).length <= 100_000, { message: 'Comparison input exceeds 100 KB' });

export const meta: HaybaToolMeta = {
  cost: 'low', effects: [],
  when: 'comparing two supplied world_budget_snapshot records and optionally two completed editor_pie_capture_get records under one stated protocol',
  not_when: 'scoring design, GPU, streaming, NPC cost, or production performance',
};

type Input = z.infer<typeof schema>;
function metric(baseline: number, candidate: number, unit: string, comparable = true) {
  return { baseline, candidate, delta: comparable ? candidate - baseline : null, unit,
    interpretation: comparable ? 'comparable_observed_counts' : 'unknown_incomplete_or_incompatible_coverage' };
}
function cap(actual: number, maximum: number | undefined, complete: boolean) {
  if (maximum === undefined) return undefined;
  return { maximum_count: maximum, observed_loaded_count: actual,
    headroom_count: complete ? maximum - actual : null,
    verdict: complete ? (actual <= maximum ? 'within_user_cap' : 'exceeds_user_cap') : 'unknown_scan_incomplete' };
}
export function compareWorldSnapshots(input: Input) {
  const { baseline: b, candidate: c } = input;
  if (b.scenario_id === c.scenario_id) throw new Error('Scenario IDs must differ');
  if (b.protocol_id !== c.protocol_id) throw new Error('Protocol IDs differ');
  if (b.snapshot.world !== c.snapshot.world || b.snapshot.folder_scope !== c.snapshot.folder_scope) throw new Error('World or folder scope differs');
  if (b.snapshot.coverage.world_partition_enabled !== c.snapshot.coverage.world_partition_enabled) throw new Error('World Partition setting differs');
  if (b.snapshot.coverage.scan_limit_actors !== c.snapshot.coverage.scan_limit_actors) throw new Error('Structural scan limits differ');
  if (!!b.capture !== !!c.capture) throw new Error('Captures must be supplied for both scenarios or neither');
  if (b.capture && c.capture) {
    if (b.capture.capture_id === c.capture.capture_id) throw new Error('Capture IDs must differ');
    if (b.capture.pie_instance !== c.capture.pie_instance || b.capture.warmup_frames_requested !== c.capture.warmup_frames_requested || b.capture.sample_frames_requested !== c.capture.sample_frames_requested || b.capture.timing_scope !== c.capture.timing_scope || b.capture.memory_scope !== c.capture.memory_scope || b.capture.tagged_runtime_actors?.tag !== c.capture.tagged_runtime_actors?.tag || b.capture.tagged_runtime_actors?.max_actors_scanned !== c.capture.tagged_runtime_actors?.max_actors_scanned) throw new Error('Capture protocol differs');
    if (b.capture.editor_ticker_interval_ms.sample_count !== b.capture.sample_frames_collected || c.capture.editor_ticker_interval_ms.sample_count !== c.capture.sample_frames_collected) throw new Error('Capture sample counts are inconsistent');
  }
  const bm = b.snapshot.measured_structure, cm = c.snapshot.measured_structure;
  const complete = b.snapshot.coverage.scan_complete && c.snapshot.coverage.scan_complete;
  const result: Record<string, unknown> = {
    baseline_scenario_id: b.scenario_id, candidate_scenario_id: c.scenario_id, protocol_id: b.protocol_id,
    scope: { world: b.snapshot.world, folder_path_aggregate: b.snapshot.folder_scope, loaded_editor_actors_only: true },
    evidence: { protocol_attestation: 'caller_supplied_not_verified', structural_scan_complete_both: complete, structural_delta_interpretation: complete ? 'complete_loaded_scope' : 'unknown_incomplete_scans', baseline_scanned_actor_count: b.snapshot.coverage.scanned_actor_count, candidate_scanned_actor_count: c.snapshot.coverage.scanned_actor_count, scan_limit_actors: b.snapshot.coverage.scan_limit_actors, unloaded_world_partition_actors: 'unknown', unloaded_pcg_generated_instances: 'unknown' },
    measured_structure: {
      loaded_actors: metric(bm.loaded_actor_count, cm.loaded_actor_count, 'actors', complete),
      loaded_ism_hism_instances: metric(bm.loaded_ism_hism_instance_count, cm.loaded_ism_hism_instance_count, 'instances', complete),
    },
    user_structural_caps: {
      ...(input.max_loaded_actors === undefined ? {} : { loaded_actors: { baseline: cap(bm.loaded_actor_count, input.max_loaded_actors, complete), candidate: cap(cm.loaded_actor_count, input.max_loaded_actors, complete) } }),
      ...(input.max_loaded_ism_instances === undefined ? {} : { loaded_ism_hism_instances: { baseline: cap(bm.loaded_ism_hism_instance_count, input.max_loaded_ism_instances, complete), candidate: cap(cm.loaded_ism_hism_instance_count, input.max_loaded_ism_instances, complete) } }),
    },
    unsupported: { gpu_time: 'unknown_unsupported', streaming: 'unknown_unsupported', npc_ai_cost: 'unknown_unsupported', design_score: 'unknown_unsupported', production_performance_verdict: 'unknown_not_measured' },
  };
  if (b.capture && c.capture) {
    const fields = ['editor_ticker_interval_ms', 'editor_game_thread_ms', 'editor_render_thread_ms', 'process_used_physical_mb'] as const;
    const captureMetrics: Record<string, unknown> = {};
    for (const field of fields) {
      const bs = b.capture[field], cs = c.capture[field];
      const matchedSamples = bs.sample_count === b.capture.sample_frames_requested && cs.sample_count === c.capture.sample_frames_requested;
      const stats: Record<string, unknown> = { baseline_sample_count: bs.sample_count, candidate_sample_count: cs.sample_count,
        comparison: matchedSamples ? 'complete_matched_proxy_samples' : 'unknown_missing_or_partial_metric_samples',
        unit: field === 'process_used_physical_mb' ? 'MiB' : 'ms' };
      for (const stat of ['min', 'mean', 'p50', 'p95', 'max'] as const) stats[stat] = bs[stat] === undefined || cs[stat] === undefined ? null : metric(bs[stat], cs[stat], field === 'process_used_physical_mb' ? 'MiB' : 'ms', matchedSamples);
      captureMetrics[field] = stats;
    }
    result.pie_proxy_capture = { baseline_capture_id: b.capture.capture_id, candidate_capture_id: c.capture.capture_id, timing_scope: b.capture.timing_scope, memory_scope: b.capture.memory_scope, sample_frames_requested: b.capture.sample_frames_requested, warmup_frames_requested: b.capture.warmup_frames_requested, series: captureMetrics };
    if (b.capture.tagged_runtime_actors && c.capture.tagged_runtime_actors) {
      const bt = b.capture.tagged_runtime_actors, ct = c.capture.tagged_runtime_actors;
      const tagged: Record<string, unknown> = { tag: bt.tag, baseline_ready: bt.ready, candidate_ready: ct.ready };
      if (bt.ready && ct.ready && bt.count_in_scanned_prefix !== undefined && ct.count_in_scanned_prefix !== undefined && bt.actors_scanned !== undefined && ct.actors_scanned !== undefined) {
        tagged.baseline = { count_in_scanned_prefix: bt.count_in_scanned_prefix, actors_scanned: bt.actors_scanned, lower_bound: bt.count_is_lower_bound };
        tagged.candidate = { count_in_scanned_prefix: ct.count_in_scanned_prefix, actors_scanned: ct.actors_scanned, lower_bound: ct.count_is_lower_bound };
        tagged.comparison = bt.scan_truncated || ct.scan_truncated
          ? 'unknown_truncated_lower_bounds_not_subtractable'
          : metric(bt.count_in_scanned_prefix, ct.count_in_scanned_prefix, 'actors');
      } else {
        tagged.comparison = 'unknown_tag_scan_not_ready';
      }
      (result.pie_proxy_capture as Record<string, unknown>).tagged_runtime_actors = tagged;
    }
  }
  return result;
}

export const worldCompareSnapshotsHandler: ToolHandler = async (args) => {
  if (JSON.stringify(args).length > 100_000) return errorResult('Comparison input exceeds 100 KB');
  const parsed = schema.safeParse(args);
  if (!parsed.success) return errorResult('Invalid comparison input', { issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) });
  try { return okResult(compareWorldSnapshots(parsed.data)); }
  catch (e) { return errorResult((e as Error).message); }
};
