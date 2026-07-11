import { describe, it, expect, vi, beforeEach } from 'vitest';

const runUePythonJsonMock = vi.fn();
const executeCommandMock = vi.fn(async () => ({}) as unknown);

vi.mock('../ue-python.js', () => ({
  runUePythonJson: (...args: unknown[]) => runUePythonJsonMock(...(args as [])),
  pyStr: (s: string) => JSON.stringify(s),
}));
vi.mock('../tool-executor.js', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
}));

import { pcgCookAndWaitHandler } from './pcg-cook-and-wait.js';

describe('pcg_cook_and_wait', () => {
  beforeEach(() => {
    runUePythonJsonMock.mockReset();
    executeCommandMock.mockReset();
    executeCommandMock.mockResolvedValue({ idle: true });
  });

  it('returns ok when the cook yields instances', async () => {
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, actor_path: '/Game/Map.Actor_0' }) // generate
      .mockResolvedValueOnce({ ok: true, total: 42, ism: [{ mesh: '/Game/SM', count: 42 }] }); // inspect
    const r = await pcgCookAndWaitHandler({ actor: 'Actor_0', timeout_s: 5 });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('"ok": true');
  });

  it('hard-fails (ok:false) when the cook produces ZERO instances', async () => {
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, actor_path: '/Game/Map.Actor_0' }) // generate
      .mockResolvedValueOnce({ ok: true, total: 0, ism: [] }); // inspect: nothing spawned
    const r = await pcgCookAndWaitHandler({ actor: 'Actor_0', timeout_s: 5 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('"ok": false');
    expect(r.content[0].text).toMatch(/0 instances/);
    expect(r.content[0].text).toMatch(/mesh binding/);
  });

  it('treats a missing total as zero and hard-fails', async () => {
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, actor_path: '/Game/Map.Actor_0' })
      .mockResolvedValueOnce({ ok: true, ism: [] }); // no total field
    const r = await pcgCookAndWaitHandler({ actor: 'Actor_0', timeout_s: 5 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('"ok": false');
  });

  it('surfaces a generate failure', async () => {
    runUePythonJsonMock.mockResolvedValueOnce({ ok: false, error: 'actor not found' });
    const r = await pcgCookAndWaitHandler({ actor: 'Nope', timeout_s: 5 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/generate failed.*actor not found/);
  });
});
