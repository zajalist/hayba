import { hashPrompt } from './prompt-builder.js';
import type { AIProvider, BindingRequest, RawBindingResponse, AIProviderName } from './types.js';

export interface OpenAICompatibleProviderOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Cosmetic name for provenance tracking. Defaults to 'openai-compat'. */
  name?: string;
  /** Max tokens to request. Default 2048. */
  maxTokens?: number;
  /** Temperature. Default 0.7 — high enough for variety, low enough for valid JSON. */
  temperature?: number;
}

/**
 * Speaks the OpenAI chat-completions HTTP API. Compatible with:
 * - Groq            (https://api.groq.com/openai/v1)
 * - OpenRouter      (https://openrouter.ai/api/v1)
 * - OpenAI          (https://api.openai.com/v1)
 * - Ollama (local)  (http://localhost:11434/v1, no key needed)
 * - LM Studio       (http://localhost:1234/v1, no key needed)
 * - vLLM, llama.cpp server, anything else with /chat/completions
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name: AIProviderName;
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(opts: OpenAICompatibleProviderOptions) {
    this.name = (opts.name as AIProviderName) ?? ('openai-compat' as AIProviderName);
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.maxTokens = opts.maxTokens ?? 2048;
    this.temperature = opts.temperature ?? 0.7;
  }

  async generate(_req: BindingRequest, prompt: { system: string; user: string }): Promise<RawBindingResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const url = `${this.baseUrl}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user',   content: prompt.user },
      ],
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    });

    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) {
      const text = await (res.text?.() ?? Promise.resolve(''));
      throw new Error(`OpenAICompatibleProvider: HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
    }
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(`OpenAICompatibleProvider: response had no message content`);
    }

    return {
      rawText: content,
      provider: this.name,
      model: this.model,
      promptHash: hashPrompt(prompt.system, prompt.user),
    };
  }
}

/** Convenience presets for the settings panel. */
export const OPENAI_COMPAT_PRESETS = [
  { id: 'groq',       label: 'Groq (free tier)',         baseUrl: 'https://api.groq.com/openai/v1',  defaultModel: 'llama-3.1-70b-versatile', needsKey: true,  keyHint: 'gsk_...' },
  { id: 'openrouter', label: 'OpenRouter (free routes)', baseUrl: 'https://openrouter.ai/api/v1',    defaultModel: 'meta-llama/llama-3-8b-instruct:free', needsKey: true,  keyHint: 'sk-or-...' },
  { id: 'openai',     label: 'OpenAI',                   baseUrl: 'https://api.openai.com/v1',       defaultModel: 'gpt-4o-mini',             needsKey: true,  keyHint: 'sk-...' },
  { id: 'ollama',     label: 'Ollama (local)',            baseUrl: 'http://localhost:11434/v1',       defaultModel: 'qwen2.5-coder:7b-instruct', needsKey: false, keyHint: '(no key)' },
  { id: 'lmstudio',   label: 'LM Studio (local)',         baseUrl: 'http://localhost:1234/v1',        defaultModel: 'local-model',             needsKey: false, keyHint: '(no key)' },
  { id: 'custom',     label: 'Custom OpenAI-compatible',  baseUrl: '',                                defaultModel: '',                        needsKey: false, keyHint: 'optional' },
] as const;
