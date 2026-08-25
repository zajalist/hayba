import { describe, it, expect } from 'vitest';
import { recipeSpecSchema, parseRecipeSpec } from './spec-schema.js';

const valid = {
  id: 'com.hayba.composition.frame_target',
  version: '1.0.0',
  category: 'composition',
  title: 'Frame Target',
  description: 'Compute a camera transform.',
  author: 'core',
  params: [
    { id: 'target', type: 'actor_ref', required: true },
    { id: 'distance', type: 'float', range: [1, 100], default: 10 },
  ],
  executor: { kind: 'composition.frame_target' },
  determinism: { pure: true, declared_outputs: ['camera_transform'], side_effects: [], seed_param: null },
};

describe('recipe spec schema', () => {
  it('accepts a valid spec', () => {
    expect(() => recipeSpecSchema.parse(valid)).not.toThrow();
  });

  it('parseRecipeSpec returns ok=true on valid input', () => {
    const r = parseRecipeSpec(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.id).toBe(valid.id);
  });

  it('parseRecipeSpec returns ok=false with reason on bad input', () => {
    const r = parseRecipeSpec({ ...valid, id: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/id/i);
  });

  it('rejects ids that are not reverse-DNS', () => {
    const r = parseRecipeSpec({ ...valid, id: 'frame_target' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown param types', () => {
    const r = parseRecipeSpec({
      ...valid,
      params: [{ id: 'x', type: 'banana' as unknown as 'float' }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate param ids', () => {
    const r = parseRecipeSpec({
      ...valid,
      params: [
        { id: 'a', type: 'float' },
        { id: 'a', type: 'int' },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/duplicate/i);
  });

  it('accepts an optional determinism.reads[] and defaults it to []', () => {
    const base = {
      id: 'com.test.reads', version: '1.0.0', category: 'test', title: 'R',
      description: '', author: 't', params: [], executor: { kind: 'test.r' },
    };
    const withReads = parseRecipeSpec({
      ...base,
      determinism: { pure: true, declared_outputs: [], side_effects: [], reads: ['ue://*'], seed_param: null },
    });
    expect(withReads.ok).toBe(true);
    if (withReads.ok) expect(withReads.spec.determinism.reads).toEqual(['ue://*']);

    const withoutReads = parseRecipeSpec({
      ...base,
      determinism: { pure: true, declared_outputs: [], side_effects: [], seed_param: null },
    });
    expect(withoutReads.ok).toBe(true);
    if (withoutReads.ok) expect(withoutReads.spec.determinism.reads).toEqual([]);
  });
});

describe('requirements must be evaluatable, not merely well-shaped', () => {
  const base = {
    id: 'com.test.req', version: '1.0.0', category: 'test', title: 'T',
    description: '', author: 'test', params: [], executor: { kind: 'k' },
    determinism: { pure: true, declared_outputs: [], side_effects: [], reads: [], seed_param: null },
  };

  it('rejects a primitive outside the closed set', () => {
    // evaluate() SKIPS an unrecognised primitive, on the assumption that this
    // parse rejected it. Nothing used to call that validation, so such a spec
    // loaded fine and was then reported satisfied while checking nothing.
    const r = parseRecipeSpec({
      ...base,
      requires: [{ primitive: 'no_such_primitive', params: {}, binding: { asset: '/Game/T.T' } }],
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/primitive/i);
  });

  it('still accepts a requirement the evaluator understands', () => {
    const r = parseRecipeSpec({
      ...base,
      requires: [{ primitive: 'clearance', params: { min_m: 1 }, binding: { asset: '/Game/T.T' } }],
    });

    expect(r.ok).toBe(true);
  });
});
