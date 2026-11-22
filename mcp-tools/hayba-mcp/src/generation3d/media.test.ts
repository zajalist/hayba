import { describe, expect, it, vi } from 'vitest';
import { createGeneration3DClient } from './client.js';

const key = 'private-media-key', id = '764cabcf-b745-4b3e-ae38-1200304cf45b';
const ok = (data: unknown) => new Response(JSON.stringify(data));
function setup(...responses: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const data of responses) fetch.mockImplementationOnce(async () => data instanceof Response ? data : ok(data));
  return { fetch, client: createGeneration3DClient({ fetch }) };
}

describe('video and Gaussian splat provider contracts', () => {
  it('keeps fal configured rather than claiming verification or spending credits', async () => {
    const { client, fetch } = setup();
    expect(await client.connection({ provider: 'fal', api_key: key })).toMatchObject({ provider: 'fal', status: 'configured', verified: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('creates a fixed Wan2.7 text video with explicit predictable defaults', async () => {
    const { client, fetch } = setup({ request_id: id, response_url: 'https://attacker.example/result' });
    expect(await client.create({ provider: 'fal', api_key: key, prompt: 'Fog through a ruined station' })).toEqual({ provider: 'fal', task_id: id, kind: 'video', status: 'queued', progress: null });
    expect(fetch.mock.calls[0][0]).toBe('https://queue.fal.run/fal-ai/wan/v2.7/text-to-video');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Key ${key}` } });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ prompt: 'Fog through a ruined station', duration: 5, resolution: '1080p' });
  });
  it.each([['IN_QUEUE', 'queued'], ['IN_PROGRESS', 'running']])('maps fal %s without invented percentages', async (upstream, status) => {
    const { client, fetch } = setup({ request_id: id, status: upstream });
    expect(await client.status({ provider: 'fal', api_key: key, task_id: id })).toMatchObject({ status, kind: 'video', progress: null });
    expect(fetch.mock.calls[0][0]).toBe(`https://queue.fal.run/fal-ai/wan/requests/${id}/status`);
  });
  it('fetches completed fal results only from the fixed app path', async () => {
    const { client, fetch } = setup({ request_id: id, status: 'COMPLETED', response_url: 'https://attacker.example/steal' }, { video: { url: 'https://v.fal.media/video.mp4' } });
    expect(await client.status({ provider: 'fal', api_key: key, task_id: id })).toEqual({ provider: 'fal', task_id: id, kind: 'video', status: 'succeeded', progress: 100, result_url: 'https://v.fal.media/video.mp4' });
    expect(fetch.mock.calls[1][0]).toBe(`https://queue.fal.run/fal-ai/wan/requests/${id}`);
    expect(fetch.mock.calls.every(call => call[1]?.redirect === 'error')).toBe(true);
  });
  it.each([[422, 'failed'], [499, 'cancelled']])('maps completed fal error response%d without secret reflection', async (code, status) => {
    const { client } = setup({ request_id: id, status: 'COMPLETED' }, new Response(key, { status: code as number }));
    const result = await client.status({ provider: 'fal', api_key: key, task_id: id });
    expect(result.status).toBe(status); expect(JSON.stringify(result)).not.toContain(key);
  });
  it('treats a fal terminal error as failure without fetching untrusted URLs', async () => {
    const { client, fetch } = setup({ request_id: id, status: 'COMPLETED', error: key, error_type: 'validation_error' });
    const result = await client.status({ provider: 'fal', api_key: key, task_id: id });
    expect(result.status).toBe('failed'); expect(JSON.stringify(result)).not.toContain(key); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('verifies World Labs with the read-only credit endpoint', async () => {
    const { client, fetch } = setup({ remaining_credits: 0 });
    expect(await client.connection({ provider: 'worldlabs', api_key: key })).toMatchObject({ verified: true, status: 'verified' });
    expect(fetch.mock.calls[0][0]).toBe('https://api.worldlabs.ai/marble/v1/credits');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { 'WLT-Api-Key': key } });
  });
  it('creates a documented Marble operation from a text prompt', async () => {
    const { client, fetch } = setup({ operation_id: id, done: false });
    expect(await client.create({ provider: 'worldlabs', api_key: key, prompt: 'Ancient forest' })).toEqual({ provider: 'worldlabs', task_id: id, kind: 'splat', status: 'queued', progress: null });
    expect(fetch.mock.calls[0][0]).toBe('https://api.worldlabs.ai/marble/v1/worlds:generate');
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ display_name: 'Ancient forest', model: 'marble-1.1', world_prompt: { type: 'text', text_prompt: 'Ancient forest' } });
  });
  it('maps World Labs running operation and full resolution SPZ result without automatic export', async () => {
    const { client, fetch } = setup({ operation_id: id, done: false, metadata: { progress: { status: 'IN_PROGRESS' } } }, { operation_id: id, done: true, response: { world_id: id, assets: { splats: { spz_urls: { '100k': 'https://cdn.worldlabs.ai/100k.spz', full_res: 'https://cdn.worldlabs.ai/full.spz' } }, thumbnail_url: 'https://cdn.worldlabs.ai/thumb.jpg' } } });
    expect(await client.status({ provider: 'worldlabs', api_key: key, task_id: id })).toMatchObject({ kind: 'splat', status: 'running', progress: null });
    expect(await client.status({ provider: 'worldlabs', api_key: key, task_id: id })).toMatchObject({ kind: 'splat', status: 'succeeded', result_url: 'https://cdn.worldlabs.ai/full.spz', thumbnail_url: 'https://cdn.worldlabs.ai/thumb.jpg' });
    expect(fetch.mock.calls.map(c => c[0])).toEqual([`https://api.worldlabs.ai/marble/v1/operations/${id}`, `https://api.worldlabs.ai/marble/v1/operations/${id}`]);
  });
  it('reports World Labs errors safely and rejects mismatched operations', async () => {
    const { client } = setup({ operation_id: id, done: true, error: { message: key } }, { operation_id: 'wrong', done: true });
    const result = await client.status({ provider: 'worldlabs', api_key: key, task_id: id });
    expect(result.status).toBe('failed'); expect(JSON.stringify(result)).not.toContain(key);
    await expect(client.status({ provider: 'worldlabs', api_key: key, task_id: id })).rejects.toHaveProperty('code', 'UPSTREAM_INVALID_RESPONSE');
  });
  it.each(['fal', 'worldlabs'])('rejects unsupported settings and sensitive IDs for%s before fetching', async provider => {
    const { client, fetch } = setup();
    for (const extra of [{ model: 'https://attacker.example' }, { image_url: 'https://images.example.com/x.png' }, { style: 'cartoon' }, { preview_task_id: id }])
      await expect(client.create({ provider, api_key: key, prompt: 'forest', ...extra })).rejects.toHaveProperty('code', 'INVALID_INPUT');
    await expect(client.status({ provider, api_key: key, task_id: key })).rejects.toHaveProperty('code', 'INVALID_INPUT');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not expose credential-bearing or private media URLs', async () => {
    const { client } = setup({ request_id: id, status: 'COMPLETED' }, { video: { url: `https://v.fal.media/${key}.mp4` } }, { operation_id: id, done: true, response: { assets: { splats: { spz_urls: { full_res: 'https://127.0.0.1/private.spz' } } } } });
    for (const provider of ['fal', 'worldlabs']) {
      const result = await client.status({ provider, api_key: key, task_id: id });
      expect(result.result_url).toBeUndefined(); expect(result.error).toContain('no safe result');expect(JSON.stringify(result)).not.toContain(key);
    }
  });
});
