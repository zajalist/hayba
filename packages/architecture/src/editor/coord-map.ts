/**
 * Editor coordinate-space math. The editor operates in three spaces:
 *
 * - **canvas px** — what Paper.js / mouse events see. Y-down, origin top-left.
 * - **SVG-space (mm)** — viewBox coordinates. Y-up in the editor's mental model
 *   (matches the engine).
 * - **viewBox bounds** — `[vbX, vbY, vbW, vbH]`. The valid editing region.
 *
 * The canvas Y-flip happens here: a canvas point at py=offsetY (top of fitted
 * region) maps to SVG y=vbY+vbH; a canvas point at py=offsetY+vbH*scale (bottom)
 * maps to SVG y=vbY.
 */

export interface ViewState {
  canvasSize: { w: number; h: number };
  viewBox: readonly [number, number, number, number];   // [x, y, w, h]
}

export interface CanvasPt { px: number; py: number; }
export interface SvgPt    { sx: number; sy: number; }

export function canvasToSvgSpace(pt: CanvasPt, view: ViewState): SvgPt {
  const [vbX, vbY, vbW, vbH] = view.viewBox;
  const m = fitViewBox(view.canvasSize, view.viewBox);
  const sx = (pt.px - m.offsetX) / m.scale + vbX;
  const sy = (vbY + vbH) - (pt.py - m.offsetY) / m.scale;
  return { sx, sy };
}

export function svgToCanvasSpace(pt: SvgPt, view: ViewState): CanvasPt {
  const [vbX, vbY, vbW, vbH] = view.viewBox;
  const m = fitViewBox(view.canvasSize, view.viewBox);
  const px = m.offsetX + (pt.sx - vbX) * m.scale;
  const py = m.offsetY + ((vbY + vbH) - pt.sy) * m.scale;
  return { px, py };
}

/**
 * Compute a uniform scale + offset that fits the viewBox into the canvas
 * with the viewBox centered. Limiting axis is whichever produces the
 * smaller scale (so the whole viewBox fits).
 */
export function fitViewBox(
  canvasSize: { w: number; h: number },
  viewBox: readonly [number, number, number, number],
): { scale: number; offsetX: number; offsetY: number } {
  const [, , vbW, vbH] = viewBox;
  const scaleX = canvasSize.w / vbW;
  const scaleY = canvasSize.h / vbH;
  const scale = Math.min(scaleX, scaleY);
  const offsetX = (canvasSize.w - vbW * scale) / 2;
  const offsetY = (canvasSize.h - vbH * scale) / 2;
  return { scale, offsetX, offsetY };
}

/**
 * Snap a 1D coordinate to the nearest multiple of `grid`. If `grid <= 0`,
 * returns the input unchanged.
 */
export function snap(value: number, grid: number): number {
  if (grid <= 0) return value;
  return (Math.round(value / grid) * grid) || 0;
}
