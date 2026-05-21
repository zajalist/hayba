import { describe, it, expect, vi, beforeEach } from 'vitest';
import { schema, handleWaitForIdle } from './wait-for-idle.js';
import { setDefaultSender, type Sender } from './tool-executor.js';

describe('wait-for-idle schema', () => {
  it('accepts a subset of subsystems', () => {
    expect(schema.parse({ subsystems: ['pcg', 'shaders'], timeout_s: 30 }).subsystems)
      .toEqual(['pcg', 'shaders']);
  });
  it('subsystems is optional (means wait for all)', () => {
    const parsed = schema.parse({ timeout_s: 10 });
    expect(parsed.subsystems).toBeUndefined();
  });
  it('rejects unknown subsystem names', () => {
    expect(() => schema.parse({ subsystems: ['typo'], timeout_s: 10 } as never))
      .toThrow();
  });
  it('timeout_s default = 60', () => {
    expect(schema.parse({}).timeout_s).toBe(60);
  });
  it('timeout_s bounds [1, 600]', () => {
    expect(() => schema.parse({ timeout_s: 0 })).toThrow();
    expect(() => schema.parse({ timeout_s: 601 })).toThrow();
  });
  it('pcg_actors + world_ticks accepted', () => {
    const parsed = schema.parse({
      subsystems: ['pcg', 'world_tick'], timeout_s: 5, pcg_actors: ['/Game/X'], world_ticks: 3,
    });
    expect(parsed.pcg_actors).toEqual(['/Game/X']);
    expect(parsed.world_ticks).toBe(3);
  });
});

describe('handleWaitForIdle', () => {
  let sender: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sender = vi.fn(async (_cmd: string, _params: Record<string, unknown>, _timeout: number) => ({
      ok: true,
      data: { ok: true, durationMs: 42, settled: { shaders: { busyOnEntry: true, settledAtMs: 30 } } },
    }));
    setDefaultSender(sender as unknown as Sender);
  });

  it('dispatches wait_for_idle with timeout_s*1000 + 5000ms socket timeout', async () => {
    await handleWaitForIdle({ subsystems: ['shaders'], timeout_s: 10 } as never);
    expect(sender).toHaveBeenCalledWith(
      'wait_for_idle',
      expect.objectContaining({ subsystems: ['shaders'], timeout_s: 10 }),
      15000,
    );
  });

  it('returns the UE response in MCP content shape', async () => {
    const res = await handleWaitForIdle({ subsystems: ['shaders'], timeout_s: 10 } as never);
    expect(res.content[0].text).toContain('"ok": true');
  });
});
