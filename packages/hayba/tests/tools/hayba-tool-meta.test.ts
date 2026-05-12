import { describe, it, expect } from 'vitest';
import { describeMeta, appendMeta, type HaybaToolMeta } from '../../src/tools/hayba-tool-meta.js';

describe('HaybaToolMeta', () => {
  it('renders meta as a description suffix', () => {
    const meta: HaybaToolMeta = {
      cost: 'medium',
      effects: ['spawns_actor'],
      when: 'placing a new asset',
      not_when: 'just reading positions',
    };
    const out = describeMeta(meta);
    expect(out).toContain('cost=medium');
    expect(out).toContain('effects=[spawns_actor]');
    expect(out).toContain('USE_WHEN: placing a new asset');
    expect(out).toContain('NOT_WHEN: just reading positions');
  });

  it('appendMeta concatenates description + meta with double newline', () => {
    const meta: HaybaToolMeta = { cost: 'low', effects: [], when: 'x', not_when: 'y' };
    expect(appendMeta('A description.', meta)).toMatch(/^A description\.\n\n/);
  });
});
