import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../../src/tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => ({ send: mockSend })),
}));

beforeEach(() => { mockSend.mockReset(); });

import { sceneExportHandler } from '../../src/tools/scene/scene-export.js';
import { sceneValidatePhysicsHandler } from '../../src/tools/scene/scene-validate-physics.js';

const fakeSession = {} as any;

describe('scene_export', () => {
  it('rejects invalid mode', async () => {
    const r = await sceneExportHandler({ mode: 'bogus' }, fakeSession);
    expect(r.isError).toBe(true);
  });
  it('forwards with defaults', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: { items: [] } });
    const r = await sceneExportHandler({}, fakeSession);
    expect(mockSend).toHaveBeenCalledWith('scene_export', expect.objectContaining({ mode: 'flat', max_items: 200 }));
    expect(r.isError).toBeFalsy();
  });
  it('surfaces TCP error', async () => {
    mockSend.mockResolvedValue({ id: '2', ok: false, error: 'boom' });
    const r = await sceneExportHandler({}, fakeSession);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('boom');
  });
});

describe('scene_validate_physics', () => {
  it('happy path', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: { issues: [] } });
    const r = await sceneValidatePhysicsHandler({}, fakeSession);
    expect(mockSend).toHaveBeenCalledWith('scene_validate_physics', expect.objectContaining({ deep_check: false }));
    expect(r.isError).toBeFalsy();
  });
  it('appends sidecar note on deep_check_required', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: { deep_check_required: true } });
    const r = await sceneValidatePhysicsHandler({ deep_check: true }, fakeSession);
    expect(r.content[0].text).toContain('Deep check requested');
    expect(r.content[0].text).toContain('SidecarURL/validate');
  });
  it('surfaces TCP error', async () => {
    mockSend.mockResolvedValue({ id: '2', ok: false, error: 'fail' });
    const r = await sceneValidatePhysicsHandler({}, fakeSession);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('fail');
  });
});
