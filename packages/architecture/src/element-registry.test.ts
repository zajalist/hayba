import { describe, it, expect } from 'vitest';
import {
  loadElementCatalog, loadBinding, emitElementMesh,
  _resetCacheForTests,
} from './element-registry.js';

describe('element-registry', () => {
  it('loads the column element type', () => {
    const cat = loadElementCatalog();
    expect(cat.elementsById.has('column')).toBe(true);
  });

  it('loads the Gothic column binding', () => {
    const b = loadBinding('medieval-european-gothic', 'column');
    expect(b).not.toBeNull();
    expect(b!.elementId).toBe('column');
    expect(b!.styleSheetId).toBe('medieval-european-gothic');
    expect(typeof b!.seed).toBe('bigint');
  });

  it('emits a non-empty mesh for the Gothic column', () => {
    const result = emitElementMesh('medieval-european-gothic', 'column');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.glb.byteLength).toBeGreaterThan(200);
      expect(result.stats.triangles).toBeGreaterThan(0);
    }
  });

  it('returns error for unknown style sheet', () => {
    const result = emitElementMesh('mystery', 'column');
    expect(result.ok).toBe(false);
  });

  it('returns error for unknown element', () => {
    const result = emitElementMesh('medieval-european-gothic', 'mystery');
    expect(result.ok).toBe(false);
  });
});

describe('determinism — Gothic column GLB byte-equality', () => {
  it('two emits of the same binding produce byte-identical GLB output', () => {
    const a = emitElementMesh('medieval-european-gothic', 'column');
    const b = emitElementMesh('medieval-european-gothic', 'column');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.glb.byteLength).toBe(b.glb.byteLength);
      const av = new Uint8Array(a.glb);
      const bv = new Uint8Array(b.glb);
      for (let i = 0; i < av.length; i++) {
        if (av[i] !== bv[i]) throw new Error(`byte mismatch at offset ${i}: ${av[i]} vs ${bv[i]}`);
      }
    }
  });

  it('cache reset + re-emit still produces byte-identical output', () => {
    const a = emitElementMesh('medieval-european-gothic', 'column');
    _resetCacheForTests();
    const b = emitElementMesh('medieval-european-gothic', 'column');
    expect(a.ok && b.ok && a.glb.byteLength === b.glb.byteLength).toBe(true);
  });
});
