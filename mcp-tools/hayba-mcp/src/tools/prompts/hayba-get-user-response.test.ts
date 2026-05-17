import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sendMock = vi.fn();

vi.mock('../../tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => ({ send: sendMock })),
}));

import { haybaGetUserResponseHandler } from './hayba-get-user-response.js';

describe('hayba_get_user_response', () => {
  beforeEach(() => sendMock.mockReset());
  afterEach(() => sendMock.mockReset());

  it('forwards prompt_id and wait_ms to UE, returns UE payload verbatim on success', async () => {
    sendMock.mockResolvedValueOnce({ ok: true, data: { prompt_id: 'p1', status: 'answered', value: 'hello' } });
    const r = await haybaGetUserResponseHandler({ prompt_id: 'p1', wait_ms: 1000 }, {});
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toEqual({ prompt_id: 'p1', status: 'answered', value: 'hello' });
    expect(sendMock).toHaveBeenCalledWith('hayba_get_user_response', { prompt_id: 'p1', wait_ms: 1000 }, 5000);
  });

  it('uses TCP timeout > wait_ms so UE-side blocking finishes inside the request window', async () => {
    sendMock.mockResolvedValueOnce({ ok: true, data: { prompt_id: 'p1', status: 'pending' } });
    await haybaGetUserResponseHandler({ prompt_id: 'p1', wait_ms: 30_000 }, {});
    expect(sendMock).toHaveBeenCalledWith(
      'hayba_get_user_response',
      { prompt_id: 'p1', wait_ms: 30_000 },
      32_000,
    );
  });

  it('defaults wait_ms to 0 (non-blocking poll)', async () => {
    sendMock.mockResolvedValueOnce({ ok: true, data: { prompt_id: 'p1', status: 'pending' } });
    await haybaGetUserResponseHandler({ prompt_id: 'p1' }, {});
    expect(sendMock).toHaveBeenCalledWith('hayba_get_user_response', { prompt_id: 'p1', wait_ms: 0 }, 5000);
  });

  it('maps a TCP failure to status=unknown with error', async () => {
    sendMock.mockResolvedValueOnce({ ok: false, error: 'queue empty' });
    const r = await haybaGetUserResponseHandler({ prompt_id: 'p1' }, {});
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body).toEqual({ prompt_id: 'p1', status: 'unknown', error: 'queue empty' });
  });

  it('rejects missing prompt_id at validation time', async () => {
    const r = await haybaGetUserResponseHandler({}, {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Validation error/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
