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

  // This replaces a test named "PINS A KNOWN INACCURACY", which asserted that a
  // defaulted param was advertised as `(required)` so that fixing it would fail
  // loudly rather than silently change what every tool advertises. #322 is that
  // fix; the pin has done its job and is now inverted.
  it('a defaulted param is optional, and says what the default is', () => {
    const p = sigFor({ d: z.string().default('x') });
    expect(p.d, 'a param with a default does not have to be supplied').toContain('(optional');
    expect(p.d, 'and telling an agent it is required makes it invent a value').not.toContain('(required)');
    expect(p.d, 'knowing the value it would get is what makes omitting it a choice').toContain('default: "x"');
  });

  it('reports a default it cannot quote briefly as existing rather than in full', () => {
    // Every parameter line is paid for in the context window of every agent
    // that reads the catalogue.
    const p = sigFor({ d: z.array(z.string()).default(['a'.repeat(60)]) });
    expect(p.d).toContain('(optional');
    expect(p.d).toContain('has a default');
    expect(p.d.length, 'the long value itself is not pasted in').toBeLessThan(80);
  });

  it('still separates a plain optional from a defaulted one', () => {
    // "may be omitted" and "may be omitted, and here is what you get" are
    // different facts; collapsing them loses the second.
    const p = sigFor({ o: z.string().optional(), d: z.number().default(5) });
    expect(p.o).toContain('(optional)');
    expect(p.d).toContain('default: 5');
  });

  it('sees a default through the wrappers around it', () => {
    // .optional().default() and .default().optional() are both real spellings
    // in this codebase (py-tool-factory descriptors use the first).
    expect(sigFor({ d: z.number().optional().default(5) }).d).toContain('default: 5');
    expect(sigFor({ d: z.number().default(5).optional() }).d).toContain('default: 5');
  });
});
