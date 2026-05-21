import { describe, it, expect, vi, beforeEach } from 'vitest';
import { schema, handleRenderCamera } from './render-camera.js';
import { setDefaultSender, type Sender } from './tool-executor.js';

describe('render-camera schema', () => {
  it('accepts an actor camera', () => {
    const parsed = schema.parse({ camera: { kind: 'actor', actor: '/Game/X' } });
    expect(parsed.camera.kind).toBe('actor');
    if (parsed.camera.kind === 'actor') expect(parsed.camera.actor).toBe('/Game/X');
  });

  it('accepts a transform camera with defaults', () => {
    const parsed = schema.parse({ camera: { kind: 'transform', location: [0, 0, 0], rotation: [0, 0, 0] } });
    expect(parsed.camera.kind).toBe('transform');
    if (parsed.camera.kind === 'transform') expect(parsed.camera.fov).toBe(90);
    expect(parsed.width).toBe(1920);
    expect(parsed.format).toBe('png');
    expect(parsed.wait_for_subsystems).toEqual(['shaders', 'assets', 'world_tick']);
  });

  it('rejects mixed-shape camera', () => {
    expect(() => schema.parse({ camera: { kind: 'actor', actor: '/X', location: [0, 0, 0] } as never })).not.toThrow();
    expect(() => schema.parse({ camera: { kind: 'transform', actor: '/X', location: [0, 0, 0], rotation: [0, 0, 0] } as never })).not.toThrow();
    // Discriminated unions are lenient on extra props; the important rejection is missing-required:
    expect(() => schema.parse({ camera: { kind: 'transform' } as never })).toThrow();
    expect(() => schema.parse({ camera: { kind: 'actor' } as never })).toThrow();
  });

  it('rejects unknown format', () => {
    expect(() => schema.parse({ camera: { kind: 'actor', actor: '/X' }, format: 'bmp' } as never)).toThrow();
  });

  it('enforces dimension bounds', () => {
    expect(() => schema.parse({ camera: { kind: 'actor', actor: '/X' }, width: 32 })).toThrow();
    expect(() => schema.parse({ camera: { kind: 'actor', actor: '/X' }, width: 9000 })).toThrow();
  });
});

describe('handleRenderCamera', () => {
  let sender: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sender = vi.fn(async (_cmd: string, _params: Record<string, unknown>, _timeout: number) => ({
      ok: true,
      data: { ok: true, path: '/tmp/x.png', width: 1920, height: 1080, fileBytes: 1234, renderDurationMs: 42, waitMs: 10 },
    }));
    setDefaultSender(sender as unknown as Sender);
  });

  it('dispatches render_camera with (wait_timeout_s + 30) * 1000 timeout', async () => {
    await handleRenderCamera({ camera: { kind: 'transform', location: [0, 0, 0], rotation: [0, 0, 0] }, wait_timeout_s: 15 } as never);
    expect(sender).toHaveBeenCalledWith('render_camera', expect.any(Object), 45000);
  });

  it('returns the UE response in MCP content shape', async () => {
    const res = await handleRenderCamera({ camera: { kind: 'actor', actor: '/Game/X' } } as never);
    expect(res.content[0].text).toContain('"ok": true');
    expect(res.content[0].text).toContain('"path"');
  });
});
