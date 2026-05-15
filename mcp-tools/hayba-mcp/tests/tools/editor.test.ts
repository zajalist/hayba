import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../../src/tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => ({ send: mockSend })),
}));

beforeEach(() => {
  mockSend.mockReset();
  delete process.env.HAYBA_SIDECAR_URL;
});

import { editorCaptureViewportHandler } from '../../src/tools/editor/editor-capture-viewport.js';
import { editorStartPieHandler } from '../../src/tools/editor/editor-start-pie.js';

const fakeSession = {} as any;

describe('editor_capture_viewport', () => {
  it('rejects bad width type', async () => {
    const r = await editorCaptureViewportHandler({ width: 'big' }, fakeSession);
    expect(r.isError).toBe(true);
  });
  it('forwards with defaults', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: { png_base64: 'abc' } });
    const r = await editorCaptureViewportHandler({}, fakeSession);
    expect(mockSend).toHaveBeenCalledWith('editor_capture_viewport', expect.objectContaining({ width: 1280, height: 720 }));
    expect(r.isError).toBeFalsy();
  });
  it('appends sidecar note when env var set', async () => {
    process.env.HAYBA_SIDECAR_URL = 'http://localhost:9000';
    mockSend.mockResolvedValue({ id: '1', ok: true, data: {} });
    const r = await editorCaptureViewportHandler({}, fakeSession);
    expect(r.content[0].text).toContain('Sidecar embedding integration pending');
  });
  it('surfaces TCP error', async () => {
    mockSend.mockResolvedValue({ id: '2', ok: false, error: 'gpu' });
    const r = await editorCaptureViewportHandler({}, fakeSession);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('gpu');
  });
});

describe('editor_start_pie', () => {
  it('forwards with defaults', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: {} });
    await editorStartPieHandler({}, fakeSession);
    expect(mockSend).toHaveBeenCalledWith('editor_start_pie', expect.objectContaining({ single_step: false }));
  });
  it('rejects bad single_step type', async () => {
    const r = await editorStartPieHandler({ single_step: 'yes' }, fakeSession);
    expect(r.isError).toBe(true);
  });
  it('surfaces TCP error', async () => {
    mockSend.mockResolvedValue({ id: '2', ok: false, error: 'already-pie' });
    const r = await editorStartPieHandler({}, fakeSession);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('already-pie');
  });
});
