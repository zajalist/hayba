import { describe, it, expect } from 'vitest';
import { columnGraph } from './column.js';
import type { ElementBinding } from '../../schema.js';

const sampleBinding: ElementBinding = {
  elementId: 'column',
  styleSheetId: 'test',
  seed: 0x1n,
  profiles: {
    shaft:           '<svg viewBox="0 0 200 1000"><path d="M0 0 L 100 0 L 100 1000 L 0 1000 Z"/></svg>',
    base:            '<svg viewBox="0 0 300 80"><path d="M0 0 L 150 0 L 150 80 L 0 80 Z"/></svg>',
    capital_bottom:  '<svg viewBox="-100 -100 200 200"><path d="M-50 -50 L 50 -50 L 50 50 L -50 50 Z"/></svg>',
    capital_top:     '<svg viewBox="-150 -150 300 300"><path d="M-100 -100 L 100 -100 L 100 100 L -100 100 Z"/></svg>',
  },
  params: {
    base_height_m: 0.2,
    shaft_height_m: 3.0,
    capital_height_m: 0.3,
    revolve_segments: 32,
  },
  provenance: { source: 'human', createdAt: '2026-05-13T00:00:00Z' },
};

describe('columnGraph', () => {
  it('produces a non-empty mesh from the sample binding', () => {
    const m = columnGraph(sampleBinding);
    expect(m.positions.length).toBeGreaterThan(0);
    expect(m.indices.length).toBeGreaterThan(0);
    expect(m.indices.length % 3).toBe(0);
  });

  it('is deterministic: same binding → same mesh', () => {
    const a = columnGraph(sampleBinding);
    const b = columnGraph(sampleBinding);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });

  it('column total height ≈ base + shaft + capital', () => {
    const m = columnGraph(sampleBinding);
    let maxY = -Infinity;
    for (let i = 0; i < m.positions.length / 3; i++) {
      maxY = Math.max(maxY, m.positions[i*3 + 1]);
    }
    // 0.2 (base) + 3.0 (shaft) + 0.3 (capital) ≈ 3.5 m total
    expect(maxY).toBeGreaterThan(3.3);
    expect(maxY).toBeLessThan(3.8);
  });
});
