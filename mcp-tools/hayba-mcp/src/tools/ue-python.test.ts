import { describe, it, expect, beforeEach } from 'vitest';
import { runUePythonJson, pyStr } from './ue-python.js';
import { setDefaultSender, type Sender } from './tool-executor.js';

function mockStdout(stdout: string): Sender {
  const fn: Sender = async (_cmd: string, _params: Record<string, unknown>, _t: number) =>
    ({ id: 'inmem', ok: true, data: { ok: true, stdout } });
  return fn;
}

describe('pyStr', () => {
  it('escapes quotes, backslashes, newlines', () => {
    expect(pyStr("a'b")).toBe("'a\\'b'");
    expect(pyStr('a\\b')).toBe("'a\\\\b'");
    expect(pyStr('a\nb')).toBe("'a\\nb'");
  });
});

describe('runUePythonJson', () => {
  beforeEach(() => setDefaultSender(undefined as never));

  it('parses the HAYBA_JSON line out of mixed stdout', async () => {
    setDefaultSender(mockStdout('noise\nHAYBA_JSON:{"ok":true,"n":3}\ntrailing'));
    const r = await runUePythonJson<{ ok: boolean; n: number }>('x');
    expect(r).toEqual({ ok: true, n: 3 });
  });

  it('takes the LAST marker when several are printed', async () => {
    setDefaultSender(mockStdout('HAYBA_JSON:{"v":1}\nHAYBA_JSON:{"v":2}'));
    expect(await runUePythonJson<{ v: number }>('x')).toEqual({ v: 2 });
  });

  it('throws when no marker present', async () => {
    setDefaultSender(mockStdout('just some output'));
    await expect(runUePythonJson('x')).rejects.toThrow(/no HAYBA_JSON/);
  });
});

describe('plan-mode gate surfacing', () => {
  it('surfaces plan_mode_required clearly instead of "no HAYBA_JSON"', async () => {
    const fn: Sender = async (_c: string, _p: Record<string, unknown>, _t: number) =>
      ({ id: 'inmem', ok: true, data: { status: 'plan_mode_required', hint: 'click Approve' } });
    setDefaultSender(fn);
    await expect(runUePythonJson('x')).rejects.toThrow(/plan approval required.*click Approve/s);
  });
});
