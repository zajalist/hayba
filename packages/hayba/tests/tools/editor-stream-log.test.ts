import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../../src/tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => ({ send: mockSend })),
}));

import { editorStreamLogHandler } from '../../src/tools/editor/editor-stream-log.js';
const fakeSession = {} as any;

beforeEach(() => mockSend.mockReset());

describe('editor_stream_log tool', () => {
  it('forwards optional params', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: { lines: ['a', 'b'], next_line: 2 } });
    const r = await editorStreamLogHandler({ filter: 'Error', since_line: 100 }, fakeSession);
    expect(mockSend).toHaveBeenCalledWith('editor_stream_log', { filter: 'Error', since_line: 100 });
    expect(r.isError).toBeFalsy();
  });

  it('works with no params', async () => {
    mockSend.mockResolvedValue({ id: '2', ok: true, data: { lines: [], next_line: 0 } });
    const r = await editorStreamLogHandler({}, fakeSession);
    expect(r.isError).toBeFalsy();
  });

  it('rejects negative since_line', async () => {
    const r = await editorStreamLogHandler({ since_line: -1 }, fakeSession);
    expect(r.isError).toBe(true);
  });

  it('surfaces TCP error', async () => {
    mockSend.mockResolvedValue({ id: '3', ok: false, error: 'log file locked' });
    const r = await editorStreamLogHandler({}, fakeSession);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('log file locked');
  });
});
