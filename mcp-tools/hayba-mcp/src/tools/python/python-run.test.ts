import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PYTHON_SCRIPT_CHARS, PYTHON_CRASH_RULES } from '../guards/known-crashers.js';
import { nativeFailureFacts, pythonRunHandler } from './python-run.js';

// Installed on the ToolExecutor seam rather than mocking the tcp-client module
// — same (cmd, params, timeoutMs) signature, so the assertions are unchanged.
const send = vi.fn();
import { setDefaultSender } from '../tool-executor.js';

describe('python_run crash guard + bounded inline output', () => {
  it('refuses a known-crasher script without contacting UE', async () => {
    send.mockClear();
    setDefaultSender(send);
    const r = await pythonRunHandler({ script: 'm.build_scale3d(v)' }, {} as never);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('HCR-STATICMESH-001');
    expect(r.content[0].text).toContain('Safe alternative:');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not let allow_unsafe bypass an editor-crash guard', async () => {
    send.mockClear();
    setDefaultSender(send);
    const r = await pythonRunHandler({ script: 'm.build_scale3d(v)', allow_unsafe: true }, {} as never);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('non-bypassable');
    expect(send).not.toHaveBeenCalled();
  });

  it('normalizes case and whitespace before the early crash check', async () => {
    send.mockClear();
    setDefaultSender(send);
    const r = await pythonRunHandler(
      {
        script: 'unreal.EditorLoadingAndSavingUtils . LOAD_MAP ("/Game/X")',
        allow_unsafe: true,
      },
      {} as never,
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('HCR-WORLD-001');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects wildcard imports before UE with the stable dynamic-policy code', async () => {
    send.mockClear();
    setDefaultSender(send);
    const r = await pythonRunHandler({ script: 'from math import *', allow_unsafe: true }, {} as never);
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.policy_code).toBe('HCR-DYNAMIC-001');
    expect(payload.matched_rule).toBe('wildcard import');
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects every fatal rule before UE, including with allow_unsafe', async () => {
    send.mockClear();
    setDefaultSender(send);

    for (const rule of PYTHON_CRASH_RULES) {
      for (const pattern of rule.patterns) {
        const r = await pythonRunHandler({ script: pattern, allow_unsafe: true }, {} as never);
        expect(r.isError, `${rule.code}: ${pattern}`).toBe(true);
        const text = r.content.map((c) => ('text' in c ? c.text : '')).join('\n');
        expect(text).toContain(rule.code);
        expect(text).toContain('Retry unchanged: forbidden');
      }
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects oversized scripts before UE with a stable non-retryable code', async () => {
    send.mockClear();
    setDefaultSender(send);
    const r = await pythonRunHandler(
      { script: 'x'.repeat(MAX_PYTHON_SCRIPT_CHARS + 1), allow_unsafe: true },
      {} as never,
    );
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.policy_code).toBe('HCR-SIZE-001');
    expect(payload.retry_unchanged).toBe('forbidden');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses direct Tier-3 source before UE even with legacy allow_unsafe', async () => {
    send.mockClear();
    setDefaultSender(send);
    const r = await pythonRunHandler({ script: 'open("C:/Temp/hayba.txt", "w")', allow_unsafe: true }, {} as never);
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.policy_code).toBe('HCR-SANDBOX-001');
    expect(payload.policy_phase).toBe('pre_execute');
    expect(payload.allow_unsafe_requested).toBe(true);
    expect(payload.allow_unsafe_effective).toBe(false);
    expect(payload.allow_unsafe_deprecated).toBe(true);
    expect(payload.retry_with_allow_unsafe).toBeUndefined();
    expect(payload.tracking_issues).toEqual(['#392', '#414']);
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts but strips allow_unsafe from a non-Tier-3 compatibility request', async () => {
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({ ok: true, data: { ok: true, stdout: 'bounded' } });
    const r = await pythonRunHandler({ script: 'print(1)', allow_unsafe: true }, {} as never);
    expect(r.isError).toBeFalsy();
    expect(send).toHaveBeenCalledWith('python_run', { script: 'print(1)' }, expect.anything());
    const payload = JSON.parse(r.content[0].text);
    expect(payload.allow_unsafe_requested).toBe(true);
    expect(payload.allow_unsafe_effective).toBe(false);
    expect(payload.allow_unsafe_deprecated).toBe(true);
  });

  it('forwards deadline_s, world_partition and transaction to the native handler', async () => {
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({ ok: true, data: { ok: true, stdout: '' } });
    const r = await pythonRunHandler(
      { script: 'print(1)', deadline_s: 30, world_partition: true, transaction: false },
      {} as never,
    );
    expect(r.isError).toBeFalsy();
    expect(send).toHaveBeenCalledWith(
      'python_run',
      { script: 'print(1)', deadline_s: 30, world_partition: true, transaction: false },
      expect.anything(),
    );
  });

  it('rejects a deadline_s outside 5..60 before UE', async () => {
    send.mockClear();
    setDefaultSender(send);
    const r = await pythonRunHandler({ script: 'print(1)', deadline_s: 600 }, {} as never);
    expect(r.isError).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves an authoritative native policy code and recovery response', async () => {
    send.mockClear();
    setDefaultSender(send);
    const nativeMessage =
      "python_run policy_blocked [HCR-SANDBOX-001]: matched 'tier_3_filesystem_or_subprocess'. " +
      'Safe alternative: use a typed tool. Retry unchanged: forbidden.';
    send.mockResolvedValueOnce({ ok: false, error: nativeMessage });

    // Alias expansion is authoritative in native C++; the sidecar direct-source
    // mirror intentionally lets this spelling reach the mocked native seam.
    const r = await pythonRunHandler({ script: 'import os as files\nfiles.remove(target)' }, {} as never);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.policy_code).toBe('HCR-SANDBOX-001');
    expect(payload.retry_unchanged).toBe('forbidden');
    expect(payload.allow_unsafe_effective).toBe(false);
    expect(payload.allow_unsafe_deprecated).toBe(true);
    expect(payload.retry_with_allow_unsafe).toBeUndefined();
    expect(payload.error).toContain('Safe alternative:');
  });

  it('preserves non-bypassable runtime deadline codes from native UE', async () => {
    send.mockClear();
    setDefaultSender(send);
    const nativeMessage =
      "python_run policy_blocked [HCR-TIME-001]: matched 'execution_deadline'. " +
      'Safe alternative: split the work. Retry unchanged: forbidden.';
    send.mockResolvedValueOnce({ ok: false, error: nativeMessage });

    const r = await pythonRunHandler({ script: 'for _ in range(10**12): x = 1' }, {} as never);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.policy_code).toBe('HCR-TIME-001');
    expect(payload.retry_with_allow_unsafe).toBeUndefined();
  });

  it('bounds >12K output truthfully in memory and has no raw filesystem spill path', async () => {
    send.mockClear();
    setDefaultSender(send);
    const sentinel = 'HAYBA_SENTINEL_RAW_TEMP_SPILL_383';
    const nativeStdout = `${'x'.repeat(20_000)}${sentinel}`;
    send.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        stdout: nativeStdout,
        stderr: '',
        stdout_truncated: false,
        stderr_truncated: false,
        stdout_chars_dropped: 0,
        stderr_chars_dropped: 0,
        capture_limit_chars_per_stream: 65_536,
      },
    });
    const r = await pythonRunHandler({ script: 'print("big")', allow_unsafe: true }, {} as never);
    const responseText = r.content[0].text;
    const payload = JSON.parse(responseText);

    expect(responseText.length).toBeLessThan(32 * 1_024);
    expect(responseText).not.toContain(sentinel);
    expect(payload.stdout_mcp_truncated).toBe(true);
    expect(payload.stdout_mcp_chars_dropped).toBe(nativeStdout.length - payload.stdout.length);
    expect(payload.stdout_native_truncated).toBe(false);
    expect(payload.stdout_native_chars_dropped).toBe(0);
    expect(payload.stdout_truncated).toBe(true);
    expect(payload.stdout_chars_dropped).toBe(payload.stdout_mcp_chars_dropped);
    expect(payload.mcp_result_truncated).toBe(true);
    expect(payload.output_truncated).toBe(true);
    expect(payload.output_complete).toBe(false);
    expect(payload.mcp_stream_limit_serialized_chars).toBe(12_000);
    expect(payload.mcp_output_policy).toBe('bounded_inline_no_filesystem_spill');
    expect(payload.allow_unsafe_requested).toBe(true);
    expect(payload.allow_unsafe_effective).toBe(false);
    expect(payload.allow_unsafe_deprecated).toBe(true);

    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'python-run.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]node:(?:fs|os|path)['"]/);
    expect(source).not.toContain('writeFileSync');
    expect(source).not.toContain('mkdirSync');
    expect(source).not.toContain('tmpdir');
    expect(source).not.toContain('hayba-python');
    expect(source).not.toContain('Full output written to:');
  });

  it('preserves native 64KiB capture loss separately from the bounded MCP view', async () => {
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: true,
        stdout: 'native bounded head',
        stderr: '',
        stdout_truncated: true,
        stderr_truncated: false,
        stdout_chars_dropped: 5_000,
        stderr_chars_dropped: 0,
        capture_limit_chars_per_stream: 65_536,
      },
    });

    const r = await pythonRunHandler({ script: 'print("native cap")' }, {} as never);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.capture_limit_chars_per_stream).toBe(65_536);
    expect(payload.stdout_native_truncated).toBe(true);
    expect(payload.stdout_native_chars_dropped).toBe(5_000);
    expect(payload.stdout_mcp_truncated).toBe(false);
    expect(payload.stdout_mcp_chars_dropped).toBe(0);
    expect(payload.stdout_truncated).toBe(true);
    expect(payload.stdout_chars_dropped).toBe(5_000);
    expect(payload.mcp_result_truncated).toBe(false);
    expect(payload.output_truncated).toBe(true);
    expect(payload.output_complete).toBe(false);
  });

  it('returns small output inline', async () => {
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({ ok: true, data: { ok: true, stdout: 'small' } });
    const r = await pythonRunHandler({ script: 'print("small")' }, {} as never);
    expect(r.content[0].text).toContain('small');
    const payload = JSON.parse(r.content[0].text);
    expect(payload.stdout).toBe('small');
    expect(payload.stdout_truncated).toBe(false);
    expect(payload.stdout_chars_dropped).toBe(0);
    expect(payload.mcp_result_truncated).toBe(false);
    expect(payload.output_truncated).toBe(false);
    expect(payload.output_complete).toBe(true);
  });
});

describe('python_run native fault facts (ADR-0011)', () => {
  const rules = [
    ['native_access_violation', 'execution'],
    ['post_execution_readback_access_violation', 'post_execution'],
    ['post_execution_status_access_violation', 'post_execution'],
    ['post_execution_deadline_readback_access_violation', 'post_execution'],
    ['post_execution_cleanup_access_violation', 'post_execution'],
  ] as const;

  it.each(rules)('maps %s to an unknown outcome that forbids retry', async (rule, executionPhase) => {
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({
      ok: false,
      code: 'native_fault_contained',
      error:
        "native_fault_contained [HCR-NATIVE-002]: 'python_run' raised native fault 0xC0000005 (python_native_fault); " +
        'its outcome is unknown and it may have partly run. Fault contained; restart the editor before further work.',
      data: {
        ok: false,
        policy_code: 'HCR-NATIVE-002',
        matched_rule: rule,
        execution_phase: executionPhase,
        phase: 'execute',
        mutation_status: 'unknown',
        may_have_executed: true,
        session_suspect: true,
      },
      editor_health: { editor_unsafe: true, python_unhealthy: true, cause: 'python_native_fault', fault_code: 'HCR-NATIVE-002' },
      advisory: { state: 'session_suspect', mutation_status: 'unknown', may_have_mutated: true, session_health: 'restart_required' },
    });
    const r = await pythonRunHandler({ script: 'print(1)' }, {} as never);
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    expect(payload).toMatchObject({
      code: 'native_fault_contained',
      policy_code: 'HCR-NATIVE-002',
      matched_rule: rule,
      mutation_status: 'unknown',
      may_have_executed: true,
      retry_unchanged: 'forbidden',
      restart_required: true,
    });
    expect(payload.editor_health.cause).toBe('python_native_fault');
    expect(payload.advisory.session_health).toBe('restart_required');
  });

  it('overrides a stale plugin that labelled a post-execution fault not_started', async () => {
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({
      ok: false,
      error:
        "python_run fatal_error [HCR-NATIVE-002]: matched 'post_execution_readback_access_violation'. The interpreter " +
        'faulted while reading captured output after the user script. Retry unchanged: forbidden; editor session health is suspect.',
      advisory: { state: 'policy_blocked', code: 'crash_guard_blocked', mutation_status: 'not_started', may_have_mutated: false },
    });
    const payload = JSON.parse((await pythonRunHandler({ script: 'print(1)' }, {} as never)).content[0].text);
    expect(payload).toMatchObject({
      policy_code: 'HCR-NATIVE-002',
      matched_rule: 'post_execution_readback_access_violation',
      mutation_status: 'unknown',
      may_have_executed: true,
      retry_unchanged: 'forbidden',
    });
    expect(payload.advisory).toMatchObject({ state: 'session_suspect', mutation_status: 'unknown', may_have_mutated: true });
  });

  it('reports a refusal after an earlier fault as not started, retry forbidden until restart', async () => {
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({
      ok: false,
      code: 'editor_unsafe_restart_required',
      error: "editor_unsafe_restart_required: 'python_run' was not run. …",
      editor_health: { editor_unsafe: true },
      advisory: { state: 'policy_blocked', mutation_status: 'not_started', session_health: 'restart_required' },
    });
    const payload = JSON.parse((await pythonRunHandler({ script: 'print(1)' }, {} as never)).content[0].text);
    expect(payload).toMatchObject({
      code: 'editor_unsafe_restart_required',
      mutation_status: 'not_started',
      may_have_executed: false,
      retry_unchanged: 'forbidden_until_restart',
      restart_required: true,
    });
    expect(payload.editor_health.editor_unsafe).toBe(true);
  });

  it('keeps pre-execution policy codes not_started, but never claims it for the post-execution deadline', async () => {
    expect(nativeFailureFacts({}, 'python_run policy_blocked [HCR-WORLD-001]: x', false)).toMatchObject({
      policy_code: 'HCR-WORLD-001',
      retry_unchanged: 'forbidden',
      mutation_status: 'not_started',
    });
    const deadline = nativeFailureFacts({}, 'python_run policy_blocked [HCR-TIME-001]: x', false);
    expect(deadline.policy_code).toBe('HCR-TIME-001');
    expect(deadline.mutation_status).toBeUndefined();
    expect(nativeFailureFacts(undefined, 'plain failure', false)).toEqual({});
  });
});
