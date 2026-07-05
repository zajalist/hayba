import { describe, it, expect } from 'vitest';
import { listProviders, getProvider, registerCustomProvider } from '../../src/agents/providers.js';

const EXPECTED_IDS = ['mock', 'anthropic', 'openai', 'groq', 'openrouter', 'ollama', 'lmstudio', 'custom'];

describe('providers catalog', () => {
  it('exposes all 8 built-in providers', () => {
    const ids = listProviders().map((p) => p.id);
    for (const id of EXPECTED_IDS) {
      expect(ids).toContain(id);
    }
    expect(ids.length).toBeGreaterThanOrEqual(EXPECTED_IDS.length);
  });

  it('classifies anthropic as the anthropic protocol', () => {
    expect(getProvider('anthropic')?.protocol).toBe('anthropic');
  });

  it('classifies the openai-compat family as the openai protocol', () => {
    for (const id of ['openai', 'groq', 'openrouter', 'ollama', 'lmstudio', 'custom']) {
      expect(getProvider(id)?.protocol).toBe('openai');
    }
  });

  it('flags mock/ollama/lmstudio as keyless', () => {
    for (const id of ['mock', 'ollama', 'lmstudio']) {
      expect(getProvider(id)?.needsKey).toBe(false);
    }
  });

  it('flags anthropic/openai/groq/openrouter as needing a key', () => {
    for (const id of ['anthropic', 'openai', 'groq', 'openrouter']) {
      expect(getProvider(id)?.needsKey).toBe(true);
    }
  });

  it('anthropic defaults to claude-opus-4-8', () => {
    expect(getProvider('anthropic')?.defaultModel).toBe('claude-opus-4-8');
  });

  it('registers a custom provider and it appears in the list afterward', () => {
    const before = listProviders().length;
    const entry = registerCustomProvider('My Local vLLM', 'http://localhost:8080/v1', 'Bearer abc', 'llama-3-8b');

    const after = listProviders();
    expect(after.length).toBe(before + 1);

    const found = getProvider(entry.id);
    expect(found).toBeDefined();
    expect(found?.baseURLDefault).toBe('http://localhost:8080/v1');
    expect(found?.defaultModel).toBe('llama-3-8b');
    expect(found?.needsKey).toBe(true);
    expect(found?.protocol).toBe('openai');
  });

  it('registering with the same label again overwrites rather than duplicating', () => {
    registerCustomProvider('Dup Provider', 'http://a', undefined, 'm1');
    const countAfterFirst = listProviders().length;
    registerCustomProvider('Dup Provider', 'http://b', undefined, 'm2');
    const countAfterSecond = listProviders().length;
    expect(countAfterSecond).toBe(countAfterFirst);
    expect(getProvider('dup-provider')?.baseURLDefault).toBe('http://b');
  });
});
