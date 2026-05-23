import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../../src/tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => ({ send: mockSend })),
}));

beforeEach(() => { mockSend.mockReset(); });

import { pythonRunHandler } from '../../src/tools/python/python-run.js';

const fakeSession = {} as any;

describe('python_run', () => {
  it('rejects empty script', async () => {
    const r = await pythonRunHandler({ script: '' }, fakeSession);
    expect(r.isError).toBe(true);
  });
  it('forwards correct cmd name and wraps the script for print->log_warning redirect', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: { stdout: 'hi' } });
    await pythonRunHandler({ script: 'print(1)' }, fakeSession);
    // The handler now wraps user source in a Python exec() shim that binds
    // builtin print to unreal.log_warning, so prints surface in
    // editor_stream_log instead of the swallowed UE stdout. See postmortem
    // §3.4 (2026-05-23-pcg-landscape-mcp-postmortem.md).
    expect(mockSend).toHaveBeenCalledWith(
      'python_run',
      expect.objectContaining({
        script: expect.stringContaining('_hayba_user_src = """print(1)"""'),
      }),
    );
    const payload = mockSend.mock.calls[0][1] as { script: string };
    expect(payload.script).toContain('unreal.log_warning');
  });
  it('surfaces tier-3 blocked error specifically', async () => {
    mockSend.mockResolvedValue({ id: '2', ok: false, error: 'unsafe', data: { tier: 3 } });
    const r = await pythonRunHandler({ script: 'import os; os.system("ls")' }, fakeSession);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Tier 3');
    expect(r.content[0].text).toContain('bAllowUnsafePython');
    expect(r.content[0].text).toContain('allow_unsafe');
  });
  it('surfaces generic TCP error', async () => {
    mockSend.mockResolvedValue({ id: '2', ok: false, error: 'syntax' });
    const r = await pythonRunHandler({ script: 'xx' }, fakeSession);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('syntax');
  });
});
