import { describe, it, expect, vi } from 'vitest';
import { MAX_PYTHON_SCRIPT_CHARS, PYTHON_CRASH_RULES } from '../guards/known-crashers.js';

// Installed on the ToolExecutor seam rather than mocking the tcp-client module
// — same (cmd, params, timeoutMs) signature, so the assertions are unchanged.
const send = vi.fn();
import { setDefaultSender } from '../tool-executor.js';

describe('python_run crash guard + spill', () => {
  it('refuses a known-crasher script without contacting UE', async () => {
    const { pythonRunHandler } = await import('./python-run.js');
    send.mockClear();
    setDefaultSender(send);
    const r = await pythonRunHandler({ script: 'm.build_scale3d(v)' }, {} as never);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('HCR-STATICMESH-001');
    expect(r.content[0].text).toContain('Safe alternative:');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not let allow_unsafe bypass an editor-crash guard', async () => {
    const { pythonRunHandler } = await import('./python-run.js');
    send.mockClear();
    setDefaultSender(send);
    const r = await pythonRunHandler({ script: 'm.build_scale3d(v)', allow_unsafe: true }, {} as never);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('non-bypassable');
    expect(send).not.toHaveBeenCalled();
  });

  it('normalizes case and whitespace before the early crash check', async () => {
    const { pythonRunHandler } = await import('./python-run.js');
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
    const { pythonRunHandler } = await import('./python-run.js');
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
    const { pythonRunHandler } = await import('./python-run.js');
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
    const { pythonRunHandler } = await import('./python-run.js');
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
    const { pythonRunHandler } = await import('./python-run.js');
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
    const { pythonRunHandler } = await import('./python-run.js');
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

  it('preserves an authoritative native policy code and recovery response', async () => {
    const { pythonRunHandler } = await import('./python-run.js');
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
    const { pythonRunHandler } = await import('./python-run.js');
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

  it('spills oversized output to a temp file and returns a path', async () => {
    const { pythonRunHandler } = await import('./python-run.js');
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({ ok: true, data: { ok: true, stdout: 'x'.repeat(20_000) } });
    const r = await pythonRunHandler({ script: 'print("big")' }, {} as never);
    expect(r.content[0].text).toContain('Full output written to:');
    expect(r.content[0].text).toContain('output truncated');
  });

  it('returns small output inline', async () => {
    const { pythonRunHandler } = await import('./python-run.js');
    send.mockClear();
    setDefaultSender(send);
    send.mockResolvedValueOnce({ ok: true, data: { ok: true, stdout: 'small' } });
    const r = await pythonRunHandler({ script: 'print("small")' }, {} as never);
    expect(r.content[0].text).toContain('small');
    expect(r.content[0].text).not.toContain('Full output written to:');
  });
});
