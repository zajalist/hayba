import { describe, it, expect } from 'vitest';
import { canvasToSvgSpace, svgToCanvasSpace, snap, fitViewBox } from './coord-map.js';

describe('canvasToSvgSpace + svgToCanvasSpace', () => {
  const view = { canvasSize: { w: 800, h: 600 }, viewBox: [0, 0, 100, 100] as [number, number, number, number] };

  it('canvas (top-left of viewBox area) maps to svg y=top-of-viewBox after fit-to-canvas', () => {
    // For viewBox 0 0 100 100 fit into 800x600 canvas (uniform scale 6, centered),
    // the viewBox region in canvas px is roughly (100, 0) to (700, 600).
    // Top-left of that region should map to (sx=0, sy=100) in SVG-space.
    const m = fitViewBox(view.canvasSize, view.viewBox);
    const r = canvasToSvgSpace({ px: m.offsetX, py: m.offsetY }, view);
    expect(r.sx).toBeCloseTo(0);
    expect(r.sy).toBeCloseTo(100);
  });

  it('round-trip: svgToCanvasSpace(canvasToSvgSpace(p)) ≈ p', () => {
    for (const [px, py] of [[100, 100], [400, 300], [750, 50]]) {
      const sv = canvasToSvgSpace({ px, py }, view);
      const back = svgToCanvasSpace(sv, view);
      expect(back.px).toBeCloseTo(px);
      expect(back.py).toBeCloseTo(py);
    }
  });

  it('handles centered viewBox (-50 -50 100 100) — origin at center', () => {
    const centered = { canvasSize: { w: 800, h: 600 }, viewBox: [-50, -50, 100, 100] as [number, number, number, number] };
    // Canvas center should map to (0, 0) in SVG space.
    const r = canvasToSvgSpace({ px: 400, py: 300 }, centered);
    expect(r.sx).toBeCloseTo(0);
    expect(r.sy).toBeCloseTo(0);
  });
});

describe('snap', () => {
  it('snaps to nearest grid point', () => {
    expect(snap(7.3, 5)).toBe(5);
    expect(snap(7.6, 5)).toBe(10);
    expect(snap(-2.4, 5)).toBe(0);
  });

  it('snap=0 is identity', () => {
    expect(snap(7.3, 0)).toBe(7.3);
  });

  it('handles negative values symmetrically', () => {
    expect(snap(-7.6, 5)).toBe(-10);
  });
});

describe('fitViewBox', () => {
  it('returns a view-matrix that fits a viewBox into a canvas, preserving aspect', () => {
    const m = fitViewBox(
      { w: 800, h: 600 },
      [0, 0, 100, 100],
    );
    // 100x100 viewBox into 800x600 canvas — height is the limiting axis,
    // scale = 600/100 = 6.
    expect(m.scale).toBeCloseTo(6);
    // The viewBox content is centered in the canvas.
    expect(m.offsetX).toBeCloseTo((800 - 100 * 6) / 2);
    expect(m.offsetY).toBeCloseTo((600 - 100 * 6) / 2);
  });
});
