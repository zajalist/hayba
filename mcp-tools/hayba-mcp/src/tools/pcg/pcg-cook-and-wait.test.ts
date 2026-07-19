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

// The handler issues python calls in this order:
//   1. pre-cook ISM snapshot (freshness `before`)
//   2. generate
//   3. post-cook ISM inspect
// Tests queue mock responses in that order.

describe('pcg_cook_and_wait', () => {
  beforeEach(() => {
    runUePythonJsonMock.mockReset();
    executeCommandMock.mockReset();
    executeCommandMock.mockResolvedValue({ idle: true });
  });

  it('returns ok when the cook yields instances', async () => {
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, total: 25 }) // pre-cook snapshot
      .mockResolvedValueOnce({ ok: true, actor_path: '/Game/Map.Actor_0' }) // generate
      .mockResolvedValueOnce({ ok: true, total: 42, ism: [{ mesh: '/Game/SM', count: 42 }] }); // inspect
    const r = await pcgCookAndWaitHandler({ actor: 'Actor_0', timeout_s: 5 });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('"ok": true');
  });

  it('hard-fails (ok:false) when the cook produces ZERO instances', async () => {
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, total: 0 }) // pre-cook snapshot
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
      .mockResolvedValueOnce({ ok: true }) // pre-cook snapshot (no total)
      .mockResolvedValueOnce({ ok: true, actor_path: '/Game/Map.Actor_0' })
      .mockResolvedValueOnce({ ok: true, ism: [] }); // no total field
    const r = await pcgCookAndWaitHandler({ actor: 'Actor_0', timeout_s: 5 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('"ok": false');
  });

  it('surfaces a generate failure', async () => {
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, total: 0 }) // pre-cook snapshot
      .mockResolvedValueOnce({ ok: false, error: 'actor not found' }); // generate
    const r = await pcgCookAndWaitHandler({ actor: 'Nope', timeout_s: 5 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/generate failed.*actor not found/);
  });

  // §3b — a benign pcg idle-timeout with a NON-EMPTY result.ism must NOT report failure.
  it('does NOT report failure on a benign pcg idle-timeout when instances are present', async () => {
    executeCommandMock.mockResolvedValue({ timedOut: ['pcg'], busyOnEntry: true });
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, total: 25 }) // pre-cook snapshot
      .mockResolvedValueOnce({ ok: true, actor_path: '/Game/Map.Actor_0' }) // generate
      .mockResolvedValueOnce({ ok: true, total: 20, ism: [{ mesh: '/Game/SM', count: 20 }] }); // inspect
    const r = await pcgCookAndWaitHandler({ actor: 'Actor_0', timeout_s: 5 });
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.authoritative).toBe('result.ism');
    expect(payload.idle_note).toMatch(/BENIGN/);
    expect(payload.idle_note).toMatch(/SUCCEEDED/);
  });

  // §3b — a pcg idle-timeout WITH an empty ism is still a genuine failure.
  it('still fails on a pcg idle-timeout when the ism is empty', async () => {
    executeCommandMock.mockResolvedValue({ timedOut: ['pcg'], busyOnEntry: true });
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, total: 0 }) // pre-cook snapshot
      .mockResolvedValueOnce({ ok: true, actor_path: '/Game/Map.Actor_0' }) // generate
      .mockResolvedValueOnce({ ok: true, total: 0, ism: [] }); // inspect
    const r = await pcgCookAndWaitHandler({ actor: 'Actor_0', timeout_s: 5 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('"ok": false');
  });

  // §3c — the before/after freshness fields are present and computed from the snapshot.
  it('includes freshness {changed, before, after} proving the counts are from THIS cook', async () => {
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, total: 25 }) // pre-cook snapshot
      .mockResolvedValueOnce({ ok: true, actor_path: '/Game/Map.Actor_0' }) // generate
      .mockResolvedValueOnce({ ok: true, total: 20, ism: [{ mesh: '/Game/SM', count: 20 }] }); // inspect
    const r = await pcgCookAndWaitHandler({ actor: 'Actor_0', timeout_s: 5 });
    const payload = JSON.parse(r.content[0].text);
    expect(payload.freshness).toBeDefined();
    expect(payload.freshness.before).toBe(25);
    expect(payload.freshness.after).toBe(20);
    expect(payload.freshness.changed).toBe(true);
  });

  it('marks freshness.changed=null when the pre-cook snapshot is unavailable', async () => {
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: false }) // pre-cook snapshot: no total
      .mockResolvedValueOnce({ ok: true, actor_path: '/Game/Map.Actor_0' }) // generate
      .mockResolvedValueOnce({ ok: true, total: 20, ism: [{ mesh: '/Game/SM', count: 20 }] }); // inspect
    const r = await pcgCookAndWaitHandler({ actor: 'Actor_0', timeout_s: 5 });
    const payload = JSON.parse(r.content[0].text);
    expect(payload.freshness.before).toBeNull();
    expect(payload.freshness.changed).toBeNull();
  });
});
