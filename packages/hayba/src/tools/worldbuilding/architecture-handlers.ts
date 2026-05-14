import { z } from 'zod';
import {
  listStyleGuides as engineListStyleGuides,
  getStyleGuideTool as engineGetStyleGuide,
  getTypologyTool as engineGetTypology,
  validateStyleGuideTool as engineValidateStyleGuide,
} from '@hayba/architecture';

/* ─────────────────────  schemas  ───────────────────── */

export const listStyleGuidesSchema = z.object({});

export const getStyleGuideSchema = z.object({
  id: z.string().describe('StyleGuide id, e.g. "medieval-european-gothic"'),
});

export const getTypologySchema = z.object({
  id: z.string().describe('Typology id, e.g. "peasant_home"'),
});

export const validateStyleGuideSchema = z.object({
  json: z.record(z.string(), z.unknown()).describe('Candidate StyleGuide JSON to validate against the A1 schema'),
});

/* ─────────────────────  handlers  ───────────────────── */

export function listStyleGuides(_params: z.infer<typeof listStyleGuidesSchema>) {
  return engineListStyleGuides();
}

export function getStyleGuide(params: z.infer<typeof getStyleGuideSchema>) {
  return engineGetStyleGuide(params);
}

export function getTypology(params: z.infer<typeof getTypologySchema>) {
  return engineGetTypology(params);
}

export function validateStyleGuide(params: z.infer<typeof validateStyleGuideSchema>) {
  return engineValidateStyleGuide(params);
}

import {
  loadElementCatalog as engineLoadElementCatalog,
  generateBinding as engineGenerateBinding,
  MockProvider, AnthropicProvider, OpenAICompatibleProvider,
  loadRegistry as engineLoadRegistry,
} from '@hayba/architecture';

/* ─────────────────────  AI binding generation  ───────────────────── */

export const generateBindingSchema = z.object({
  styleSheetId: z.string().describe('Target style sheet id (e.g. "medieval-european-gothic")'),
  elementId: z.string().describe('Target element id (e.g. "column")'),
  seed: z.string().optional().describe('Hex bigint seed (e.g. "0x42"). Defaults to 0xa70.'),
  provider: z.enum(['mock', 'anthropic', 'groq', 'openrouter', 'openai', 'ollama', 'lmstudio', 'custom']).optional().default('mock')
    .describe('AI provider. Default mock (no key). free: groq, openrouter, ollama, lmstudio. paid: anthropic, openai. custom: provide baseUrl.'),
  model: z.string().optional().describe('Provider-specific model id.'),
  baseUrl: z.string().optional().describe('Required when provider="custom". The OpenAI-compatible chat-completions root, e.g. http://localhost:8080/v1.'),
});

const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  anthropic:  'HAYBA_ANTHROPIC_API_KEY',
  groq:       'HAYBA_GROQ_API_KEY',
  openrouter: 'HAYBA_OPENROUTER_API_KEY',
  openai:     'HAYBA_OPENAI_API_KEY',
  custom:     'HAYBA_CUSTOM_API_KEY',
};

const BASE_URL_BY_PROVIDER: Record<string, string> = {
  groq:       'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  openai:     'https://api.openai.com/v1',
  ollama:     'http://localhost:11434/v1',
  lmstudio:   'http://localhost:1234/v1',
};

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  anthropic:  'claude-haiku-4-5',
  groq:       'llama-3.1-70b-versatile',
  openrouter: 'meta-llama/llama-3-8b-instruct:free',
  openai:     'gpt-4o-mini',
  ollama:     'qwen2.5-coder:7b-instruct',
  lmstudio:   'local-model',
};

export async function generateBinding(params: z.infer<typeof generateBindingSchema>) {
  const catalog = engineLoadElementCatalog();
  const reg = engineLoadRegistry();
  const element = catalog.elementsById.get(params.elementId);
  if (!element) return { ok: false, error: 'unknown_element', message: `no element ${JSON.stringify(params.elementId)}` };
  const guide = reg.styleGuidesById.get(params.styleSheetId);
  if (!guide) return { ok: false, error: 'unknown_style', message: `no style sheet ${JSON.stringify(params.styleSheetId)}` };

  let provider;
  if (params.provider === 'mock') {
    provider = new MockProvider();
  } else if (params.provider === 'anthropic') {
    const key = process.env.HAYBA_ANTHROPIC_API_KEY;
    if (!key) {
      return { ok: false, error: 'ai_failed', message: 'no API key configured. Set HAYBA_ANTHROPIC_API_KEY.' };
    }
    provider = new AnthropicProvider({ apiKey: key, model: params.model });
  } else {
    // OpenAI-compatible family: groq / openrouter / openai / ollama / lmstudio / custom
    const baseUrl = params.provider === 'custom'
      ? params.baseUrl
      : BASE_URL_BY_PROVIDER[params.provider!];
    if (!baseUrl) {
      return { ok: false, error: 'ai_failed', message: `unknown provider ${JSON.stringify(params.provider)} or missing baseUrl` };
    }
    const envKey = ENV_KEY_BY_PROVIDER[params.provider!];
    const key = envKey ? (process.env[envKey] ?? '') : '';
    if (envKey && !key && params.provider !== 'custom') {
      return {
        ok: false,
        error: 'ai_failed',
        message: `no API key for ${params.provider}. Set ${envKey}, or use provider="mock"/"ollama"/"lmstudio" for keyless options.`,
      };
    }
    const model = params.model ?? DEFAULT_MODEL_BY_PROVIDER[params.provider!] ?? 'unknown';
    provider = new OpenAICompatibleProvider({ baseUrl, apiKey: key, model, name: params.provider! });
  }

  const seed = params.seed ? BigInt(params.seed) : 0xa70n;
  const result = await engineGenerateBinding({
    element, styleSheet: guide.styleSheet, seed, provider,
  });

  if (result.ok) {
    return {
      ok: true,
      // bigint isn't JSON-transportable — serialize as hex string at the MCP boundary.
      draft: { ...result.draft, seed: '0x' + result.draft.seed.toString(16) },
      rationale: result.rationale ?? null,
      validation: { ok: true },
      retriesUsed: 0,
    };
  }
  return {
    ok: false,
    error: 'ai_failed',
    message: result.message,
    stage: result.stage,
    errors: result.errors,
  };
}
