/**
 * BYOK (bring-your-own-key) LLM provider catalog for the chat copilot.
 *
 * Metadata only — no secrets. API keys are supplied by the caller at request
 * time (env var or user-entered value) and never stored here.
 *
 * Recovered/merged from two removed commits:
 *  - 2849a75 (OPENAI_COMPAT_PRESETS, packages/architecture/src/ai/provider-openai-compat.ts)
 *  - 4d47e58 (ENV_KEY_BY_PROVIDER / BASE_URL_BY_PROVIDER / DEFAULT_MODEL_BY_PROVIDER,
 *             packages/hayba/src/tools/worldbuilding/architecture-handlers.ts)
 */

export type ProviderProtocol = 'anthropic' | 'openai';

export interface ProviderEntry {
  id: string;
  label: string;
  baseURLDefault: string;
  defaultModel: string;
  needsKey: boolean;
  keyHint: string;
  protocol: ProviderProtocol;
}

const PROVIDERS: ProviderEntry[] = [
  {
    id: 'mock',
    label: 'Mock (offline, no key)',
    baseURLDefault: '',
    defaultModel: 'mock',
    needsKey: false,
    keyHint: '(no key)',
    protocol: 'anthropic',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseURLDefault: 'https://api.anthropic.com',
    // Historical default was claude-haiku-4-5; per Task 1 brief the anthropic
    // default is pinned to the flagship model regardless of history.
    defaultModel: 'claude-opus-4-8',
    needsKey: true,
    keyHint: 'sk-ant-...',
    protocol: 'anthropic',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseURLDefault: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    needsKey: true,
    keyHint: 'sk-...',
    protocol: 'openai',
  },
  {
    id: 'groq',
    label: 'Groq (free tier)',
    baseURLDefault: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    needsKey: true,
    keyHint: 'gsk_...',
    protocol: 'openai',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free routes)',
    baseURLDefault: 'https://openrouter.ai/api/v1',
    // OpenRouter free-tier slugs rotate with no stability guarantee — no default; user picks from the model list.
    defaultModel: '',
    needsKey: true,
    keyHint: 'sk-or-...',
    protocol: 'openai',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseURLDefault: 'http://localhost:11434/v1',
    defaultModel: 'qwen2.5-coder:7b-instruct',
    needsKey: false,
    keyHint: '(no key)',
    protocol: 'openai',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    baseURLDefault: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    needsKey: false,
    keyHint: '(no key)',
    protocol: 'openai',
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible',
    baseURLDefault: '',
    defaultModel: '',
    needsKey: false,
    keyHint: 'optional',
    protocol: 'openai',
  },
];

/** Live registry, keyed by provider id. Mutable so `registerCustomProvider` can add entries. */
const registry = new Map<string, ProviderEntry>(PROVIDERS.map((p) => [p.id, p]));

/** Returns the full provider catalog, in registration order. */
export function listProviders(): ProviderEntry[] {
  return Array.from(registry.values());
}

/** Looks up a single provider by id, or undefined if unknown. */
export function getProvider(id: string): ProviderEntry | undefined {
  return registry.get(id);
}

/**
 * Registers (or overwrites) a custom OpenAI-compatible provider entry, e.g. for
 * a self-hosted vLLM / llama.cpp server. Metadata only — the caller still
 * supplies the API key (if any) at request time via authHeader.
 * Duplicate slug = last-write-wins overwrite.
 */
export function registerCustomProvider(
  label: string,
  baseUrl: string,
  authHeader?: string,
  modelDefault?: string,
): ProviderEntry {
  const id = slugify(label);
  const entry: ProviderEntry = {
    id,
    label,
    baseURLDefault: baseUrl,
    defaultModel: modelDefault ?? '',
    needsKey: Boolean(authHeader),
    keyHint: authHeader ?? 'optional',
    protocol: 'openai',
  };
  registry.set(id, entry);
  return entry;
}

function slugify(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `custom-${registry.size}`;
}
