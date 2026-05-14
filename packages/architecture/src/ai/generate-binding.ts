import type { Element, StyleSheet } from '../index.js';
import { buildPrompt } from './prompt-builder.js';
import { parseResponse } from './response-parser.js';
import type {
  AIProvider, GenerateBindingResult, GenerateBindingError,
} from './types.js';

export interface GenerateBindingArgs {
  element: Element;
  styleSheet: StyleSheet;
  seed: bigint;
  provider: AIProvider;
  referenceImages?: readonly string[];
}

export async function generateBinding(
  args: GenerateBindingArgs,
): Promise<GenerateBindingResult | GenerateBindingError> {
  const { element, styleSheet, seed, provider, referenceImages } = args;

  const prompt = buildPrompt({ element, styleSheet, seed, referenceImages });

  let raw;
  try {
    raw = await provider.generate({ element, styleSheet, seed, referenceImages }, prompt);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      stage: 'provider',
      errors: [{ path: '/', message }],
      message,
    };
  }

  return parseResponse(
    raw.rawText,
    element,
    styleSheet.id,
    seed,
    raw.provider,
    raw.model,
    raw.promptHash,
  );
}
