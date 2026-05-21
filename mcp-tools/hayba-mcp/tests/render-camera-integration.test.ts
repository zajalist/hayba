import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setDefaultSender, type Sender } from '../src/tools/tool-executor.js';
import { handleRenderCamera } from '../src/tools/render-camera.js';

describe('render-camera integration', () => {
  let sender: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sender = vi.fn();
    setDefaultSender(sender as unknown as Sender);
  });

  it('unwraps a successful render', async () => {
    sender.mockResolvedValueOnce({
      ok: true,
      data: { ok: true, path: '/tmp/x.png', width: 1920, height: 1080, fileBytes: 12345, renderDurationMs: 50, waitMs: 100 },
    });
    const res = await handleRenderCamera({ camera: { kind: 'transform', location: [0, 0, 0], rotation: [0, 0, 0] } } as never);
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.path).toBe('/tmp/x.png');
  });

  it('preserves file_not_written error', async () => {
    sender.mockResolvedValueOnce({
      ok: true,
      data: { ok: false, error: { kind: 'file_not_written', attempted: '/tmp/x.png', engineHint: 'render target null' } },
    });
    const res = await handleRenderCamera({ camera: { kind: 'actor', actor: '/Game/X' } } as never);
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(false);
    expect(body.error.kind).toBe('file_not_written');
  });

  it('preserves file_invalid error', async () => {
    sender.mockResolvedValueOnce({
      ok: true,
      data: { ok: false, error: { kind: 'file_invalid', attempted: '/tmp/x.png', sizeBytes: 17000, firstBytesHex: '0000', expectedFormat: 'png' } },
    });
    const res = await handleRenderCamera({ camera: { kind: 'actor', actor: '/Game/X' } } as never);
    const body = JSON.parse(res.content[0].text);
    expect(body.error.kind).toBe('file_invalid');
    expect(body.error.sizeBytes).toBe(17000);
  });

  it('preserves wait_timeout error', async () => {
    sender.mockResolvedValueOnce({
      ok: true,
      data: { ok: false, error: { kind: 'wait_timeout', timedOut: ['shaders'] } },
    });
    const res = await handleRenderCamera({ camera: { kind: 'actor', actor: '/Game/X' }, wait_timeout_s: 5 } as never);
    const body = JSON.parse(res.content[0].text);
    expect(body.error.kind).toBe('wait_timeout');
    expect(body.error.timedOut).toEqual(['shaders']);
  });

  it('preserves actor_not_found error', async () => {
    sender.mockResolvedValueOnce({
      ok: true,
      data: { ok: false, error: { kind: 'actor_not_found', attempted: '/Game/Missing' } },
    });
    const res = await handleRenderCamera({ camera: { kind: 'actor', actor: '/Game/Missing' } } as never);
    const body = JSON.parse(res.content[0].text);
    expect(body.error.kind).toBe('actor_not_found');
  });
});
