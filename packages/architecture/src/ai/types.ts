/**
 * Shared types for the AI binding pipeline.
 *
 * Provider implementations consume a BindingRequest and return a BindingResponse.
 * The validator/parser chain then ingests the response into an ElementBinding
 * which is the engine's bit-exact deterministic input.
 */

import type { Element, ElementBinding, StyleSheet, ValidationError } from '../index.js';

export interface BindingRequest {
  element: Element;
  styleSheet: StyleSheet;
  /** Optional explicit seed; if omitted, provider may pick its own. */
  seed?: bigint;
  /** Optional user-uploaded reference image paths or data URLs. v1 — not consumed by mock or Anthropic v0. */
  referenceImages?: readonly string[];
}

export interface RawBindingResponse {
  /** Raw text the LLM returned. Caller will JSON.parse this. */
  rawText: string;
  /** Provider identity + model id for provenance tracking. */
  provider: AIProviderName;
  model: string;
  /** Hash of the prompt sent — used for binding provenance. */
  promptHash: string;
}

export interface ParsedBindingDraft {
  binding: ElementBinding;
  rationale?: string;
}

export type AIProviderName =
  | 'anthropic' | 'openai' | 'openai-compat'
  | 'groq' | 'openrouter' | 'ollama' | 'lmstudio'
  | 'fal' | 'local' | 'mock';

export interface AIProvider {
  readonly name: AIProviderName;
  readonly model: string;
  generate(req: BindingRequest, prompt: { system: string; user: string }): Promise<RawBindingResponse>;
}

export interface GenerateBindingResult {
  ok: true;
  draft: ElementBinding;
  rationale?: string;
  retries: 0;   // future-proofed for retry loop
}
export interface GenerateBindingError {
  ok: false;
  stage: 'provider' | 'parse' | 'validate' | 'svg-parse';
  errors: ValidationError[];
  rawText?: string;
  message: string;
}
