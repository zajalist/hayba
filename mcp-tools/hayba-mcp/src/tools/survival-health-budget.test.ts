import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

describe('survival health budget and owned host proof', () => {
  it('preserves bounded fresh proof, partial phases, command timing and caller authority', () => {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
      join(scripts, 'test-survival-health-budget.ps1'), '-HarnessPath',
      join(scripts, 'test-editor-survival.ps1')], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (result.error) throw result.error;
    expect(result.stderr).toBe('');
    const cases = JSON.parse(result.stdout) as Array<{ name: string; passed: boolean; diagnostic?: string }>;
    expect(cases.map((item) => item.name)).toEqual([
      'monotonic_remaining', 'slowloris_deadline_preserves_recovery',
      'expired_transport_not_invoked', 'late_transport_rejected',
      'slow_preflight_cannot_satisfy_command_minimum', 'long_command_has_separate_duration',
      'partial_identity_failure', 'partial_listener_failure', 'partial_evidence_failure',
      'unique_listener_owner', 'foreign_listener_rejected', 'ambiguous_listener_rejected',
      'missing_process_rejected', 'ambiguous_process_rejected', 'queried_pid_mismatch_rejected',
      'synthetic_owner_all_caller_paths', 'read_declarations_are_narrow',
      'fresh_owned_helper_query',
      'owned_hanging_helper_exit', 'oversized_helper_output_rejected',
      'malformed_helper_output_rejected', 'nonzero_helper_exit_rejected',
      'unconfirmed_helper_exit_blocks_further_queries',
      'cleanup_identity_timeout_never_terminates',
      'startup_query_remaining_propagation', 'startup_identity_expiry_blocks_listener',
      'startup_post_ping_expiry_blocks_listener',
      'cleanup_later_query_timeout_never_terminates', 'cleanup_later_identity_mismatch_never_terminates',
      'cleanup_later_unconfirmed_helper_never_terminates', 'cleanup_wm_wait_identity_failure_never_forces',
      'cleanup_missing_listener_retains_owned_fallback',
    ]);
    expect(cases.filter((item) => !item.passed)).toEqual([]);
    expect(result.status).toBe(0);
  }, 35_000);
});
