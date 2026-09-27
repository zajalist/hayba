/**
 * python_run must never be auto-retried after a transport failure.
 *
 * A transport timeout does not mean the script did not run: the editor's game
 * thread may still be executing it, or it finished and the reply was lost.
 * Before python_run was in NON_IDEMPOTENT, executeCommand re-sent it, so one
 * World Partition unload script could run twice back to back — the sequence
 * behind the "UTransBuffer::Reset non-zero active count" crash.
 */

import { describe, expect, it, vi } from 'vitest';
import { NON_IDEMPOTENT, executeCommand, type Sender } from './tool-executor.js';

vi.mock('./heavy-op-probe.js', () => ({ probeEditorProcess: async () => null }));

describe('python_run retry policy', () => {
  it('is declared non-idempotent', () => {
    expect(NON_IDEMPOTENT.has('python_run')).toBe(true);
  });

  it('sends exactly once when the transport times out', async () => {
    let calls = 0;
    const sender: Sender = async () => {
      calls++;
      throw new Error('Timeout waiting for response to python_run (id: req_1)');
    };
    await expect(executeCommand('python_run', { script: 'print(1)' }, { sender })).rejects.toMatchObject({
      name: 'UeToolError',
      code: 'transport',
    });
    expect(calls).toBe(1);
  });

  it('still returns the reply when the first send succeeds', async () => {
    const sender: Sender = async () => ({ id: 'r', ok: true, data: { stdout: 'ok' } });
    await expect(executeCommand('python_run', { script: 'print(1)' }, { sender })).resolves.toEqual({
      stdout: 'ok',
    });
  });
});
