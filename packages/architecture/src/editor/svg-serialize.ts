/**
 * Pure utilities for the SVG editor. Convert between Paper.js-friendly vertex
 * arrays and the SVG strings the kernel consumes.
 *
 * Coordinate convention: vertex arrays use SVG-space (the viewBox's coordinate
 * system, in mm). Y values are pre-flip — kernel/svg-parse.ts handles the
 * Y-flip to engine Y-up at parse time. Saving a binding emits an SVG with the
 * same conventions so round-trip is lossless.
 */

import type { ProfileHint } from '../schema.js';

export type Vec2 = readonly [number, number];

const PRECISION = 4;
const ROUND_FACTOR = Math.pow(10, PRECISION);
function snap(n: number): number {
  return Math.round(n * ROUND_FACTOR) / ROUND_FACTOR;
}

/**
 * Serialize a vertex list as a `<svg viewBox="..."><path d="..."/></svg>`
 * string suitable for storing in an ElementBinding.profiles slot.
 */
export function verticesToSvgPath(
  vertices: readonly Vec2[],
  viewBox: readonly [number, number, number, number],
  hint: ProfileHint,
): string {
  if (vertices.length === 0) {
    throw new Error('verticesToSvgPath: at least one vertex required');
  }
  const clean = sanitizeVertices(applyHint(vertices, hint));
  const parts: string[] = [];
  for (let i = 0; i < clean.length; i++) {
    const [x, y] = clean[i];
    parts.push(`${i === 0 ? 'M' : 'L'} ${x} ${y}`);
  }
  const isClosed = hint === 'closed-path';
  if (isClosed) parts.push('Z');
  const [vx, vy, vw, vh] = viewBox;
  const d = parts.join(' ');
  return `<svg viewBox="${vx} ${vy} ${vw} ${vh}"><path d="${d}"/></svg>`;
}

/**
 * Parse a path d-string into a flat list of (x, y) vertices. Supports
 * M/L/H/V/Z (and lowercase relatives). Curve commands throw — they're not
 * supported in v0 of the kernel or the editor.
 */
export function parsePathD(d: string): Vec2[] {
  // Reject curve letters early (defensive — these aren't in the editor's vocab).
  if (/[CcQqAaSsTt]/.test(d)) {
    throw new Error(`parsePathD: unsupported curve command in path (C/Q/A not allowed in v0)`);
  }

  const tokens: Array<{ cmd: string; args: number[] }> = [];
  const re = /([MLHVZmlhvz])\s*([^MLHVZmlhvz]*)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1];
    const argsStr = m[2].trim();
    const args = argsStr.length === 0
      ? []
      : argsStr.split(/[\s,]+/).filter(s => s.length > 0).map(Number);
    if (args.some(n => !Number.isFinite(n))) {
      throw new Error(`parsePathD: non-numeric arg in path: ${argsStr}`);
    }
    tokens.push({ cmd, args });
  }
  if (tokens.length === 0) throw new Error('parsePathD: empty path');

  const pts: Vec2[] = [];
  let cx = 0, cy = 0;
  let startX = 0, startY = 0;

  for (const { cmd, args } of tokens) {
    switch (cmd) {
      case 'M':
        cx = args[0]; cy = args[1];
        startX = cx; startY = cy;
        pts.push([cx, cy]);
        for (let i = 2; i + 1 < args.length; i += 2) {
          cx = args[i]; cy = args[i + 1];
          pts.push([cx, cy]);
        }
        break;
      case 'm':
        cx += args[0]; cy += args[1];
        startX = cx; startY = cy;
        pts.push([cx, cy]);
        for (let i = 2; i + 1 < args.length; i += 2) {
          cx += args[i]; cy += args[i + 1];
          pts.push([cx, cy]);
        }
        break;
      case 'L':
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx = args[i]; cy = args[i + 1];
          pts.push([cx, cy]);
        }
        break;
      case 'l':
        for (let i = 0; i + 1 < args.length; i += 2) {
          cx += args[i]; cy += args[i + 1];
          pts.push([cx, cy]);
        }
        break;
      case 'H':
        for (const n of args) { cx = n; pts.push([cx, cy]); }
        break;
      case 'h':
        for (const n of args) { cx += n; pts.push([cx, cy]); }
        break;
      case 'V':
        for (const n of args) { cy = n; pts.push([cx, cy]); }
        break;
      case 'v':
        for (const n of args) { cy += n; pts.push([cx, cy]); }
        break;
      case 'Z':
      case 'z':
        cx = startX; cy = startY;
        break;
    }
  }
  return pts;
}

/**
 * Apply hint-specific enforcement to a vertex list. For symmetric-half,
 * negative x values clamp to 0. Other hints are identity in v0
 * (closed-path closure is handled by Z in serialization; tileable wrap
 * is visual-only).
 */
export function applyHint(vertices: readonly Vec2[], hint: ProfileHint): Vec2[] {
  if (hint === 'symmetric-half') {
    return vertices.map(([x, y]): Vec2 => [Math.max(0, x), y]);
  }
  return vertices.map(([x, y]): Vec2 => [x, y]);
}

/**
 * Round to PRECISION digits and drop adjacent duplicates. Idempotent.
 */
export function sanitizeVertices(vertices: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  let prevX = NaN, prevY = NaN;
  for (const [x, y] of vertices) {
    const rx = snap(x);
    const ry = snap(y);
    if (rx === prevX && ry === prevY) continue;
    out.push([rx, ry]);
    prevX = rx; prevY = ry;
  }
  return out;
}
