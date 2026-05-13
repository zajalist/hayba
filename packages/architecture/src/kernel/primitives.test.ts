import { describe, it, expect } from 'vitest';
import {
  IDENTITY_M, translateY, scale, rotateY, compose, transform,
} from './primitives.js';
import type { Mesh } from './types.js';

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
