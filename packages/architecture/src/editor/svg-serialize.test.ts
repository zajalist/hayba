import { describe, it, expect } from 'vitest';
import {
  verticesToSvgPath, parsePathD, applyHint, sanitizeVertices,
} from './svg-serialize.js';
import { parseSvgProfile } from '../kernel/svg-parse.js';

describe('verticesToSvgPath', () => {
  it('emits M ... L ... Z for a closed-path rectangle', () => {
    const svg = verticesToSvgPath(
      [[0, 0], [100, 0], [100, 50], [0, 50]],
      [0, 0, 100, 50],
      'closed-path',
    );
    expect(svg).toContain('viewBox="0 0 100 50"');
    expect(svg).toMatch(/M\s*0\s*0/);
    expect(svg).toContain('Z');
  });

  it('emits M ... L ... without Z for an open-path polyline', () => {
    const svg = verticesToSvgPath(
      [[0, 0], [50, 25], [100, 0]],
      [0, 0, 100, 50],
      'open-path',
    );
    expect(svg).not.toContain('Z');
    expect(svg).toContain('M');
  });

  it('round-trips through parseSvgProfile (closed-path)', () => {
    const verts: [number, number][] = [[0, 0], [100, 0], [100, 50], [0, 50]];
    const svg = verticesToSvgPath(verts, [0, 0, 100, 50], 'closed-path');
    const parsed = parseSvgProfile(svg, 'closed-path');
    expect(parsed.points.length).toBeGreaterThanOrEqual(4);
  });

  it('rounds coords to 4 decimal places for determinism', () => {
    const svg = verticesToSvgPath(
      [[0.123456789, 1.2345678], [100, 100]],
      [0, 0, 100, 100],
      'open-path',
    );
    expect(svg).toContain('0.1235');
    expect(svg).toContain('1.2346');
  });
});

describe('parsePathD', () => {
  it('extracts (x, y) pairs from a simple M L L Z path d-string', () => {
    const verts = parsePathD('M 0 0 L 100 0 L 100 50 L 0 50 Z');
    expect(verts).toEqual([[0, 0], [100, 0], [100, 50], [0, 50]]);
  });

  it('handles relative m/l commands', () => {
    const verts = parsePathD('m 10 10 l 5 0 l 0 5 l -5 0 z');
    expect(verts).toEqual([[10, 10], [15, 10], [15, 15], [10, 15]]);
  });

  it('handles H/V commands', () => {
    const verts = parsePathD('M 0 0 H 50 V 25 H 0 Z');
    expect(verts).toEqual([[0, 0], [50, 0], [50, 25], [0, 25]]);
  });

  it('throws on unsupported curve commands', () => {
    expect(() => parsePathD('M 0 0 C 10 10 20 20 30 30')).toThrow(/curve|unsupported/i);
  });
});

describe('applyHint', () => {
  it('symmetric-half clamps negative x to 0', () => {
    const out = applyHint(
      [[-5, 0], [10, 0], [10, 100], [-3, 100]],
      'symmetric-half',
    );
    expect(out[0][0]).toBe(0);
    expect(out[3][0]).toBe(0);
    expect(out[1][0]).toBe(10);
  });

  it('closed-path is identity (closure is encoded with Z in serialization)', () => {
    const verts: [number, number][] = [[0, 0], [10, 0], [10, 10]];
    expect(applyHint(verts, 'closed-path')).toEqual(verts);
  });

  it('open-path is identity', () => {
    const verts: [number, number][] = [[0, 0], [10, 0]];
    expect(applyHint(verts, 'open-path')).toEqual(verts);
  });

  it('tileable is identity in v0 (ghost-wrap is visual-only)', () => {
    const verts: [number, number][] = [[0, 0], [100, 0]];
    expect(applyHint(verts, 'tileable')).toEqual(verts);
  });
});

describe('sanitizeVertices', () => {
  it('removes adjacent duplicates', () => {
    const out = sanitizeVertices([[0, 0], [0, 0], [10, 0], [10, 0], [10, 10]]);
    expect(out).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it('rounds coords to 4 decimal places', () => {
    const out = sanitizeVertices([[0.123456, 0.999999]]);
    expect(out[0][0]).toBe(0.1235);
    expect(out[0][1]).toBe(1);
  });
});
