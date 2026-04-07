export interface BrushOptions {
  radius: number;       // pixels
  strength: number;     // 0–1
  falloff: number;      // 0–1, Gaussian falloff factor
}

/**
 * Paint a single brush stroke onto an offscreen canvas context.
 * Paints white (255) with Gaussian falloff.
 */
export function paintStroke(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  opts: BrushOptions,
): void {
  const { radius, strength, falloff } = opts;
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  const sigma = radius * (1 - falloff * 0.8);
  // Gaussian-like falloff via radial gradient stops
  gradient.addColorStop(0, `rgba(255,255,255,${strength})`);
  gradient.addColorStop(Math.min(0.5, sigma / radius), `rgba(255,255,255,${strength * 0.5})`);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Erase a circular area (paint black).
 */
export function eraseStroke(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  opts: BrushOptions,
): void {
  ctx.globalCompositeOperation = 'destination-out';
  paintStroke(ctx, x, y, { ...opts, strength: 1 });
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Export an offscreen canvas as a base64 PNG string.
 */
export function canvasToBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png').split(',')[1];
}

/**
 * Create an offscreen canvas for a zone layer (grayscale mask).
 */
export function createMaskCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}
