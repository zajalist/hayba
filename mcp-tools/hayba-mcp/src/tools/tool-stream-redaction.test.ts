import { describe, expect, it } from 'vitest';
import { wrapToolHandlerForStream } from './tool-stream-mirror.js';

describe('MCP + Tool Stream final redaction boundary', () => {
  it('returns one redacted MCP result without mutating the handler-owned value', async () => {
    const owned = {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'Authorization: Bearer SENTINEL_RESULT_123456',
          mandatory_recovery: 'Rotate the credential, reconnect, and retry.',
        }),
      }],
      isError: true,
    };
    const handler: (params: unknown) => Promise<typeof owned> = async (_params: unknown) => owned;
    const wrapped = wrapToolHandlerForStream('secret_probe', handler);
    const result = await wrapped({ apiKey: 'SENTINEL_PARAM' }) as typeof owned & { _meta?: unknown };

    expect(JSON.stringify(result)).not.toContain('SENTINEL');
    expect(JSON.stringify(result)).toContain('mandatory_recovery');
    expect(result._meta).toBeDefined();
    expect(owned.content[0]!.text).toContain('SENTINEL_RESULT');
    expect(wrapToolHandlerForStream('secret_probe', wrapped)).toBe(wrapped);
  });

  it('redacts thrown errors while preserving useful recovery prose', async () => {
    const handler: (params: unknown) => Promise<never> = async (_params: unknown) => {
      throw new Error('apiKey=SENTINEL_THROW; reconnect after rotating it');
    };
    const wrapped = wrapToolHandlerForStream('throw_probe', handler);
    const error = await wrapped({}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('SENTINEL_THROW');
    expect((error as Error).message).toContain('reconnect after rotating it');
  });
});
