import { describe, it, expect } from 'vitest';
import { parsePrimitiveAttrs } from './contracts.js';

describe('parsePrimitiveAttrs', () => {
  it('parses a full tunnel attr set', () => {
    const a = parsePrimitiveAttrs({ primId: 1, kind: 'tunnel', builder: 'native', phase: 'I', seed: 7, w: 2.2, h: 2.6, importance: 0.3 });
    expect(a).toEqual({ primId: 1, kind: 'tunnel', builder: 'native', phase: 'I', seed: 7, w: 2.2, h: 2.6, importance: 0.3 });
  });
  it('applies defaults for room (w/h/importance/seed/phase)', () => {
    const a = parsePrimitiveAttrs({ primId: 2, kind: 'room', builder: 'imperial' });
    expect(a).toMatchObject({ primId: 2, kind: 'room', builder: 'imperial', phase: 'I', seed: 0, importance: 0.3 });
  });
  it('throws on invalid builder', () => {
    expect(() => parsePrimitiveAttrs({ primId: 3, kind: 'room', builder: 'martian' })).toThrow();
  });
});
