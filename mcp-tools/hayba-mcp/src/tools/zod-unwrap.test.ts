import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { unwrapZod, formatDefault } from './zod-unwrap.js';

// This module is the single source of truth two describers used to duplicate
// (#322): schema-registry's tool-catalogue prose and agent-loop's JSON Schema
// for the chat sidecar. The divergence bug was that `.default()` was treated
// as optional in one place and required in the other. These tests pin the
// unified contract so a future edit cannot reintroduce that split.

describe('unwrapZod', () => {
  it('a bare required schema is not optional and has no default', () => {
    const r = unwrapZod(z.string());
    expect(r.optional).toBe(false);
    expect(r.hasDefault).toBe(false);
    expect(r.defaultValue).toBeUndefined();
    expect(r.inner).toBeInstanceOf(z.ZodString);
  });

  it('.optional() marks optional with no default', () => {
    const r = unwrapZod(z.string().optional());
    expect(r.optional).toBe(true);
    expect(r.hasDefault).toBe(false);
  });

  it('.nullable() marks optional (an agent may omit it) with no default', () => {
    const r = unwrapZod(z.string().nullable());
    expect(r.optional).toBe(true);
    expect(r.hasDefault).toBe(false);
  });

  it('.default() counts as optional AND carries the default value — the #322 rule', () => {
    const r = unwrapZod(z.number().default(42));
    expect(r.optional).toBe(true);
    expect(r.hasDefault).toBe(true);
    expect(r.defaultValue).toBe(42);
  });

  it('unwraps down to the innermost schema through every wrapper combination', () => {
    const r = unwrapZod(z.boolean().default(true).optional());
    expect(r.inner).toBeInstanceOf(z.ZodBoolean);
  });

  it('keeps the OUTERMOST default when defaults are nested', () => {
    // z.string().default('inner') wrapped again with .default('outer') — the
    // outer one is what actually applies when the param is omitted.
    const inner = z.string().default('inner');
    const outer = inner.default('outer' as never);
    const r = unwrapZod(outer as unknown as z.ZodTypeAny);
    expect(r.defaultValue).toBe('outer');
  });

  it('sees through a preprocess pipe to the schema being validated (the `out` side)', () => {
    const r = unwrapZod(z.preprocess((v) => Number(v), z.number()));
    expect(r.inner).toBeInstanceOf(z.ZodNumber);
  });

  it('sees through a .transform() pipe to the input schema (the `in` side)', () => {
    const r = unwrapZod(z.string().transform((s) => s.length));
    expect(r.inner).toBeInstanceOf(z.ZodString);
  });
});

describe('formatDefault', () => {
  it('renders a short JSON value', () => {
    expect(formatDefault(42)).toBe('42');
    expect(formatDefault('low')).toBe('"low"');
    expect(formatDefault(true)).toBe('true');
  });

  it('returns null when the rendered form exceeds 40 characters — token budget guard', () => {
    const long = 'x'.repeat(41);
    expect(formatDefault(long)).toBeNull();
    // 40 chars exactly (38 chars + 2 quotes) must still render.
    const exactly40 = 'x'.repeat(38);
    expect(formatDefault(exactly40)).toHaveLength(40);
  });

  it('returns null rather than throwing on a circular value', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatDefault(circular)).toBeNull();
  });

  it('renders undefined as null (JSON.stringify(undefined) is undefined)', () => {
    expect(formatDefault(undefined)).toBe('null');
  });
});
