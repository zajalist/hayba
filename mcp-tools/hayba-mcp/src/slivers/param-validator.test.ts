// mcp-tools/hayba-mcp/src/slivers/param-validator.test.ts
import { describe, it, expect } from 'vitest';
import { validateAndCoerceParams } from './param-validator.js';
import type { SliverParam } from './types.js';

const params: SliverParam[] = [
  { id: 'distance', type: 'float', range: [1, 100], default: 10 },
  { id: 'pick',     type: 'enum',  options: [{ value: 'a' }, { value: 'b' }], default: 'a' },
  { id: 'on',       type: 'bool',  default: false },
  { id: 'target',   type: 'actor_ref', required: true },
];

describe('validateAndCoerceParams', () => {
  it('fills defaults when values are omitted', () => {
    const r = validateAndCoerceParams(params, { target: '/Game/X.X' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values).toEqual({ distance: 10, pick: 'a', on: false, target: '/Game/X.X' });
  });

  it('fails when a required param is missing', () => {
    const r = validateAndCoerceParams(params, { distance: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/target/);
  });

  it('rejects out-of-range floats', () => {
    const r = validateAndCoerceParams(params, { target: '/Game/X.X', distance: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/distance/);
  });

  it('rejects enum values not in options', () => {
    const r = validateAndCoerceParams(params, { target: '/Game/X.X', pick: 'z' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/pick/);
  });

  it('rejects wrong types', () => {
    const r = validateAndCoerceParams(params, { target: '/Game/X.X', distance: 'big' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown param ids', () => {
    const r = validateAndCoerceParams(params, { target: '/Game/X.X', wat: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/wat/);
  });
});
