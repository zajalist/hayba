import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../tools/tool-executor.js', () => ({
  executeCommand: vi.fn(),
}));

import { executeCommand } from '../../tools/tool-executor.js';
import { liveUeProbe, MAX_VALIDATOR_PROBE_STDOUT_BYTES, probeCount, type UeProbe } from '../ue-probe.js';

beforeEach(() => {
  vi.mocked(executeCommand).mockReset();
});

const run = (probe: UeProbe | null) => probeCount(probe, { script: 'noop', key: 'total', timeoutMs: 100 });

describe('liveUeProbe', () => {
  it('uses the guarded production python_run path without allow_unsafe', async () => {
    vi.mocked(executeCommand).mockResolvedValue({ stdout: '{"total":3}' });

    await expect(liveUeProbe('print("ok")', 123)).resolves.toEqual({ ok: true, stdout: '{"total":3}' });
    expect(executeCommand).toHaveBeenCalledWith('python_run', { script: 'print("ok")' }, { timeout: 123 });
  });

  it('rejects oversized stdout instead of parsing a truncation', async () => {
    vi.mocked(executeCommand).mockResolvedValue({ stdout: 'x'.repeat(MAX_VALIDATOR_PROBE_STDOUT_BYTES + 1) });
    await expect(liveUeProbe('print("large")', 100)).resolves.toEqual({ ok: false, stdout: '' });
  });
});

describe('probeCount', () => {
  it('reads a legitimate zero from one exact stdout JSON object', async () => {
    expect(await run(async () => ({ ok: true, stdout: '{"total":0}' }))).toBe(0);
  });

  it('reads a positive safe integer', async () => {
    expect(await run(async () => ({ ok: true, stdout: '{"total":12}' }))).toBe(12);
  });

  it('rejects logs wrapped around JSON instead of regex-matching ambiguous evidence', async () => {
    expect(await run(async () => ({ ok: true, stdout: 'log\n{"total":5}\ndone' }))).toBeNull();
  });

  it.each(['{"total":-1}', '{"total":1.5}', '{"total":9007199254740992}', '{"total":"7"}', '[]', 'not-json'])(
    'rejects invalid counter evidence %s',
    async (stdout) => {
      expect(await run(async () => ({ ok: true, stdout }))).toBeNull();
    },
  );

  it('enforces the byte ceiling for injected probes too', async () => {
    const oversized = JSON.stringify({ total: 1, pad: 'x'.repeat(MAX_VALIDATOR_PROBE_STDOUT_BYTES) });
    expect(await run(async () => ({ ok: true, stdout: oversized }))).toBeNull();
  });

  it('returns null when there is no probe or the probe fails', async () => {
    expect(await run(null)).toBeNull();
    expect(await run(async () => ({ ok: false, stdout: '{"total":9}' }))).toBeNull();
  });
});
