/**
 * Minimal SVG profile parser. Supports straight-line commands only:
 * M (move), L (line), H (horizontal line), V (vertical line), Z (close).
 *
 * Curves (C/Q/A) are NOT supported in v1 — the AI is instructed to emit
 * straight-line polygons. A future tessellator can add curve support without
 * changing this contract.
 *
 * Output:
 * - Coordinates rounded to 4 decimal places (deterministic across float ops).
 * - SVG Y-down flipped to engine Y-up using the viewBox height.
 * - Closed paths have the first point repeated as the last point.
 * - Symmetric-half profiles must have all points with x ≥ 0.
 */

import type { SvgPath } from './types.js';

const PRECISION = 4;
const ROUND_FACTOR = Math.pow(10, PRECISION);

function snap(n: number): number {
  return Math.round(n * ROUND_FACTOR) / ROUND_FACTOR;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function parseViewBox(svgStr: string): ViewBox {
  const m = svgStr.match(/viewBox\s*=\s*"([^"]+)"/);
  if (!m) throw new Error('parseSvgProfile: missing viewBox attribute');
  const [x, y, w, h] = m[1].trim().split(/\s+/).map(Number);
  if (![x, y, w, h].every(Number.isFinite)) {
    throw new Error('parseSvgProfile: viewBox must be "x y w h" with four numbers');
  }
  return { x, y, w, h };
}

function extractPathD(svgStr: string): string {
  const m = svgStr.match(/<path\b[^>]*\bd\s*=\s*"([^"]+)"/);
  if (!m) throw new Error('parseSvgProfile: no <path> element with d attribute found');
  return m[1];
}

/** Tokenize a path-d string into [command, [...numbers]] pairs. */
function tokenize(d: string): Array<{ cmd: string; args: number[] }> {
  const tokens: Array<{ cmd: string; args: number[] }> = [];
  const re = /([MLHVZmlhvz])\s*([^MLHVZmlhvz]*)/g;
  let match;
  while ((match = re.exec(d)) !== null) {
    const cmd = match[1];
    const argsStr = match[2].trim();
    const args = argsStr.length === 0
      ? []
      : argsStr.split(/[\s,]+/).filter(s => s.length > 0).map(Number);
    if (args.some(n => !Number.isFinite(n))) {
      throw new Error(`parseSvgProfile: non-numeric token in path: ${argsStr}`);
    }
    tokens.push({ cmd, args });
  }
  if (tokens.length === 0) throw new Error('parseSvgProfile: empty path');
  if (tokens[0].cmd !== 'M' && tokens[0].cmd !== 'm') {
    throw new Error(`parseSvgProfile: path must start with M, got ${tokens[0].cmd}`);
  }
  return tokens;
}

interface WalkResult {
  pts: Array<[number, number]>;
  closedByZ: boolean;
}

/** Walk path tokens, building (x, y) points in SVG coordinates. */
function walkPath(tokens: Array<{ cmd: string; args: number[] }>): WalkResult {
  const pts: Array<[number, number]> = [];
  let cx = 0, cy = 0;
  let startX = 0, startY = 0;
  let closedByZ = false;
  for (const { cmd, args } of tokens) {
    switch (cmd) {
      case 'M':
        if (args.length < 2) throw new Error('M: need at least 2 args');
        cx = args[0]; cy = args[1];
        startX = cx; startY = cy;
        pts.push([cx, cy]);
        for (let i = 2; i + 1 < args.length; i += 2) {
          cx = args[i]; cy = args[i + 1];
          pts.push([cx, cy]);
        }
        break;
      case 'm':
        if (args.length < 2) throw new Error('m: need at least 2 args');
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
        // Z marks the path as closed but does NOT add a duplicate point here.
        // The closed-path post-processing in parseSvgProfile handles closure.
        closedByZ = true;
        cx = startX; cy = startY;
        break;
      default:
        throw new Error(`parseSvgProfile: unsupported command ${cmd} (curves not supported in v1)`);
    }
  }
  return { pts, closedByZ };
}

export function parseSvgProfile(svgStr: string, hint: SvgPath['hint']): SvgPath {
  if (typeof svgStr !== 'string' || !svgStr.includes('<svg')) {
    throw new Error('parseSvgProfile: input must be an SVG string');
  }
  const vb = parseViewBox(svgStr);
  const d = extractPathD(svgStr);
  const tokens = tokenize(d);
  const { pts: raw, closedByZ } = walkPath(tokens);

  // SVG Y-down → engine Y-up, preserving viewBox extent.
  // Correct formula: y_engine = (2 * vb.y + vb.h) - y_svg
  //  - viewBox (0, 0, W, H):       y_engine = H - y_svg            (range [0, H])
  //  - viewBox (-W/2, -H/2, W, H): y_engine = -y_svg               (range [-H/2, H/2], centered)
  // This way symmetric viewBoxes produce symmetric output around the origin,
  // which is what cross-section profiles (loft inputs) need.
  const points: Array<readonly [number, number]> = raw.map(([x, y]) => {
    const ex = snap(x);
    const ey = snap((2 * vb.y + vb.h) - y);
    return [ex, ey] as const;
  });

  // Hint-specific validation.
  if (hint === 'symmetric-half' && points.some(([x]) => x < 0)) {
    throw new Error('parseSvgProfile: symmetric-half profile requires all points to have x >= 0');
  }
  if (hint === 'closed-path' && !closedByZ) {
    // For paths without Z, auto-append start to close the loop.
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
      if (first) points.push(first);
    }
  }

  return {
    hint,
    points,
    bbox: [vb.x, vb.y, vb.w, vb.h],
  };
}
