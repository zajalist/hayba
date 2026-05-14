import type {
  Element, ElementBinding, AIProviderName,
} from '../index.js';
import { validateElementBinding } from '../index.js';
import { parseSvgProfile } from '../kernel/svg-parse.js';
import type { GenerateBindingResult, GenerateBindingError } from './types.js';

function extractJson(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return raw.trim();
  return raw.slice(start, end + 1);
}

export function parseResponse(
  rawText: string,
  element: Element,
  styleSheetId: string,
  seed: bigint,
  provider: AIProviderName,
  model: string,
  promptHash: string,
): GenerateBindingResult | GenerateBindingError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(rawText));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      stage: 'parse',
      errors: [{ path: '/', message: `JSON.parse failed: ${message}` }],
      rawText,
      message,
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      ok: false,
      stage: 'parse',
      errors: [{ path: '/', message: 'expected JSON object' }],
      rawText,
      message: 'expected JSON object',
    };
  }

  const obj = parsed as { profiles?: unknown; params?: unknown; rationale?: unknown };

  const candidate = {
    elementId: element.id,
    styleSheetId,
    seed,
    profiles: obj.profiles ?? {},
    params:   obj.params   ?? {},
    provenance: {
      source: 'ai' as const,
      aiProvider: provider,
      aiModel: model,
      promptHash,
      createdAt: new Date().toISOString(),
    },
  };

  const errs = validateElementBinding(candidate, element, '/binding');
  if (errs.length > 0) {
    return { ok: false, stage: 'validate', errors: errs, rawText, message: `${errs.length} validation error(s)` };
  }

  const binding = candidate as ElementBinding;
  for (const slot of element.profileSlots) {
    try {
      parseSvgProfile(binding.profiles[slot.name], slot.hint);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        stage: 'svg-parse',
        errors: [{ path: `/binding/profiles/${slot.name}`, message }],
        rawText,
        message,
      };
    }
  }

  const rationale = typeof obj.rationale === 'string' ? obj.rationale : undefined;
  return { ok: true, draft: binding, rationale, retries: 0 };
}
