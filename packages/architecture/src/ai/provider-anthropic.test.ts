import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from './provider-anthropic.js';
import { loadElementCatalog } from '../index.js';
import { buildPrompt } from './prompt-builder.js';

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

describe('AnthropicProvider', () => {
  it('uses the configured model id', () => {
    const p = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-haiku-4-5' });
    expect(p.name).toBe('anthropic');
    expect(p.model).toBe('claude-haiku-4-5');
  });

  it('passes system + user prompt to the SDK and returns raw text', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: '{"profiles":{},"params":{}}' }],
      model: 'claude-haiku-4-5',
    });
    const mockClient = { messages: { create: mockCreate } };
    const p = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-haiku-4-5', _client: mockClient as never });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    const r = await p.generate({ element, styleSheet, seed: 1n }, prompt);
    expect(mockCreate).toHaveBeenCalledOnce();
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5');
    expect(call.system).toBe(prompt.system);
    expect(call.messages[0].content).toBe(prompt.user);
    expect(r.rawText).toBe('{"profiles":{},"params":{}}');
    expect(r.provider).toBe('anthropic');
  });

  it('throws when the SDK returns no text content', async () => {
    const mockCreate = vi.fn().mockResolvedValue({ content: [{ type: 'tool_use', input: {} }] });
    const mockClient = { messages: { create: mockCreate } };
    const p = new AnthropicProvider({ apiKey: 'sk-test', model: 'claude-haiku-4-5', _client: mockClient as never });
    const prompt = buildPrompt({ element, styleSheet, seed: 1n });
    await expect(p.generate({ element, styleSheet, seed: 1n }, prompt)).rejects.toThrow(/text/);
  });
});
