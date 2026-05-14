import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from './provider-openai-compat.js';
import { buildPrompt } from './prompt-builder.js';
import { loadElementCatalog } from '../index.js';

const catalog = loadElementCatalog();
const element = catalog.elementsById.get('column')!;
const styleSheet = {
  id: 'medieval-european-gothic',
  cultureId: 'medieval-european',
  dateRange: [1100, 1400] as [number, number],
  core: {
    primaryMaterial: 'stone' as const,
    roofType: 'gable' as const,
    ornamentation: ['pointed-arch', 'tracery', 'flying-buttress'],
  },
  extras: {},
};

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;

beforeEach(() => { globalThis.fetch = fetchMock as unknown as typeof fetch; });
afterEach(() => { globalThis.fetch = realFetch; fetchMock.mockReset(); });

describe('OpenAICompatibleProvider', () => {
  it('exposes the configured base URL, model, and provider name', () => {
    const p = new OpenAICompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_test', model: 'llama-3.1-70b-versatile', name: 'groq',
    });
    expect(p.name).toBe('groq');
    expect(p.model).toBe('llama-3.1-70b-versatile');
  });

  it('POSTs to <baseUrl>/chat/completions with the configured model + prompts', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"profiles":{},"params":{}}' } }],
        model: 'llama-3.1-70b-versatile',
      }),
    });
    const p = new OpenAICompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_test', model: 'llama-3.1-70b-versatile',
    });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    const r = await p.generate({ element, styleSheet, seed: 1n }, prompt);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer gsk_test');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('llama-3.1-70b-versatile');
    expect(body.messages[0]).toEqual({ role: 'system',  content: prompt.system });
    expect(body.messages[1]).toEqual({ role: 'user',    content: prompt.user });
    expect(r.rawText).toBe('{"profiles":{},"params":{}}');
    expect(r.provider).toBe('openai-compat');
  });

  it('omits Authorization header when apiKey is empty (local Ollama / LM Studio)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{}' } }] }),
    });
    const p = new OpenAICompatibleProvider({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '', model: 'qwen2.5-coder:7b-instruct',
    });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    await p.generate({ element, styleSheet, seed: 1n }, prompt);
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('throws when fetch returns a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    const p = new OpenAICompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'bad', model: 'm',
    });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    await expect(p.generate({ element, styleSheet, seed: 1n }, prompt)).rejects.toThrow(/401/);
  });

  it('throws when the response has no message content', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: {} }] }),
    });
    const p = new OpenAICompatibleProvider({
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_test', model: 'm',
    });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    await expect(p.generate({ element, styleSheet, seed: 1n }, prompt)).rejects.toThrow(/content/);
  });
});
