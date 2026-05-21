import { describe, it, expect } from 'vitest';
import { sliverSpecSchema, parseSliverSpec } from './spec-schema.js';

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

describe('sliver spec schema', () => {
  it('accepts a valid spec', () => {
    expect(() => sliverSpecSchema.parse(valid)).not.toThrow();
  });

  it('parseSliverSpec returns ok=true on valid input', () => {
    const r = parseSliverSpec(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.id).toBe(valid.id);
  });

  it('parseSliverSpec returns ok=false with reason on bad input', () => {
    const r = parseSliverSpec({ ...valid, id: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/id/i);
  });

  it('rejects ids that are not reverse-DNS', () => {
    const r = parseSliverSpec({ ...valid, id: 'frame_target' });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown param types', () => {
    const r = parseSliverSpec({
      ...valid,
      params: [{ id: 'x', type: 'banana' as unknown as 'float' }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects duplicate param ids', () => {
    const r = parseSliverSpec({
      ...valid,
      params: [
        { id: 'a', type: 'float' },
        { id: 'a', type: 'int' },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/duplicate/i);
  });
});
