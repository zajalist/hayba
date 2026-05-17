import { describe, it, expect } from 'vitest';
import {
  loadElementCatalog, loadBinding, emitElementMesh,
  _resetCacheForTests, registerBinding,
} from './element-registry.js';
import type { ElementBinding } from './schema.js';

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

  it('error has descriptive message for unknown style sheet', () => {
    const result = emitElementMesh('mystery-culture', 'column');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_found');
      expect(result.message).toMatch(/mystery-culture/);
    }
  });

  it('stats sizeBytes matches GLB byteLength for the Gothic column', () => {
    const result = emitElementMesh('medieval-european-gothic', 'column');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stats.vertices).toBeGreaterThan(0);
      expect(result.stats.sizeBytes).toBe(result.glb.byteLength);
    }
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

describe('registerBinding (session-only binding registration)', () => {
  it('registers a new binding and makes it available via loadBinding', () => {
    const fake: ElementBinding = {
      elementId: 'column',
      styleSheetId: 'test-style-sheet-xyz',
      seed: 0xfacen,
      profiles: {
        shaft:          '<svg viewBox="0 0 200 1000"><path d="M0 0 L 100 0 L 100 1000 L 0 1000 Z"/></svg>',
        base:           '<svg viewBox="0 0 300 80"><path d="M0 0 L 150 0 L 150 80 L 0 80 Z"/></svg>',
        capital_bottom: '<svg viewBox="-100 -100 200 200"><path d="M-50 -50 L 50 -50 L 50 50 L -50 50 Z"/></svg>',
        capital_top:    '<svg viewBox="-150 -150 300 300"><path d="M-100 -100 L 100 -100 L 100 100 L -100 100 Z"/></svg>',
      },
      params: { base_height_m: 0.2, shaft_height_m: 3.0, capital_height_m: 0.3, revolve_segments: 32 },
      provenance: { source: 'ai', aiProvider: 'openai' as const, createdAt: '2026-05-13T00:00:00Z' },
    };
    registerBinding(fake);
    const got = loadBinding('test-style-sheet-xyz', 'column');
    expect(got).not.toBeNull();
    expect(got!.seed).toBe(0xfacen);
  });

  it('overwrites a previously registered binding for the same (styleSheet, element)', () => {
    const first: ElementBinding = {
      elementId: 'column',
      styleSheetId: 'overwrite-test',
      seed: 0x1n,
      profiles: {
        shaft:          '<svg viewBox="0 0 200 1000"><path d="M0 0 L 100 0 L 100 1000 L 0 1000 Z"/></svg>',
        base:           '<svg viewBox="0 0 300 80"><path d="M0 0 L 150 0 L 150 80 L 0 80 Z"/></svg>',
        capital_bottom: '<svg viewBox="-100 -100 200 200"><path d="M-50 -50 L 50 -50 L 50 50 L -50 50 Z"/></svg>',
        capital_top:    '<svg viewBox="-150 -150 300 300"><path d="M-100 -100 L 100 -100 L 100 100 L -100 100 Z"/></svg>',
      },
      params: { base_height_m: 0.2, shaft_height_m: 3.0, capital_height_m: 0.3, revolve_segments: 32 },
      provenance: { source: 'ai', aiProvider: 'openai' as const, createdAt: '2026-05-13T00:00:00Z' },
    };
    const second = { ...first, seed: 0x2n };
    registerBinding(first);
    registerBinding(second);
    expect(loadBinding('overwrite-test', 'column')!.seed).toBe(0x2n);
  });

  it('throws on unknown element id', () => {
    const fake = {
      elementId: 'no-such-element',
      styleSheetId: 'test',
      seed: 0x1n,
      profiles: {},
      params: {},
      provenance: { source: 'ai' as const, createdAt: '2026-05-13T00:00:00Z' },
    } as never as ElementBinding;
    expect(() => registerBinding(fake)).toThrow(/unknown element/);
  });
});
