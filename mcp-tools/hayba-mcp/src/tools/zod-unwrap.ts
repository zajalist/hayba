// The one place that decides what a zod wrapper MEANS to a caller.
//
// Two describers walk the same wrappers for different outputs: schema-registry
// renders prose for the tool catalogue, agent-loop emits JSON Schema for the
// chat sidecar. They each grew their own copy of the unwrap loop, and the
// copies disagreed — agent-loop treated `.default()` as optional, the catalogue
// did not, so the same parameter was advertised two different ways depending on
// which surface an agent was looking at (#322). ADR-0007: two copies of one
// rule diverge, and the divergence is the bug.
//
// The rule lives here now. The two describers keep their own rendering.

import { z, type ZodTypeAny } from 'zod';

export interface UnwrappedZod {
  /** The type underneath every wrapper — what to render. */
  inner: ZodTypeAny;
  /** Whether the caller may omit this parameter. */
  optional: boolean;
  /** Whether omitting it produces a value rather than nothing. */
  hasDefault: boolean;
  /** That value, when there is one. */
  defaultValue?: unknown;
}

/**
 * Strip optional/default/nullable wrappers and see through a pipe.
 *
 * `.default()` counts as optional. It is the whole point of the wrapper: the
 * parameter does not have to be supplied. Advertising it as required makes an
 * agent invent a value instead of letting the default apply, which quietly
 * stops the default from being the default on every agent-driven call.
 */
export function unwrapZod(t: ZodTypeAny): UnwrappedZod {
  let optional = false;
  let hasDefault = false;
  let defaultValue: unknown;
  let inner: ZodTypeAny = t;

  // ZodOptional / ZodDefault / ZodNullable all expose ._def.innerType.
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodDefault ||
    inner instanceof z.ZodNullable
  ) {
    if (inner instanceof z.ZodDefault) {
      optional = true;
      if (!hasDefault) {
        // The OUTERMOST default is the one that applies, so keep the first seen.
        hasDefault = true;
        // zod 4 stores the value itself; zod 3 stored a thunk. Reading the
        // wrong shape here yields a function where a value was expected rather
        // than throwing, so handle both and let the tests say which is live.
        const raw = (inner._def as unknown as { defaultValue: unknown }).defaultValue;
        defaultValue = typeof raw === 'function' ? (raw as () => unknown)() : raw;
      }
    } else {
      optional = true;
    }
    inner = (inner as unknown as { _def: { innerType: ZodTypeAny } })._def.innerType;
  }

  // zod 4 replaced ZodEffects with ZodPipe: preprocess/transform are a pipe
  // whose two ends are `_def.in` and `_def.out`. Describe the end that is not
  // the transform — for z.preprocess(fn, schema) that is `out`, for
  // schema.transform(fn) it is `in`.
  while (inner instanceof z.ZodPipe) {
    const { in: pin, out: pout } = inner._def as unknown as { in: ZodTypeAny; out: ZodTypeAny };
    inner = pout instanceof z.ZodTransform ? pin : pout;
  }

  return { inner, optional, hasDefault, defaultValue };
}

/**
 * A default rendered for a human-readable signature, or null when it is not
 * worth the tokens.
 *
 * Every tool's parameter list is paid for in the context window of every agent
 * that reads the catalogue, so a default that would take more room than the
 * parameter it documents is reported as existing rather than quoted in full.
 */
export function formatDefault(value: unknown): string | null {
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'null';
  } catch {
    return null; // circular or otherwise unprintable — say nothing rather than throw
  }
  return text.length <= 40 ? text : null;
}
