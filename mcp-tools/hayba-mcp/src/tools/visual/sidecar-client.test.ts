import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  pingSidecar,
  embedImage,
  setCachedSidecarHealth,
  getCachedSidecarHealth,
  SidecarUnavailableError,
} from './sidecar-client.js';

describe('sidecar-client / health probe', () => {
  const origFetch = globalThis.fetch;
  const origUrl = process.env.HAYBA_SIDECAR_URL;

  beforeEach(() => {
    setCachedSidecarHealth(null);
    process.env.HAYBA_SIDECAR_URL = 'http://localhost:7821';
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origUrl === undefined) delete process.env.HAYBA_SIDECAR_URL;
    else process.env.HAYBA_SIDECAR_URL = origUrl;
    setCachedSidecarHealth(null);
  });

  it('reports available + active models when /health returns ok with enabled models', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, models: { clip: true, spatial_clip: false, owl_vit: true } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

    const health = await pingSidecar(500);
    expect(health.available).toBe(true);
    expect(health.active_models.sort()).toEqual(['clip', 'owl_vit']);
    expect(health.url).toBe('http://localhost:7821');
    expect(getCachedSidecarHealth()).toBe(health);
  });

  it('reports unavailable when /health throws (sidecar offline)', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const health = await pingSidecar(500);
    expect(health.available).toBe(false);
    expect(health.error).toMatch(/ECONNREFUSED/);
    expect(health.active_models).toEqual([]);
  });

  it('reports unavailable when /health returns non-200', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
    const health = await pingSidecar(500);
    expect(health.available).toBe(false);
    expect(health.error).toMatch(/503/);
  });

  it('reports unavailable when /health says ok but no models are active', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, models: { clip: false, spatial_clip: false, owl_vit: false } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
    const health = await pingSidecar(500);
    expect(health.available).toBe(false);
    expect(health.active_models).toEqual([]);
  });
});

describe('sidecar-client / degraded-mode short-circuit', () => {
  const origFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = origFetch;
    setCachedSidecarHealth(null);
  });

  it('embedImage throws SidecarUnavailableError immediately when cache says offline', async () => {
    setCachedSidecarHealth({
      available: false,
      url: 'http://localhost:7821',
      models: {},
      active_models: [],
      error: 'ECONNREFUSED',
      checked_at: Date.now(),
    });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await expect(embedImage('xxx')).rejects.toBeInstanceOf(SidecarUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('embedImage proceeds when cache says available', async () => {
    setCachedSidecarHealth({
      available: true,
      url: 'http://localhost:7821',
      models: { clip: true },
      active_models: ['clip'],
      checked_at: Date.now(),
    });
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ embedding: [0.1, 0.2, 0.3], dim: 3 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;

    const out = await embedImage('xxx');
    expect(out.dim).toBe(3);
    expect(out.embedding).toEqual([0.1, 0.2, 0.3]);
  });
});
