import Anthropic from '@anthropic-ai/sdk';
import { hashPrompt } from './prompt-builder.js';
import type { AIProvider, BindingRequest, RawBindingResponse } from './types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  /** Browser-only: required to call the API directly (no proxy). */
  dangerouslyAllowBrowser?: boolean;
  /** Test-only: inject a mock SDK client. */
  _client?: { messages: { create: (args: unknown) => Promise<unknown> } };
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 2048;

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  private readonly client: AnthropicProviderOptions['_client'];

  constructor(opts: AnthropicProviderOptions) {
    this.model = opts.model ?? DEFAULT_MODEL;
    if (opts._client) {
      this.client = opts._client;
    } else {
      const sdk = new Anthropic({
        apiKey: opts.apiKey,
        dangerouslyAllowBrowser: opts.dangerouslyAllowBrowser ?? false,
      });
      this.client = { messages: { create: (args) => sdk.messages.create(args as never) as unknown as Promise<unknown> } };
    }
  }

  async generate(_req: BindingRequest, prompt: { system: string; user: string }): Promise<RawBindingResponse> {
    const response = await this.client!.messages.create({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    }) as { content: Array<{ type: string; text?: string }> };

    const textBlock = response.content.find(c => c.type === 'text' && typeof c.text === 'string');
    if (!textBlock || !textBlock.text) {
      throw new Error('AnthropicProvider: response had no text content');
    }
    return {
      rawText: textBlock.text,
      provider: 'anthropic',
      model: this.model,
      promptHash: hashPrompt(prompt.system, prompt.user),
    };
  }
}
