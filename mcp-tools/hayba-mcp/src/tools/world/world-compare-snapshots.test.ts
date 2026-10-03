import { describe, expect, it } from 'vitest';
import { compareWorldSnapshots, schema, worldCompareSnapshotsHandler } from './world-compare-snapshots.js';

function snapshot(actors: number, instances: number, complete = true) {
  return {
    world: 'TestWorld', folder_scope: 'Market',
    coverage: {
      scope: 'currently_loaded_editor_actors', folder_scope_kind: 'path_aggregate_across_loaded_folder_roots',
      folder_identity: 'folder_path_only_root_identity_not_measured', scan_complete: complete,
      scanned_actor_count: actors, scan_limit_actors: 100000, world_partition_enabled: true,
      unloaded_world_partition_actors: 'unknown', unloaded_pcg_generated_instances: 'unknown', internal_hayba_actors: 'excluded',
    },
    measured_structure: { loaded_actor_count: actors, loaded_ism_hism_instance_count: instances, folder_rows_scope: 'path_aggregate_across_loaded_folder_roots' },
    production_performance_verdict: 'unknown_not_measured',
  };
}
function capture(id: string, mean: number) {
  const series = { sample_count: 2, min: mean - 1, mean, p50: mean - 1, p95: mean + 1, max: mean + 1 };
  return {
    capture_id: id, status: 'complete', pie_instance: 0, warmup_frames_requested: 5,
    sample_frames_requested: 2, sample_frames_collected: 2, samples_truncated: false,
    timing_scope: 'observed_core_ticker_interval_whole_editor_proxy_not_pie_exclusive',
    memory_scope: 'whole_editor_process_used_physical',
    editor_ticker_interval_ms: series, editor_game_thread_ms: series,
    editor_render_thread_ms: series, process_used_physical_mb: series,
    gpu_time: 'unknown_unsupported', real_wp_cell_count: 'unknown_unsupported',
    npc_ai_cost: 'unknown_unsupported', performance_verdict: 'unknown_no_pie_exclusive_measurement',
  };
}
function pair() {
  return {
    baseline: { scenario_id: 'before', protocol_id: 'same-route-v1', snapshot: snapshot(10, 100), capture: capture('a', 12) },
    candidate: { scenario_id: 'after', protocol_id: 'same-route-v1', snapshot: snapshot(12, 90), capture: capture('b', 10) },
    max_loaded_actors: 11,
  };
}
describe('world_compare_snapshots', () => {
  it('preserves counts, deltas, units, sample counts and only explicit user caps', () => {
    const result = compareWorldSnapshots(schema.parse(pair()));
    expect(result.measured_structure).toMatchObject({ loaded_actors: { baseline: 10, candidate: 12, delta: 2, unit: 'actors' }, loaded_ism_hism_instances: { delta: -10, unit: 'instances' } });
    expect(result.user_structural_caps).toMatchObject({ loaded_actors: { baseline: { verdict: 'within_user_cap', headroom_count: 1 }, candidate: { verdict: 'exceeds_user_cap', headroom_count: -1 } } });
    expect(result.user_structural_caps).not.toHaveProperty('loaded_ism_hism_instances');
    expect(result.pie_proxy_capture).toMatchObject({ series: { editor_ticker_interval_ms: { baseline_sample_count: 2, candidate_sample_count: 2, unit: 'ms', mean: { delta: -2, unit: 'ms' } } } });
    expect(result.unsupported).toMatchObject({ gpu_time: 'unknown_unsupported', streaming: 'unknown_unsupported', npc_ai_cost: 'unknown_unsupported', design_score: 'unknown_unsupported' });
  });
  it('reports incomplete structural evidence without claiming a full count', () => {
    const input = pair(); input.baseline.snapshot.coverage.scan_complete = false;
    input.baseline.snapshot.coverage.scanned_actor_count = input.baseline.snapshot.coverage.scan_limit_actors;
    const result = compareWorldSnapshots(schema.parse(input));
    expect(result.evidence).toMatchObject({ structural_scan_complete_both: false, structural_delta_interpretation: 'unknown_incomplete_scans', protocol_attestation: 'caller_supplied_not_verified' });
    expect(result.measured_structure).toMatchObject({ loaded_actors: { baseline: 10, candidate: 12, delta: null }, loaded_ism_hism_instances: { delta: null } });
    expect(result.user_structural_caps).toMatchObject({ loaded_actors: { baseline: { verdict: 'unknown_scan_incomplete', headroom_count: null }, candidate: { verdict: 'unknown_scan_incomplete', headroom_count: null } } });
  });
  it('accepts structural comparison without PIE captures', () => {
    const input = pair();
    const result = compareWorldSnapshots(schema.parse({
      baseline: { scenario_id: input.baseline.scenario_id, protocol_id: input.baseline.protocol_id, snapshot: input.baseline.snapshot },
      candidate: { scenario_id: input.candidate.scenario_id, protocol_id: input.candidate.protocol_id, snapshot: input.candidate.snapshot },
    }));
    expect(result).not.toHaveProperty('pie_proxy_capture');
    expect(result.measured_structure).toMatchObject({ loaded_actors: { delta: 2 } });
  });
  it('refuses scope, protocol and mismatched capture configurations', async () => {
    for (const mutate of [
      (v: ReturnType<typeof pair>) => { v.candidate.snapshot.folder_scope = 'Other'; },
      (v: ReturnType<typeof pair>) => { v.candidate.protocol_id = 'other'; },
      (v: ReturnType<typeof pair>) => { v.candidate.capture.warmup_frames_requested = 0; },
      (v: ReturnType<typeof pair>) => { v.candidate.capture.capture_id = 'a'; },
      (v: ReturnType<typeof pair>) => { v.candidate.capture.sample_frames_collected = 1; },
    ]) {
      const input = pair(); mutate(input);
      expect((await worldCompareSnapshotsHandler(input, {})).isError).toBe(true);
    }
  });
  it('rejects incomplete captures and oversized or unsupported input', async () => {
    const input = pair();
    expect(schema.safeParse({ ...input, gpu_score: 99 }).success).toBe(false);
    expect(schema.safeParse({ ...input, max_loaded_actors: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...input, candidate: { ...input.candidate, capture: { ...input.candidate.capture, status: 'running' } } }).success).toBe(false);
    expect((await worldCompareSnapshotsHandler({ ...input, padding: 'x'.repeat(100_001) }, {})).isError).toBe(true);
  });
  it('refuses impossible caller-supplied native counts before a cap verdict', () => {
    const input = pair();
    input.baseline.snapshot.coverage.scanned_actor_count = 1;
    expect(schema.safeParse(input).success).toBe(false);
    input.baseline.snapshot.coverage.scanned_actor_count = 100001;
    expect(schema.safeParse(input).success).toBe(false);
    input.baseline.snapshot.coverage.scanned_actor_count = 10;
    input.baseline.snapshot.coverage.scan_complete = false;
    expect(schema.safeParse(input).success).toBe(false);
  });
  it('accepts native instance counts above a user target without losing integer precision', () => {
    const input = pair();
    input.baseline.snapshot.measured_structure.loaded_ism_hism_instance_count = 100_000_001;
    expect(schema.safeParse(input).success).toBe(true);
  });
  it('refuses impossible complete capture sample relationships', () => {
    const input = pair();
    input.baseline.capture.sample_frames_collected = 1;
    input.baseline.capture.editor_ticker_interval_ms.sample_count = 1;
    expect(schema.safeParse(input).success).toBe(false);
    input.baseline.capture.sample_frames_collected = 2;
    input.baseline.capture.editor_ticker_interval_ms.sample_count = 2;
    input.baseline.capture.editor_game_thread_ms.sample_count = 3;
    expect(schema.safeParse(input).success).toBe(false);
  });
  it('does not subtract unequal metric sample windows even when both captures completed', () => {
    const input = pair();
    input.candidate.capture.editor_game_thread_ms = { sample_count: 1, min: 9, mean: 9, p50: 9, p95: 9, max: 9 };
    const result = compareWorldSnapshots(schema.parse(input));
    expect(result.pie_proxy_capture).toMatchObject({ series: {
      editor_game_thread_ms: { baseline_sample_count: 2, candidate_sample_count: 1, comparison: 'unknown_missing_or_partial_metric_samples', mean: { baseline: 12, candidate: 9, delta: null } },
      editor_ticker_interval_ms: { comparison: 'complete_matched_proxy_samples', mean: { delta: -2 } },
    } });
  });
  it('withholds metric deltas when both series have the same partial sample count', () => {
    const input = pair();
    const one = { sample_count: 1, min: 9, mean: 9, p50: 9, p95: 9, max: 9 };
    input.baseline.capture.editor_render_thread_ms = one;
    input.candidate.capture.editor_render_thread_ms = one;
    const result = compareWorldSnapshots(schema.parse(input));
    expect(result.pie_proxy_capture).toMatchObject({ series: {
      editor_render_thread_ms: { comparison: 'unknown_missing_or_partial_metric_samples', mean: { delta: null } },
    } });
  });
  it('requires the same tagged actor scan bound for comparable captures', async () => {
    const input = pair();
    const tag = (bound: number) => ({ tag: 'People', scope: 'selected_pie_world_actor_tags', ready: true,
      max_actors_scanned: bound, scan_truncated: false, count_is_lower_bound: false,
      count_in_scanned_prefix: 2, actors_scanned: 117 });
    const result = await worldCompareSnapshotsHandler({
      ...input,
      baseline: { ...input.baseline, capture: { ...input.baseline.capture, tagged_runtime_actors: tag(5000) } },
      candidate: { ...input.candidate, capture: { ...input.candidate.capture, tagged_runtime_actors: tag(2000) } },
    }, {});
    expect(result.isError).toBe(true);
  });
  it('keeps truncated tagged-actor scans as lower bounds without subtracting them', () => {
    const input = pair();
    const tag = (truncated: boolean) => ({ tag: 'People', scope: 'selected_pie_world_actor_tags', ready: true, max_actors_scanned: 5000, scan_truncated: truncated, count_is_lower_bound: truncated, count_in_scanned_prefix: 2, actors_scanned: truncated ? 5000 : 117 });
    const parsed = schema.parse({ baseline: { ...input.baseline, capture: { ...input.baseline.capture, tagged_runtime_actors: tag(true) } }, candidate: { ...input.candidate, capture: { ...input.candidate.capture, tagged_runtime_actors: tag(false) } } });
    expect(compareWorldSnapshots(parsed).pie_proxy_capture).toMatchObject({ tagged_runtime_actors: { baseline: { lower_bound: true }, comparison: 'unknown_truncated_lower_bounds_not_subtractable' } });
  });
});
