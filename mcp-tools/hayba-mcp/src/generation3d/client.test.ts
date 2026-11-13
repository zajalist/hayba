import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeneration3DClient } from './client.js';

const key = 'secret-do-not-echo';
const id = '018a210d-8ba4-705c-b111-1f1776f7f578';
const ok = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function setup(data: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => ok(data));
  return { fetch, client: createGeneration3DClient({ fetch }) };
}
afterEach(() => vi.useRealTimers());

describe('documented 3D provider adapters', () => {
  it('creates only a Meshy preview; refine requires a separate explicit request', async () => {
    const { client, fetch } = setup({ result: id });
    expect(await client.create({ provider: 'meshy', api_key: key, prompt: 'wooden chair' })).toEqual({ provider: 'meshy', task_id: id, kind: 'model', status: 'queued', progress: 0, phase: 'preview' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('https://api.meshy.ai/openapi/v2/text-to-3d');
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}` } });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ mode: 'preview', prompt: 'wooden chair', ai_model: 'latest', target_formats: ['glb'] });
    await client.create({ provider: 'meshy', api_key: key, preview_task_id: id, prompt: 'oak grain' });
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({ mode: 'refine', preview_task_id: id, texture_prompt: 'oak grain' });
  });
  it('maps Meshy task output and preserves refine phase', async () => {
    const { client } = setup({ id, status: 'SUCCEEDED', progress: 100, model_urls: { glb: 'https://assets.meshy.ai/model.glb' }, thumbnail_url: 'https://assets.meshy.ai/preview.png' });
    expect(await client.status({ provider: 'meshy', api_key: key, task_id: id, phase: 'refine' })).toMatchObject({ status: 'succeeded', phase: 'refine', model_url: 'https://assets.meshy.ai/model.glb', thumbnail_url: 'https://assets.meshy.ai/preview.png' });
  });
  it('sends Tripo v3 model and image input using Bearer authorization', async () => {
    const { client, fetch } = setup({ code: 0, data: { task_id: id } });
    await client.create({ provider: 'tripo', api_key: key, prompt: 'chair' });
    expect(fetch.mock.calls[0][0]).toBe('https://openapi.tripo3d.com/v3/generation/text-to-model');
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ prompt: 'chair', model: 'v3.1-20260211' });
    await client.create({ provider: 'tripo', api_key: key, image_url: 'https://images.example.com/chair.jpg' });
    expect(fetch.mock.calls[1][0]).toBe('https://openapi.tripo3d.com/v3/generation/image-to-model');
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({ input: 'https://images.example.com/chair.jpg', model: 'v3.1-20260211' });
    expect(fetch.mock.calls[1][1]!.headers).toMatchObject({ Authorization: `Bearer ${key}` });
  });
  it('maps Tripo model and thumbnail results', async () => {
    const { client, fetch } = setup({ code: 0, data: { task_id: id, status: 'success', progress: 100, output: { model_url: 'https://cdn.tripo3d.ai/model.glb', rendered_image_url: 'https://cdn.tripo3d.ai/image.png' } } });
    expect(await client.status({ provider: 'tripo', api_key: key, task_id: id })).toMatchObject({ status: 'succeeded', progress: 100, model_url: 'https://cdn.tripo3d.ai/model.glb', thumbnail_url: 'https://cdn.tripo3d.ai/image.png' });
    expect(fetch.mock.calls[0][0]).toBe(`https://openapi.tripo3d.com/v3/tasks/${id}`);
  });
  it('uses documented Aholo prefix, raw key, numeric task ID and image/text payloads', async () => {
    const { client, fetch } = setup({ c: '0', d: 1256173 });
    expect(await client.create({ provider: 'aholo', api_key: key, prompt: 'chair', style: 'cartoon' })).toMatchObject({ task_id: '1256173', progress: null });
    expect(fetch.mock.calls[0][0]).toBe('https://api.aholo3d.cn/lux3d/v1/generate/text-to-3d/task/create');
    expect(fetch.mock.calls[0][1]!.headers).toMatchObject({ Authorization: key });
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ prompt: 'chair', version: 'G1-Turbo', style: 'cartoon', outputFormat: ['glb'] });
    await client.create({ provider: 'aholo', api_key: key, image_url: 'https://images.example.com/chair.png' });
    expect(fetch.mock.calls[1][0]).toBe('https://api.aholo3d.cn/lux3d/v1/generate/img-to-3d/task/create');
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({ img: 'https://images.example.com/chair.png', version: 'G1-Turbo', outputFormat: ['glb'] });
    await client.create({ provider: 'aholo', api_key: key, prompt: 'wooden chair', image_url: 'https://images.example.com/chair.png', model: 'G1' });
    expect(fetch.mock.calls[2][0]).toBe('https://api.aholo3d.cn/lux3d/v1/generate/text-to-3d/task/create');
    expect(JSON.parse(fetch.mock.calls[2][1]!.body as string)).toEqual({ prompt: 'wooden chair', img: 'https://images.example.com/chair.png', version: 'G1', outputFormat: ['glb'] });
  });
  it('selects GLB from Aholo ordered outputs and never invents numeric progress', async () => {
    const { client, fetch } = setup({ c: '0', d: { taskId: 1256173, status: 3, outputs: [{ content: 'https://cdn.example.com/result.zip' }, { content: 'https://cdn.example.com/result.glb' }] } });
    expect(await client.status({ provider: 'aholo', api_key: key, task_id: '1256173' })).toMatchObject({ status: 'succeeded', progress: 100, model_url: 'https://cdn.example.com/result.glb' });
    expect(fetch.mock.calls[0][0]).toBe('https://api.aholo3d.cn/lux3d/v1/generate/task/get?taskid=1256173');
    fetch.mockResolvedValueOnce(ok({ c: '0', d: { taskId: 1256173, status: 1 } }));
    expect(await client.status({ provider: 'aholo', api_key: key, task_id: '1256173' })).toMatchObject({ status: 'running', progress: null });
  });
  it.each([
    ['meshy', { id, status: 'FAILED', task_error: { message: key } }, id, 'failed'],
    ['meshy', { id, status: 'CANCELED' }, id, 'cancelled'],
    ['tripo', { code: 0, data: { task_id: id, status: 'banned', error_message: key } }, id, 'failed'],
    ['tripo', { code: 0, data: { task_id: id, status: 'expired' } }, id, 'failed'],
    ['aholo', { c: '0', d: { taskId: 12, status: 4, outputs: [{ content: key }] } }, '12', 'failed'],
    ['aholo', { c: '0', d: { taskId: 12, status: 6 } }, '12', 'cancelled'],
  ])('maps terminal %s state without exposing errors', async (provider, response, task_id, status) => {
    const { client } = setup(response);
    const result = await client.status({ provider, api_key: key, task_id });
    expect(result.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it.each([
    ['meshy', [], 'https://api.meshy.ai/openapi/v2/text-to-3d?page_size=1'],
    ['tripo', { code: 0, data: { balance: 10, frozen: 0 } }, 'https://openapi.tripo3d.com/v3/account/balance'],
    ['aholo', { c: '0', d: { items: [] } }, 'https://api.aholo3d.cn/lux3d/v1/generate/task/list?page=1&pagesize=1'],
  ])('verifies %s with a read-only endpoint', async (provider, response, url) => {
    const { client, fetch } = setup(response);
    expect(await client.connection({ provider, api_key: key })).toMatchObject({ provider, status: 'verified', verified: true });
    expect(fetch.mock.calls[0][0]).toBe(url);
    expect(fetch.mock.calls[0][1]!.method).toBe('GET');
  });
  it.each(['http://cdn.example.com/x', 'https://127.1/x', 'https://169.254.169.254/x', 'https://192.168.1.1/x', 'https://[::ffff:127.0.0.1]/x', 'https://localhost/x', 'https://test.local/x', 'https://user:pass@example.com/x', 'file:///a', 'data:image/png;base64,abc'])('rejects unsafe image URL %s before transport', async image_url => {
    const { client, fetch } = setup({});
    await expect(client.create({ provider: 'aholo', api_key: key, image_url })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { provider: 'meshy', prompt: 'x', base_url: 'https://evil.example.com' },
    { provider: 'aholo', prompt: 'x', model: '../bad' },
    { provider: 'tripo', prompt: 'x', style: 'cartoon' },
    { provider: 'meshy', prompt: 'x', image_url: 'https://example.com/x.png' },
    { provider: 'tripo', prompt: 'x', image_url: 'https://example.com/x.png' },
    { provider: 'meshy', prompt: 'x'.repeat(801) },
  ])('rejects unsupported or malicious fields', async input => {
    const { client, fetch } = setup({});
    await expect(client.create({ ...input, api_key: key })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['../secret', 'x?api_key=secret', 'https://evil.com', '', 'x'.repeat(129)])('rejects malformed ID %s', async task_id => {
    const { client, fetch } = setup({});
    await expect(client.status({ provider: 'tripo', api_key: key, task_id })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never puts credentials supplied as task IDs in request URLs', async () => {
    const { client, fetch } = setup({});
    await expect(client.status({ provider: 'tripo', api_key: key, task_id: key })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(client.create({ provider: 'meshy', api_key: key, preview_task_id: key })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('removes hostile output URLs and credential echoes', async () => {
    const { client } = setup({ code: 0, data: { task_id: id, status: 'success', output: { model_url: `https://cdn.example.com/${key}.glb`, rendered_image_url: 'https://127.0.0.1/secret' } } });
    const result = await client.status({ provider: 'tripo', api_key: key, task_id: id });
    expect(result.model_url).toBeUndefined();
    expect(result.thumbnail_url).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it('sanitizes upstream HTTP, business, parse and transport errors', async () => {
    const { client, fetch } = setup({});
    for (const response of [new Response(key, { status: 401 }), ok({ code: 500, message: key }), new Response(key), ok({ code: 0, data: { task_id: id, status: 'unknown' } })]) {
      fetch.mockResolvedValueOnce(response);
      try { await client.status({ provider: 'tripo', api_key: key, task_id: id }); throw new Error('must fail'); }
      catch (error) { expect(String(error)).not.toContain(key); expect(error).toHaveProperty('code'); }
    }
    fetch.mockRejectedValueOnce(new Error(key));
    await expect(client.status({ provider: 'tripo', api_key: key, task_id: id })).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
  it('bounds response bodies including chunked responses', async () => {
    const { client, fetch } = setup({});
    fetch.mockResolvedValueOnce(new Response('x'.repeat(262145)));
    await expect(client.connection({ provider: 'meshy', api_key: key })).rejects.toMatchObject({ code: 'UPSTREAM_INVALID_RESPONSE' });
  });
  it('aborts timed-out provider requests', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error(key)))));
    const pending = createGeneration3DClient({ fetch, timeoutMs: 20 }).connection({ provider: 'tripo', api_key: key });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT', httpStatus: 504 });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
  });
});
