import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setCachedSidecarHealth } from './visual/sidecar-client.js';

vi.mock('../tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => ({
    send: async () => ({ ok: true, data: { status: 'idle', ueVersion: '5.4' } }),
  })),
}));

describe('checkUeStatus / sidecar fields', () => {
  beforeEach(() => setCachedSidecarHealth(null));
  afterEach(() => setCachedSidecarHealth(null));

  it('includes visual_embeddings_available + active_models from cached health', async () => {
    setCachedSidecarHealth({
      available: true,
      url: 'http://localhost:7821',
      models: { clip: true, owl_vit: true },
      active_models: ['clip', 'owl_vit'],
      checked_at: Date.now(),
    });

    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus();
    expect(status.connected).toBe(true);
    expect(status.visual_embeddings_available).toBe(true);
    expect(status.active_models).toEqual(['clip', 'owl_vit']);
    expect(status.sidecar_url).toBe('http://localhost:7821');
  });

  it('reports visual_embeddings_available=false when sidecar cache is unavailable', async () => {
    setCachedSidecarHealth({
      available: false,
      url: 'http://localhost:7821',
      models: {},
      active_models: [],
      error: 'ECONNREFUSED',
      checked_at: Date.now(),
    });

    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus();
    expect(status.visual_embeddings_available).toBe(false);
    expect(status.active_models).toEqual([]);
    expect(status.sidecar_error).toMatch(/ECONNREFUSED/);
  });
});

describe('checkUeStatus / onConnected hook', () => {
  beforeEach(async () => {
    const mod = await import('./check-ue-status.js');
    mod.__resetConnectedLatch();
    setCachedSidecarHealth({
      available: false, url: '', models: {}, active_models: [], checked_at: Date.now(),
    });
  });
  afterEach(() => setCachedSidecarHealth(null));

  it('fires onConnected exactly once across multiple successful polls', async () => {
    const onConnected = vi.fn(async () => {});
    const { checkUeStatus } = await import('./check-ue-status.js');
    await checkUeStatus({ onConnected });
    await checkUeStatus({ onConnected });
    await checkUeStatus({ onConnected });
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});
