/**
 * How a Zod schema is rendered into a tool signature.
 *
 * `describeZod` is what an agent reads when it asks what a tool takes, and it
 * works entirely through Zod's internals — which zod 4 rearranged wholesale:
 *
 *   ZodEffects            -> ZodPipe, with `_def.in` / `_def.out`
 *   `_def.typeName`       -> `_def.type` ("ZodString" -> "string")
 *   `_def.values` (enum)  -> the public `.options`
 *   `_def.type` (array)   -> `_def.element`   ← the nasty one: the old name
 *                            still exists and now holds the string "array"
 *   `_def.description`    -> the public `.description` getter
 *
 * None of those throw when read from the old place. They return undefined, so
 * the migration typechecked clean and the entire catalogue quietly lost its
 * parameter documentation — every param rendering as "string (optional)" with
 * nothing after it. One assertion in legacy-tool-factory.test.ts caught it.
 * This file is the coverage that should have existed.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { recordSchema, deriveSignature } from '../schema-registry.js';

function sigFor(shape: z.ZodRawShape): Record<string, string> {
  const name = `__probe_${Math.random().toString(36).slice(2)}`;
  recordSchema(name, { shape, cost: 'low', returns: 'any' });
  const sig = deriveSignature(name);
  expect(sig, 'deriveSignature should find a recorded schema').not.toBeNull();
  return sig!.params;
}

describe('describeZod under zod 4', () => {
  it('renders primitives with required/optional', () => {
    const p = sigFor({
      a: z.string(),
      b: z.number().optional(),
      c: z.boolean(),
    });
    expect(p.a).toBe('string (required)');
    expect(p.b).toBe('number (optional)');
    expect(p.c).toBe('bool (required)');
  });

  it('keeps .describe() text — the regression that typechecked clean', () => {
    const p = sigFor({
      actor_label: z.string().describe('Editor actor label'),
      wrapped: z.string().describe('inner text').optional(),
    });
    expect(p.actor_label).toContain('Editor actor label');
    // The description sits on the inner schema once .optional() wraps it, so
    // reading only the outer schema loses it.
    expect(p.wrapped).toContain('inner text');
    expect(p.wrapped).toContain('(optional)');
  });

  it('lists enum members rather than the word "enum"', () => {
    const p = sigFor({ mode: z.enum(['fast', 'slow']) });
    expect(p.mode).toContain('"fast"');
    expect(p.mode).toContain('"slow"');
  });

  it('renders arrays by element type, not as "array[]"', () => {
    // zod 4 kept `_def.type` on arrays but repurposed it to the literal string
    // "array"; the element moved to `_def.element`. Reading the old name yields
    // a plausible-looking nothing — this would render "array[]" or "any[]".
    //
    // The nested "(required)" is pre-existing: describeZod recurses into itself
    // for the element and the qualifier comes along. Ugly, not wrong, and not
    // this change's business.
    const p = sigFor({ names: z.array(z.string()) });
    expect(p.names).toContain('string');
    expect(p.names).toContain('[]');
    expect(p.names).not.toContain('array[]');
    expect(p.names).not.toContain('any[]');
  });

  it('renders tuples element-wise', () => {
    const p = sigFor({ loc: z.tuple([z.number(), z.number(), z.number()]) });
    expect(p.loc.startsWith('[')).toBe(true);
    expect(p.loc.match(/number/g)?.length).toBe(3);
  });

  it('sees through preprocess to the real type', () => {
    const p = sigFor({
      n: z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number()),
    });
    expect(p.n, 'a preprocessed number should still read as a number').toContain('number');
  });

  it('keeps object/any legible', () => {
    const p = sigFor({
      opts: z.object({ x: z.string() }).optional(),
      any: z.unknown(),
    });
    expect(p.opts).toContain('object');
    expect(p.opts).toContain('(optional)');
    expect(p.any).toContain('any');
  });

  it('PINS A KNOWN INACCURACY: a defaulted param is reported as required', () => {
    // Pre-existing, not a zod 4 regression — the unwrap loop steps through
    // ZodDefault without setting the optional flag, and this predates the
    // migration.
    //
    // It is still wrong from the caller's side: a param with a default does not
    // have to be supplied, and telling an agent "required" makes it invent a
    // value rather than let the default apply. Pinned here so the behaviour is
    // visible and so fixing it fails this test loudly rather than silently
    // changing what every tool advertises. See the follow-up issue.
    const p = sigFor({ d: z.string().default('x') });
    expect(p.d).toContain('(required)');
  });
});
