import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivationRequest } from './derivation.js';
import { proposeDerivation } from './derivation.js';
import type { Phonology } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import type { NameGeneratorProfile } from './name-generator.js';

// Mock holder so tests can swap the create() impl per-test.
const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    apiKey: string;
    messages = { create: createMock };
    constructor(cfg: { apiKey: string }) {
      this.apiKey = cfg.apiKey;
    }
  }
  return { default: Anthropic, Anthropic };
});

// Import AFTER vi.mock so the dynamic import inside the adapter sees our mock.
const { createAnthropicLLM, buildSystemPrompt } = await import('./llm-anthropic.js');

const ph: Phonology = {
  languageId: 'demo',
  phonemes: [
    { id: 'p', ipa: 'p', features: { manner: 'plosive' } },
    { id: 't', ipa: 't', features: { manner: 'plosive' } },
    { id: 'k', ipa: 'k', features: { manner: 'plosive' } },
    { id: 'a', ipa: 'a', features: { height: 'open' } },
    { id: 'o', ipa: 'o', features: { height: 'close-mid' } },
  ],
};
const pt: PhonotacticSpec = {
  phonologyId: 'demo', vowels: ['a', 'o'],
  syllable: { templates: ['CV'] },
};
const profile: NameGeneratorProfile = {
  syllableTemplate: 'CV', vowels: ['a', 'o'], onsetPool: ['p', 't', 'k'],
};
const req: DerivationRequest = {
  phonology: ph, phonotactics: pt, fallbackProfile: profile,
  gloss: 'mountain', seed: 1,
};

function toolUseResponse(input: Record<string, unknown>) {
  return {
    content: [
      { type: 'tool_use', name: 'emit_derivation', input },
    ],
  };
}

describe('createAnthropicLLM', () => {
  beforeEach(() => {
    createMock.mockReset();
  });
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('throws immediately when no API key is configured', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => createAnthropicLLM()).toThrow(/API key missing/);
  });

  it('parses a tool_use response into a DerivationCandidate', async () => {
    createMock.mockResolvedValue(toolUseResponse({ lemma: 'kapo', etymology: 'compound' }));
    const llm = createAnthropicLLM({ apiKey: 'test-key' });
    const cand = await llm(1, null, req);
    expect(cand.lemma).toBe('kapo');
    expect(cand.etymology).toBe('compound');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('marks the system block with cache_control: ephemeral', async () => {
    createMock.mockResolvedValue(toolUseResponse({ lemma: 'pa' }));
    const llm = createAnthropicLLM({ apiKey: 'test-key' });
    await llm(1, null, req);
    const args = createMock.mock.calls[0][0] as {
      system: Array<{ type: string; text: string; cache_control?: { type: string } }>;
      tool_choice: { type: string; name: string };
      model: string;
    };
    expect(Array.isArray(args.system)).toBe(true);
    expect(args.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(args.system[0].text).toContain('demo');
    expect(args.tool_choice).toEqual({ type: 'tool', name: 'emit_derivation' });
    expect(args.model).toBe('claude-sonnet-4-6');
  });

  it('throws when tool_use block is missing', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'hello' }] });
    const llm = createAnthropicLLM({ apiKey: 'test-key' });
    await expect(llm(1, null, req)).rejects.toThrow(/tool_use/);
  });

  it('integrates with proposeDerivation: invalid lemma triggers retry → fallback', async () => {
    // The model emits an out-of-inventory lemma every time. proposeDerivation
    // catches the failed phonotactic check and falls through to the
    // deterministic generator.
    createMock.mockResolvedValue(toolUseResponse({ lemma: 'ZZ' }));
    const llm = createAnthropicLLM({ apiKey: 'test-key' });
    const r = await proposeDerivation({ ...req, maxRetries: 2 }, llm);
    expect(r.source).toBe('fallback');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('integrates with proposeDerivation: valid lemma accepted', async () => {
    createMock.mockResolvedValue(toolUseResponse({ lemma: 'kapo' }));
    const llm = createAnthropicLLM({ apiKey: 'test-key' });
    const r = await proposeDerivation(req, llm);
    expect(r.source).toBe('llm');
    expect(r.lexeme.lemma).toBe('kapo');
  });

  it('falls back to process.env.ANTHROPIC_API_KEY', async () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    createMock.mockResolvedValue(toolUseResponse({ lemma: 'pa' }));
    const llm = createAnthropicLLM();
    await llm(1, null, req);
    expect(createMock).toHaveBeenCalled();
  });
});

describe('buildSystemPrompt', () => {
  it('includes inventory, templates, and lexicon sample', () => {
    const sys = buildSystemPrompt(req, [{ concept: 'water', lemma: 'apa' }]);
    expect(sys).toContain('demo');
    expect(sys).toContain('CV');
    expect(sys).toContain('water = apa');
  });
});
