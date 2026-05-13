/**
 * L18 — Anthropic LLM adapter for L7 derivation.
 *
 * Implements `DerivationLLM` by calling the Anthropic Messages API via the
 * official SDK with structured output (tool use) + prompt caching.
 *
 * Deviation note: the spec originally placed this in `@hayba/mcp`, but the
 * shared `packages/hayba/` tsc check has unrelated pre-existing errors that
 * would block any pre-commit. To keep the hook honest we host the adapter in
 * `@hayba/linguistics` and gate the SDK behind a dynamic import + optional
 * dependency, so the linguistics package stays SDK-free at load time. Hosts
 * that want LLM-backed derivation install `@anthropic-ai/sdk` themselves.
 */

import type { DerivationLLM, DerivationRequest, DerivationCandidate } from './derivation.js';
import { sortedPhonemeSymbols } from './phonology.js';

export interface AnthropicAdapterOpts {
  /** API key. Falls back to `process.env.ANTHROPIC_API_KEY`. */
  apiKey?: string;
  /** Default `claude-sonnet-4-6`. Don't downgrade without a reason. */
  model?: string;
  /** Max tokens for the model response. Default 512 — derivations are tiny. */
  maxTokens?: number;
  /**
   * Optional sample of in-language lexicon entries to include in the system
   * prompt so the model has stylistic context. Cached along with the rest of
   * the system block.
   */
  lexiconSample?: ReadonlyArray<{ concept: string; lemma: string }>;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const TOOL_NAME = 'emit_derivation';

/** Build the system prompt for a given language. Pure → cacheable. */
export function buildSystemPrompt(
  req: DerivationRequest,
  lexiconSample?: ReadonlyArray<{ concept: string; lemma: string }>,
): string {
  const inv = sortedPhonemeSymbols(req.phonology).join(' ');
  const templates = req.phonotactics.syllable.templates.join(', ');
  const vowels = req.phonotactics.vowels.join(' ');
  const sample = lexiconSample && lexiconSample.length > 0
    ? lexiconSample
        .slice(0, 50)
        .map(e => `  ${e.concept} = ${e.lemma}`)
        .join('\n')
    : '  (none provided)';

  return [
    `You coin new words for the constructed language '${req.phonology.languageId}'.`,
    ``,
    `Phoneme inventory (use ONLY these surface forms): ${inv}`,
    `Vowels: ${vowels}`,
    `Syllable templates: ${templates}`,
    ``,
    `Sample lexicon for stylistic context:`,
    sample,
    ``,
    `Rules:`,
    `- Compose lemmas as ASCII / IPA strings whose characters are exactly the phoneme surface forms above.`,
    `- Respect the syllable templates. Do not invent new phonemes or clusters that aren't attested in the sample.`,
    `- Always emit your answer via the '${TOOL_NAME}' tool — never plain prose.`,
    `- Keep the lemma short (1–3 syllables) unless the derivation kind clearly demands more.`,
  ].join('\n');
}

function buildUserPrompt(req: DerivationRequest, attempt: number, feedback: string | null): string {
  const lines: string[] = [];
  lines.push(`Coin a word meaning: "${req.gloss}".`);
  if (req.derivationKind) lines.push(`Derivation kind: ${req.derivationKind}.`);
  if (req.rootLemma) lines.push(`Derive from root: ${req.rootLemma}.`);
  if (attempt > 1 && feedback) {
    lines.push(``);
    lines.push(`Previous attempt was rejected: ${feedback}`);
    lines.push(`Emit a different lemma that satisfies the phonotactics.`);
  }
  return lines.join('\n');
}

/** Minimal shape we read off the SDK message — keeps us decoupled from versions. */
interface AnthropicToolUseBlock {
  type: 'tool_use';
  name: string;
  input: unknown;
}
interface AnthropicTextBlock { type: 'text'; text: string; }
type AnthropicContentBlock = AnthropicToolUseBlock | AnthropicTextBlock | { type: string };
interface AnthropicMessage { content: AnthropicContentBlock[]; }
interface AnthropicMessagesClient {
  create(params: Record<string, unknown>): Promise<AnthropicMessage>;
}
interface AnthropicClient { messages: AnthropicMessagesClient; }
interface AnthropicCtor { new (cfg: { apiKey: string }): AnthropicClient; }

async function loadAnthropic(): Promise<AnthropicCtor> {
  try {
    // Dynamic import keeps the linguistics package SDK-free at load time.
    const mod: unknown = await import(/* @vite-ignore */ '@anthropic-ai/sdk');
    const m = mod as { default?: unknown; Anthropic?: unknown };
    const candidate = m.default ?? m.Anthropic ?? m;
    if (typeof candidate !== 'function') {
      throw new Error('Unexpected @anthropic-ai/sdk shape: no constructor found');
    }
    return candidate as AnthropicCtor;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Anthropic SDK not available (${msg}). Install it with:\n` +
      `  npm install @anthropic-ai/sdk`,
    );
  }
}

export function createAnthropicLLM(opts: AnthropicAdapterOpts = {}): DerivationLLM {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxTokens ?? 512;

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Anthropic API key missing. Pass `apiKey` to createAnthropicLLM or set ANTHROPIC_API_KEY.',
    );
  }

  let clientPromise: Promise<AnthropicClient> | null = null;
  function getClient(): Promise<AnthropicClient> {
    if (!clientPromise) {
      clientPromise = loadAnthropic().then(Ctor => new Ctor({ apiKey: apiKey! }));
    }
    return clientPromise;
  }

  return async (attempt, feedback, req): Promise<DerivationCandidate> => {
    const client = await getClient();
    const system = buildSystemPrompt(req, opts.lexiconSample);
    const user = buildUserPrompt(req, attempt, feedback);

    const tool = {
      name: TOOL_NAME,
      description: 'Emit a single derived lexeme for the requested gloss.',
      input_schema: {
        type: 'object',
        properties: {
          lemma: { type: 'string', description: 'Surface form using only inventory phonemes.' },
          ipa: { type: 'string', description: 'IPA transcription (defaults to lemma).' },
          etymology: { type: 'string', description: 'Short prose etymology.' },
        },
        required: ['lemma'],
      },
    };

    const resp = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // Anthropic default is 1.0, which is too hot for short lexeme coinage —
      // we want the model to commit to a plausible form, not roll dice on
      // exotic phoneme combinations.
      temperature: 0.7,
      // Prompt caching — the system block is stable per language, so subsequent
      // calls within ~5 minutes hit the ephemeral cache.
      system: [
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: user }],
      tools: [tool],
      tool_choice: { type: 'tool', name: TOOL_NAME },
    });

    const block = resp.content.find((b): b is AnthropicToolUseBlock =>
      b.type === 'tool_use' && (b as AnthropicToolUseBlock).name === TOOL_NAME,
    );
    if (!block) {
      throw new Error(`Anthropic response missing '${TOOL_NAME}' tool_use block`);
    }
    const input = block.input as Partial<DerivationCandidate> | undefined;
    if (!input || typeof input.lemma !== 'string' || input.lemma.length === 0) {
      throw new Error(`Anthropic tool_use input missing 'lemma' string`);
    }
    return {
      lemma: input.lemma,
      ipa: typeof input.ipa === 'string' ? input.ipa : undefined,
      etymology: typeof input.etymology === 'string' ? input.etymology : undefined,
    };
  };
}
