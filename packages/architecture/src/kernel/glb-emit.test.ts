import { describe, it, expect } from 'vitest';
import { emitGLB } from './glb-emit.js';
import type { Mesh } from './types.js';

const tri: Mesh = {
  positions: new Float32Array([0, 0, 0,  1, 0, 0,  0, 1, 0]),
  normals:   new Float32Array([0, 0, 1,  0, 0, 1,  0, 0, 1]),
  indices:   new Uint32Array([0, 1, 2]),
};

describe('emitGLB', () => {
  it('produces a non-empty ArrayBuffer', () => {
    const out = emitGLB(tri);
    expect(out.byteLength).toBeGreaterThan(100);
  });

  it('output starts with the glTF magic bytes "glTF"', () => {
    const out = emitGLB(tri);
    const view = new Uint8Array(out, 0, 4);
    expect(view[0]).toBe(0x67);   // 'g'
    expect(view[1]).toBe(0x6c);   // 'l'
    expect(view[2]).toBe(0x54);   // 'T'
    expect(view[3]).toBe(0x46);   // 'F'
  });

  it('is byte-deterministic for the same mesh', () => {
    const a = emitGLB(tri);
    const b = emitGLB(tri);
    expect(a.byteLength).toBe(b.byteLength);
    const av = new Uint8Array(a);
    const bv = new Uint8Array(b);
    for (let i = 0; i < av.length; i++) expect(av[i]).toBe(bv[i]);
  });
});
