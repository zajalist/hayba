import { describe, it, expect } from 'vitest';
import { parseSvgProfile } from './svg-parse.js';

describe('parseSvgProfile', () => {
  it('parses a simple rectangle as a closed-path', () => {
    const svg = '<svg viewBox="0 0 100 200"><path d="M0 0 L 100 0 L 100 200 L 0 200 Z"/></svg>';
    const p = parseSvgProfile(svg, 'closed-path');
    expect(p.hint).toBe('closed-path');
    expect(p.points.length).toBeGreaterThanOrEqual(4);
    // SVG Y-down → engine Y-up: y=0 in SVG becomes y=200 in engine (assuming viewBox height 200).
    // First point M0 0 → engine (0, 200).
    expect(p.points[0][0]).toBeCloseTo(0);
    expect(p.points[0][1]).toBeCloseTo(200);
  });

  it('handles M/L/H/V/Z commands', () => {
    const svg = '<svg viewBox="0 0 10 10"><path d="M1 1 L 5 1 H 9 V 9 L 1 9 Z"/></svg>';
    const p = parseSvgProfile(svg, 'closed-path');
    expect(p.points.length).toBe(5);   // M, L, H (line-to 9 1), V (line-to 9 9), L, then Z closes
  });

  it('rejects symmetric-half profile with negative x', () => {
    const svg = '<svg viewBox="-10 0 20 100"><path d="M-5 0 L 5 0 L 5 100 L -5 100 Z"/></svg>';
    expect(() => parseSvgProfile(svg, 'symmetric-half')).toThrow(/symmetric-half/);
  });

  it('accepts symmetric-half profile with x >= 0', () => {
    const svg = '<svg viewBox="0 0 100 1000"><path d="M0 0 L 50 0 L 50 1000 L 0 1000 Z"/></svg>';
    const p = parseSvgProfile(svg, 'symmetric-half');
    expect(p.points.every(([x]) => x >= 0)).toBe(true);
  });

  it('rejects missing path element', () => {
    const svg = '<svg viewBox="0 0 100 100"></svg>';
    expect(() => parseSvgProfile(svg, 'closed-path')).toThrow(/path/);
  });

  it('rejects malformed SVG', () => {
    expect(() => parseSvgProfile('not svg', 'closed-path')).toThrow();
  });

  it('produces deterministic output for the same input', () => {
    const svg = '<svg viewBox="0 0 100 100"><path d="M0 0 L 100 0 L 100 100 L 0 100 Z"/></svg>';
    const a = parseSvgProfile(svg, 'closed-path');
    const b = parseSvgProfile(svg, 'closed-path');
    expect(a.points).toEqual(b.points);
  });

  it('snaps coordinates to 4-decimal precision', () => {
    const svg = '<svg viewBox="0 0 100 100"><path d="M0.123456789 0 L 100 0 Z"/></svg>';
    const p = parseSvgProfile(svg, 'closed-path');
    expect(p.points[0][0]).toBe(0.1235);   // rounded to 4 dp
  });
});
