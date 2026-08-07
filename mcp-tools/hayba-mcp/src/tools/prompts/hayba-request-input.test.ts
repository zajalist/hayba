import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Installed on the ToolExecutor seam rather than mocking the tcp-client module
// — same (cmd, params, timeoutMs) signature, so the assertions are unchanged.
const sendMock = vi.fn();

import { setDefaultSender } from '../tool-executor.js';
import {
  haybaRequestInputHandler,
  requestInputSchema,
  validateKindPayload,
  type RequestInputParams,
} from './hayba-request-input.js';

describe('hayba_request_input / contract validation', () => {
  it('rejects choose_one without options', () => {
    expect(validateKindPayload({ kind: 'choose_one', title: 't' } as RequestInputParams)).toMatch(/requires non-empty 'options'/);
  });

  it('rejects form without fields', () => {
    expect(validateKindPayload({ kind: 'form', title: 't' } as RequestInputParams)).toMatch(/requires non-empty 'fields'/);
  });

  it('rejects progress without progress payload', () => {
    expect(validateKindPayload({ kind: 'progress', title: 't' } as RequestInputParams)).toMatch(/requires 'progress'/);
  });

  it('accepts approve / text without extra payload', () => {
    expect(validateKindPayload({ kind: 'approve', title: 't' } as RequestInputParams)).toBeNull();
    expect(validateKindPayload({ kind: 'text', title: 't' } as RequestInputParams)).toBeNull();
  });

  it('schema validates a complete form prompt', () => {
    const out = requestInputSchema.safeParse({
      kind: 'form',
      title: 'Pick stack',
      fields: [{ id: 'lang', label: 'Language', kind: 'enum', options: ['ts', 'rust'] }],
    });
    expect(out.success).toBe(true);
  });
});

describe('hayba_request_input / TCP push', () => {
  beforeEach(() => {
    sendMock.mockReset();
    setDefaultSender(sendMock);
  });
  afterEach(() => {
    sendMock.mockReset();
    setDefaultSender(async (cmd) => {
      throw new Error(`sender uninstalled, but "${cmd}" was sent`);
    });
  });

  it('auto-generates a prompt_id when caller omits one and forwards payload to UE', async () => {
    sendMock.mockResolvedValueOnce({ ok: true, data: { queued: true } });
    const result = await haybaRequestInputHandler({
      kind: 'text',
      title: 'name?',
    }, {});
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.prompt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.status).toBe('pushed');
    expect(sendMock).toHaveBeenCalledWith('hayba_request_input', expect.objectContaining({
      prompt_id: body.prompt_id,
      kind: 'text',
      title: 'name?',
    }), 5000);
  });

  it('preserves a caller-supplied prompt_id', async () => {
    sendMock.mockResolvedValueOnce({ ok: true, data: {} });
    const result = await haybaRequestInputHandler({
      kind: 'approve',
      title: 'go?',
      prompt_id: 'fixed-id-1',
    }, {});
    const body = JSON.parse(result.content[0].text);
    expect(body.prompt_id).toBe('fixed-id-1');
  });

  it('returns push_failed with prompt_id when TCP send fails', async () => {
    sendMock.mockResolvedValueOnce({ ok: false, error: 'no UE' });
    const result = await haybaRequestInputHandler({
      kind: 'approve',
      title: 'go?',
    }, {});
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe('push_failed');
    expect(body.error).toBe('no UE');
    expect(body.prompt_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects invalid kind via validation error', async () => {
    const result = await haybaRequestInputHandler({ kind: 'invalid', title: 'x' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Validation error/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects choose_one without options before reaching UE', async () => {
    const result = await haybaRequestInputHandler({ kind: 'choose_one', title: 'pick' }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/requires non-empty 'options'/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
