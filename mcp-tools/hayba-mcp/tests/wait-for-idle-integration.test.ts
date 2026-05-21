import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setDefaultSender, type Sender } from '../src/tools/tool-executor.js';
import { handleWaitForIdle } from '../src/tools/wait-for-idle.js';
import { handleWaitForShaders } from '../src/tools/wait-for-shaders.js';

describe('wait-for-idle integration', () => {
  let sender: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sender = vi.fn(async (_cmd: string, _params: Record<string, unknown>, _timeout: number) => ({
      ok: true,
      data: { ok: true, durationMs: 12, settled: { shaders: { busyOnEntry: true, settledAtMs: 8 } } },
    }));
    setDefaultSender(sender as unknown as Sender);
  });

  it('returns the unwrapped UE response shape', async () => {
    const res = await handleWaitForIdle({ subsystems: ['shaders'], timeout_s: 5 } as never);
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.settled.shaders.busyOnEntry).toBe(true);
  });

  it('preserves timedOut on partial timeout', async () => {
    sender.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: false, durationMs: 5000,
        settled: { pcg: { busyOnEntry: true, settledAtMs: 5000 } },
        timedOut: ['pcg'],
      },
    });
    const res = await handleWaitForIdle({ subsystems: ['pcg'], timeout_s: 5 } as never);
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(false);
    expect(body.timedOut).toEqual(['pcg']);
  });

  it('wait-for-shaders wrapper delegates to wait_for_idle with shaders scope', async () => {
    await handleWaitForShaders({ max_seconds: 30, poll_seconds: 1 } as never);
    expect(sender).toHaveBeenCalledWith(
      'wait_for_idle',
      expect.objectContaining({ subsystems: ['shaders'], timeout_s: 30 }),
      35000,
    );
  });
});
