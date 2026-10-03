import { describe, expect, it } from 'vitest';
import { createChatDispatcher } from './tool-dispatch.js';
import { executeCommand, withExactReview } from '../tools/tool-executor.js';
import { buildEnvelope } from '../tcp-client.js';

describe('Chat native exact review envelope', () => {
  it('carries the policy through an async captured handler as top-level metadata', async () => {
    const envelopes: ReturnType<typeof buildEnvelope>[] = [];
    const dispatcher = createChatDispatcher({ captured: new Map([['captured_create', {
      handler: async (rawArgs: unknown) => {
        const args = rawArgs as Record<string, unknown>;
        await Promise.resolve();
        return executeCommand('python_run', { code: args.code }, { sender: async (cmd, params, _timeout, options) => {
          envelopes.push(buildEnvelope(cmd, 'test', params, undefined, undefined,
            options?.requireExactReview === true));
          return { id: 'test', ok: true, data: {} };
        } });
      },
    }]]) });
    await withExactReview(true, () => dispatcher('captured_create', { code: 'print(1)' }));
    expect(envelopes).toEqual([{ cmd: 'python_run', id: 'test', params: { code: 'print(1)' },
      require_exact_review: true }]);
  });

  it('isolates concurrent required and ordinary dispatches', async () => {
    const seen: boolean[] = [];
    const call = (required: boolean) => withExactReview(required, async () => {
      await new Promise((resolve) => setTimeout(resolve, required ? 10 : 1));
      await executeCommand('ping', {}, { sender: async (_cmd, _params, _timeout, options) => {
        seen.push(options?.requireExactReview === true);
        return { id: 'test', ok: true, data: {} };
      } });
    });
    await Promise.all([call(true), call(false)]);
    expect(seen).toEqual([false, true]);
  });
});
