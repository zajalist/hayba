import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetModelDiscovery, __setModelDiscoveryClock, __setModelDiscoveryFetch, discoverModels } from './model-discovery.js';

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

beforeEach(() => __resetModelDiscovery());
afterEach(() => __resetModelDiscovery());

describe('read-only model discovery', () => {
  it('uses the fixed Anthropic catalog host, paginates, and never returns the key', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer synthetic-key', 'anthropic-version': '2023-06-01' });
      return urls.length === 1
        ? json({ data: [{ id: 'claude-one', display_name: 'Claude One', max_input_tokens: 100000, max_tokens: 8192,
          capabilities: { image_input: { supported: true }, effort: { supported: true, low: { supported: true } } } }], has_more: true, last_id: 'claude-one' })
        : json({ data: [{ id: 'claude-two', display_name: 'Claude Two' }], has_more: false });
    });
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const found = await discoverModels({ provider: 'anthropic', apiKey: 'synthetic-key' });
    expect(found.status).toBe('ok');
    expect(found.models).toMatchObject([
      { id: 'claude-one', context_tokens: 100000, max_output_tokens: 8192, input_modalities: ['text', 'image'], reasoning_efforts: ['low'], tool_use: 'unknown' },
      { id: 'claude-two' },
    ]);
    expect(urls[0]).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models\?/);
    expect(urls[1]).toContain('after_id=claude-one');
    expect(JSON.stringify(found)).not.toContain('synthetic-key');
  });

  it('refuses a hosted preset URL override before sending its credential', async () => {
    const fetchMock = vi.fn();
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const found = await discoverModels({ provider: 'openai', apiKey: 'synthetic-key', baseURL: 'https://attacker.example/v1' });
    expect(found).toMatchObject({ status: 'manual', reason: 'custom_endpoint', models: [] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(found)).not.toContain('synthetic-key');
  });

  it('needs a configured hosted key, with no request or guessed IDs', async () => {
    const fetchMock = vi.fn();
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    expect(await discoverModels({ provider: 'groq' })).toMatchObject({ status: 'no_key', models: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes OpenRouter account-filtered price and conditional tool support', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain('/models/user?');
      return json({ data: [{ id: 'vendor/chat', name: 'Chat', context_length: 128000,
        architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000004' } }], total_count: 1 });
    });
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const found = await discoverModels({ provider: 'openrouter', apiKey: 'synthetic-key' });
    expect(found.models).toMatchObject([{ id: 'vendor/chat', chat_capable: true, tool_use: 'conditional',
      context_tokens: 128000, input_usd_per_million: 1, output_usd_per_million: 4 }]);
  });

  it('treats Groq list entries as availability, not proof of chat or tool support', async () => {
    __setModelDiscoveryFetch(vi.fn(async () => json({ data: [
      { id: 'whisper-large-v3', active: true, context_window: 448 },
      { id: 'chat-model', active: true, context_window: 131072 },
    ] })) as typeof fetch);
    const found = await discoverModels({ provider: 'groq', apiKey: 'synthetic-key' });
    expect(found.models).toMatchObject([
      { id: 'whisper-large-v3', chat_capable: null, tool_use: 'unknown' },
      { id: 'chat-model', chat_capable: null, tool_use: 'unknown' },
    ]);
  });

  it('honors Retry-After without retrying or exposing upstream error text', async () => {
    let clock = 100000;
    __setModelDiscoveryClock(() => clock);
    const fetchMock = vi.fn(async () => new Response('secret-bearing provider error', { status: 429, headers: { 'retry-after': '30' } }));
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const first = await discoverModels({ provider: 'deepseek', apiKey: 'synthetic-key' });
    clock += 1000;
    const second = await discoverModels({ provider: 'deepseek', apiKey: 'synthetic-key', refresh: true });
    expect(first).toMatchObject({ status: 'unavailable', reason: 'rate_limited', retry_after_seconds: 30, models: [] });
    expect(second.cached).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain('secret-bearing');
  });

  it('bounds pagination and reports incomplete catalogs as partial', async () => {
    const fetchMock = vi.fn(async () => json({ data: [{ id: `claude-${fetchMock.mock.calls.length}` }],
      has_more: true, last_id: `claude-${fetchMock.mock.calls.length}` }));
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const found = await discoverModels({ provider: 'anthropic', apiKey: 'synthetic-key' });
    expect(found).toMatchObject({ status: 'partial', partial: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('rejects oversized catalog responses without parsing or echoing them', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-length': '2097153' } }));
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const found = await discoverModels({ provider: 'openai', apiKey: 'synthetic-key' });
    expect(found).toMatchObject({ status: 'unavailable', reason: 'invalid_response', models: [] });
  });

  it('marks expired cached models stale after a network failure', async () => {
    let clock = 100000;
    __setModelDiscoveryClock(() => clock);
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ data: [{ id: 'available-now' }] })).mockRejectedValueOnce(new Error('key=synthetic-key'));
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const first = await discoverModels({ provider: 'openai', apiKey: 'synthetic-key' });
    clock += 16 * 60_000;
    const second = await discoverModels({ provider: 'openai', apiKey: 'synthetic-key' });
    expect(first.status).toBe('ok');
    expect(second).toMatchObject({ status: 'unavailable', stale: true, reason: 'network', models: [{ id: 'available-now' }] });
    expect(JSON.stringify(second)).not.toContain('synthetic-key');
  });

  it('keeps hosted catalog cache entries separate when a credential rotates', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string>)?.Authorization;
      return json({ data: [{ id: authorization === 'Bearer synthetic-key-a' ? 'model-a' : 'model-b' }] });
    });
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const first = await discoverModels({ provider: 'deepseek', apiKey: 'synthetic-key-a' });
    const rotated = await discoverModels({ provider: 'deepseek', apiKey: 'synthetic-key-b' });
    const reused = await discoverModels({ provider: 'deepseek', apiKey: 'synthetic-key-a' });
    expect(first.models).toMatchObject([{ id: 'model-a' }]);
    expect(rotated.models).toMatchObject([{ id: 'model-b' }]);
    expect(reused).toMatchObject({ cached: true, models: [{ id: 'model-a' }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('discovers Ollama only through loopback and reports loaded context separately', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/tags') return json({ models: [{ name: 'local:latest', size: 1000 }] });
      if (path === '/api/show') {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe(JSON.stringify({ model: 'local:latest' }));
        return json({ capabilities: ['completion', 'tools', 'vision'], model_info: { 'test.context_length': 131072 } });
      }
      if (path === '/api/ps') return json({ models: [{ name: 'local:latest', context_length: 8192 }] });
      throw new Error('unexpected request');
    });
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const found = await discoverModels({ provider: 'ollama' });
    expect(found.models).toMatchObject([{ id: 'local:latest', tool_use: 'yes', chat_capable: true,
      context_tokens: 131072, effective_context_tokens: 8192, loaded: true, input_modalities: ['text', 'image'] }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const unsafe = await discoverModels({ provider: 'ollama', baseURL: 'http://192.168.1.2:11434/v1' });
    expect(unsafe).toMatchObject({ status: 'unavailable', reason: 'unsafe_endpoint', models: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reads LM Studio native capabilities without loading or downloading a model', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:1234/api/v1/models');
      expect(init?.method).toBe('GET');
      return json({ models: [
        { type: 'llm', key: 'local/agent', display_name: 'Agent', max_context_length: 65536,
          loaded_instances: [{ config: { context_length: 8192 } }], capabilities: { trained_for_tool_use: true, vision: false } },
        { type: 'embedding', key: 'embed-only' },
      ] });
    });
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    const found = await discoverModels({ provider: 'lmstudio' });
    expect(found.models).toMatchObject([{ id: 'local/agent', tool_use: 'trained', context_tokens: 65536,
      effective_context_tokens: 8192, loaded: true }]);
    expect(found.models).toHaveLength(1);
  });

  it('never probes custom endpoints, even with a legacy explicit-probe flag', async () => {
    const fetchMock = vi.fn();
    __setModelDiscoveryFetch(fetchMock as typeof fetch);
    for (const baseURL of ['https://example.com/v1', 'http://localhost:5000/v1', 'https://169.254.169.254/v1']) {
      const manual = await discoverModels({ provider: 'custom', baseURL, apiKey: 'synthetic-key', probeCustom: true, refresh: true });
      expect(manual).toMatchObject({ status: 'manual', models: [], manual_entry_allowed: true });
      expect(JSON.stringify(manual)).not.toContain('synthetic-key');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
