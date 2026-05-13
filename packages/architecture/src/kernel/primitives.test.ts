import { describe, it, expect } from 'vitest';
import {
  IDENTITY_M, translateY, scale, rotateY, compose, transform, revolve, loft,
} from './primitives.js';
import type { Mesh } from './types.js';
import { parseSvgProfile } from './svg-parse.js';

const triMesh = (): Mesh => ({
  positions: new Float32Array([0, 0, 0,  1, 0, 0,  0, 1, 0]),
  normals:   new Float32Array([0, 0, 1,  0, 0, 1,  0, 0, 1]),
  indices:   new Uint32Array([0, 1, 2]),
});

describe('matrix helpers', () => {
  it('translateY moves vertices up by Y', () => {
    const m = translateY(5);
    expect(m[13]).toBe(5);
  });
  it('scale produces a diagonal matrix', () => {
    const m = scale(2, 3, 4);
    expect(m[0]).toBe(2); expect(m[5]).toBe(3); expect(m[10]).toBe(4);
  });
  it('rotateY(0) equals identity', () => {
    const m = rotateY(0);
    for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(IDENTITY_M[i]);
  });
  it('compose(a, b) applies b then a', () => {
    const t = translateY(2);
    const s = scale(3, 3, 3);
    const c = compose(t, s);
    const mesh = transform({ positions: new Float32Array([0, 1, 0]), normals: new Float32Array([0,0,1]), indices: new Uint32Array([0]) }, c);
    expect(mesh.positions[1]).toBeCloseTo(5);
  });
});

describe('transform(mesh, matrix)', () => {
  it('identity returns identical positions', () => {
    const m = transform(triMesh(), IDENTITY_M);
    expect(Array.from(m.positions)).toEqual([0, 0, 0,  1, 0, 0,  0, 1, 0]);
  });
  it('translates each vertex', () => {
    const out = transform(triMesh(), translateY(10));
    expect(out.positions[1]).toBeCloseTo(10);
    expect(out.positions[4]).toBeCloseTo(10);
    expect(out.positions[7]).toBeCloseTo(11);
  });
  it('preserves index buffer byte-identically', () => {
    const out = transform(triMesh(), translateY(1));
    expect(Array.from(out.indices)).toEqual([0, 1, 2]);
  });
  it('rotateY(180°) flips X coordinate', () => {
    const out = transform(triMesh(), rotateY(Math.PI));
    expect(out.positions[3]).toBeCloseTo(-1);
  });
});

describe('revolve', () => {
  it('a 100mm × 1000mm rectangle revolved 360° produces a mesh', () => {
    const profile = parseSvgProfile(
      '<svg viewBox="0 0 100 1000"><path d="M0 0 L 100 0 L 100 1000 L 0 1000 Z"/></svg>',
      'symmetric-half',
    );
    const m = revolve(profile, 'Y', 16, 360);
    expect(m.positions.length).toBeGreaterThan(0);
    expect(m.indices.length).toBeGreaterThan(0);
    expect(m.indices.length % 3).toBe(0);
  });
  it('produces deterministic output', () => {
    const profile = parseSvgProfile(
      '<svg viewBox="0 0 50 200"><path d="M0 0 L 50 0 L 50 200 L 0 200 Z"/></svg>',
      'symmetric-half',
    );
    const a = revolve(profile, 'Y', 24, 360);
    const b = revolve(profile, 'Y', 24, 360);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });
  it('rejects non-symmetric-half input', () => {
    const profile = parseSvgProfile(
      '<svg viewBox="0 0 100 100"><path d="M0 0 L 100 0 L 100 100 L 0 100 Z"/></svg>',
      'closed-path',
    );
    expect(() => revolve(profile, 'Y', 16, 360)).toThrow(/symmetric-half/);
  });
  it('output triangles are all properly indexed', () => {
    const profile = parseSvgProfile(
      '<svg viewBox="0 0 30 60"><path d="M0 0 L 30 0 L 30 60 L 0 60 Z"/></svg>',
      'symmetric-half',
    );
    const m = revolve(profile, 'Y', 8, 360);
    const vertCount = m.positions.length / 3;
    for (let i = 0; i < m.indices.length; i++) {
      expect(m.indices[i]).toBeGreaterThanOrEqual(0);
      expect(m.indices[i]).toBeLessThan(vertCount);
    }
  });
});

describe('loft', () => {
  const sq = (size: number) => parseSvgProfile(
    `<svg viewBox="${-size/2} ${-size/2} ${size} ${size}"><path d="M${-size/2} ${-size/2} L ${size/2} ${-size/2} L ${size/2} ${size/2} L ${-size/2} ${size/2} Z"/></svg>`,
    'closed-path',
  );

  it('interpolates between two same-sized squares (extrusion)', () => {
    const a = sq(100), b = sq(100);
    const m = loft([a, b], [[0, 0, 0], [0, 100, 0]]);
    expect(m.positions.length).toBeGreaterThan(0);
    expect(m.indices.length % 3).toBe(0);
  });

  it('interpolates between two different-sized squares (frustum)', () => {
    const a = sq(100), b = sq(200);
    const m = loft([a, b], [[0, 0, 0], [0, 100, 0]]);
    // 4 closed-path verts per profile × 2 layers = 8 vertices.
    // Modular wrap → 4 edges × 2 triangles per edge = 8 triangles.
    expect(m.positions.length / 3).toBe(8);
    expect(m.indices.length / 3).toBe(8);
  });

  it('is deterministic', () => {
    const a = sq(50), b = sq(150);
    const m1 = loft([a, b], [[0, 0, 0], [0, 200, 0]]);
    const m2 = loft([a, b], [[0, 0, 0], [0, 200, 0]]);
    expect(Array.from(m1.positions)).toEqual(Array.from(m2.positions));
    expect(Array.from(m1.indices)).toEqual(Array.from(m2.indices));
  });

  it('rejects mismatched profile/position counts', () => {
    const a = sq(50);
    expect(() => loft([a], [[0, 0, 0], [0, 100, 0]])).toThrow();
    expect(() => loft([a, a, a], [[0, 0, 0], [0, 100, 0]])).toThrow();
  });

  it('rejects non-closed-path profiles', () => {
    const open = parseSvgProfile(
      '<svg viewBox="0 0 100 100"><path d="M0 0 L 100 0 L 100 100"/></svg>',
      'open-path',
    );
    expect(() => loft([open, open], [[0, 0, 0], [0, 100, 0]])).toThrow(/closed-path/);
  });
});
