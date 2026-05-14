# Architecture SVG Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a node-based SVG vertex editor to the architecture atlas as a third tab ("Editor"), driven by Paper.js, that hand-edits any profile slot of any committed `ElementBinding` with live 3D preview and explicit save through Phase 1's persistence endpoint.

**Architecture:** Pure-function utilities (vertices ↔ SVG, coordinate mapping, hint enforcement, snap-to-grid) live in `packages/architecture/src/editor/` and are unit-tested in vitest. Paper.js wiring + tab UI live in `packages/architecture/demo/editor.js` + `index.html` and are smoke-tested manually. All edits flow through the existing kernel (`registerBinding` → `emitElementMesh`) and Phase 1's POST endpoint — no new MCP tools, no new kernel surface.

**Tech Stack:** TypeScript 5.6+, Paper.js 0.12+ (loaded from CDN via importmap), Vitest, three.js (existing). Architecture package = `@hayba/architecture`.

**Spec:** `docs/superpowers/specs/2026-05-13-architecture-svg-editor-design.md`
**Branch:** `feat/architecture-pillar`
**HEAD at start:** the Phase 1 binding-persistence final commit (currently `2512e67`).

---

## File Structure

```
packages/architecture/
├── src/
│   ├── editor/                                     [Tasks 1–3]   NEW
│   │   ├── svg-serialize.ts                        [Task 2]      verticesToSvgPath + applyHint + parsePathD
│   │   ├── svg-serialize.test.ts                   [Task 2]
│   │   ├── coord-map.ts                            [Task 3]      canvasToSvgSpace, svgToCanvasSpace, snap
│   │   └── coord-map.test.ts                       [Task 3]
│   └── index.ts                                    [Task 4]      add editor re-exports
└── demo/
    ├── editor.js                                   [Tasks 5–11]  NEW — Paper.js + tools + live preview + save
    └── index.html                                  [Tasks 6, 12] tab + ✎ edit buttons + CSS
```

The pure functions in `src/editor/` are vitest-testable (DOM-free). The browser module `demo/editor.js` imports them via the built `dist/index.js`.

---

### Task 1: Scaffold src/editor/ + verify branch

**Files:**
- Create: `packages/architecture/src/editor/` (directory)

- [ ] **Step 1: Verify branch**

```bash
cd D:/Hackathons/hayba && git branch --show-current
```
Expected: `feat/architecture-pillar`. If wrong, `git checkout feat/architecture-pillar`. STOP with BLOCKED if uncommitted changes prevent the switch.

- [ ] **Step 2: Create the directory marker**

`packages/architecture/src/editor/.gitkeep` — empty file so git tracks the directory before any code lands.

```bash
mkdir -p packages/architecture/src/editor
touch packages/architecture/src/editor/.gitkeep
git add packages/architecture/src/editor/.gitkeep
git commit -m "chore(architecture): scaffold src/editor/ directory"
```

(That's a single tiny commit; subsequent tasks add real files and we can delete the `.gitkeep` once the directory has content.)

---

### Task 2: svg-serialize.ts — vertices ↔ SVG path string + hint enforcement

**Files:**
- Create: `packages/architecture/src/editor/svg-serialize.ts`
- Create: `packages/architecture/src/editor/svg-serialize.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/architecture/src/editor/svg-serialize.test.ts`:
```ts
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
    // Engine SVG-space y values (post Y-flip would be applied at parse time).
    // svg-serialize takes engine-space y values; parseSvgProfile produces them too.
    const verts = [[0, 0], [100, 0], [100, 50], [0, 50]];
    const svg = verticesToSvgPath(verts, [0, 0, 100, 50], 'closed-path');
    const parsed = parseSvgProfile(svg, 'closed-path');
    // parseSvgProfile flips Y based on viewBox — we expect symmetric round-trip
    // when the input verts are already in svg-coords matching viewBox-y at top.
    expect(parsed.points.length).toBeGreaterThanOrEqual(4);
  });

  it('rounds coords to 4 decimal places for determinism', () => {
    const svg = verticesToSvgPath(
      [[0.123456789, 1.2345678], [100, 100]],
      [0, 0, 100, 100],
      'open-path',
    );
    expect(svg).toContain('0.1235');   // 4 dp
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

  it('closed-path is identity (closure is encoded in serialization with Z)', () => {
    const verts = [[0, 0], [10, 0], [10, 10]];
    expect(applyHint(verts, 'closed-path')).toEqual(verts);
  });

  it('open-path is identity', () => {
    const verts = [[0, 0], [10, 0]];
    expect(applyHint(verts, 'open-path')).toEqual(verts);
  });

  it('tileable is identity in v0 (ghost-wrap is visual-only)', () => {
    const verts = [[0, 0], [100, 0]];
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
```

- [ ] **Step 2: Run tests → FAIL**

```bash
npm test --workspace=@hayba/architecture -- svg-serialize.test
```
Expected: module-not-found failure.

- [ ] **Step 3: Implement svg-serialize.ts**

`packages/architecture/src/editor/svg-serialize.ts`:
```ts
/**
 * Pure utilities for the SVG editor. Convert between Paper.js-friendly vertex
 * arrays and the SVG strings the kernel consumes.
 *
 * Coordinate convention: vertex arrays use SVG-space (the viewBox's coordinate
 * system, in mm). Y values are pre-flip — kernel/svg-parse.ts handles the Y-flip
 * to engine Y-up at parse time. Saving a binding emits an SVG with the same
 * conventions so round-trip is lossless.
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
  const tokens: Array<{ cmd: string; args: number[] }> = [];
  const re = /([MLHVZmlhvz])\s*([^MLHVZmlhvz]*)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1];
    const argsStr = m[2].trim();
    const args = argsStr.length === 0 ? [] : argsStr.split(/[\s,]+/).filter(s => s.length > 0).map(Number);
    if (args.some(n => !Number.isFinite(n))) {
      throw new Error(`parsePathD: non-numeric arg in path: ${argsStr}`);
    }
    tokens.push({ cmd, args });
  }
  if (tokens.length === 0) throw new Error('parsePathD: empty path');

  // Reject unsupported commands.
  for (const t of tokens) {
    if (!'MLHVZmlhvz'.includes(t.cmd)) {
      throw new Error(`parsePathD: unsupported curve command ${t.cmd}`);
    }
  }
  // Detect actual curve letters in case the regex was extended (defensive):
  if (/[CcQqAaSsTt]/.test(d)) {
    throw new Error(`parsePathD: unsupported curve command in path (C/Q/A not allowed in v0)`);
  }

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
```

- [ ] **Step 4: Run tests → PASS**

Expected: ~15 tests pass for svg-serialize.test.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/editor/svg-serialize.ts packages/architecture/src/editor/svg-serialize.test.ts
git diff --cached --name-only
git commit -m "feat(architecture): editor — svg-serialize (vertices ⇄ SVG path string + hint enforcement)"
```

---

### Task 3: coord-map.ts — canvas ⇄ SVG-space mapping + snap

**Files:**
- Create: `packages/architecture/src/editor/coord-map.ts`
- Create: `packages/architecture/src/editor/coord-map.test.ts`

- [ ] **Step 1: Write failing tests**

`packages/architecture/src/editor/coord-map.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { canvasToSvgSpace, svgToCanvasSpace, snap, fitViewBox } from './coord-map.js';

describe('canvasToSvgSpace + svgToCanvasSpace', () => {
  const view = { canvasSize: { w: 800, h: 600 }, viewBox: [0, 0, 100, 100] as [number, number, number, number] };

  it('canvas (0, 0) maps to svg (0, 100) — top-left of canvas is top-left of viewBox; y flipped', () => {
    // For viewBox 0 0 100 100 with engine Y-up convention, the canvas top-left
    // should map to viewBox bottom (y=100) — because the editor SHOWS the
    // viewBox the same way engineers think about it (positive Y = up).
    const r = canvasToSvgSpace({ px: 0, py: 0 }, view);
    expect(r.sx).toBeCloseTo(0);
    expect(r.sy).toBeCloseTo(100);
  });

  it('canvas (canvas-w, canvas-h) maps to svg (viewBox-w, 0) — bottom-right', () => {
    const r = canvasToSvgSpace({ px: view.canvasSize.w, py: view.canvasSize.h }, view);
    expect(r.sx).toBeCloseTo(100);
    expect(r.sy).toBeCloseTo(0);
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
    // 100x100 viewBox fits into 800x600 canvas — height is the limiting axis
    // (canvas aspect 4:3, viewBox 1:1). Scale should be 600/100 = 6.
    expect(m.scale).toBeCloseTo(6);
    // Center of viewBox (50, 50) lands at center of canvas (400, 300).
    expect(m.offsetX).toBeCloseTo(400 - 50 * 6);
    expect(m.offsetY).toBeCloseTo(300 - 50 * 6);   // offset is independent of Y-flip
  });
});
```

- [ ] **Step 2: Run tests → FAIL**

```bash
npm test --workspace=@hayba/architecture -- coord-map.test
```

- [ ] **Step 3: Implement coord-map.ts**

`packages/architecture/src/editor/coord-map.ts`:
```ts
/**
 * Editor coordinate-space math. The editor operates in three spaces:
 *
 * - **canvas px** — what Paper.js / mouse events see. Y-down, origin top-left.
 * - **SVG-space (mm)** — viewBox coordinates. Conventionally y-up in the editor's
 *   mental model (we show the viewBox the same way an architect would draw,
 *   with +y going up the page). This matches the engine.
 * - **viewBox bounds** — `[vbX, vbY, vbW, vbH]`. The valid editing region.
 *
 * The canvas Y-flip happens here: a canvas point at py=0 maps to SVG y=vbY+vbH
 * (top of viewBox), and py=canvasH maps to SVG y=vbY (bottom).
 */

export interface ViewState {
  canvasSize: { w: number; h: number };
  viewBox: readonly [number, number, number, number];   // [x, y, w, h]
}

export interface CanvasPt { px: number; py: number; }
export interface SvgPt    { sx: number; sy: number; }

/**
 * Convert a point in canvas pixels to SVG-space (viewBox coordinates),
 * preserving aspect by fit-to-canvas.
 */
export function canvasToSvgSpace(pt: CanvasPt, view: ViewState): SvgPt {
  const [vbX, vbY, vbW, vbH] = view.viewBox;
  const m = fitViewBox(view.canvasSize, view.viewBox);
  // Inverse of: px = offsetX + (sx - vbX) * scale
  const sx = (pt.px - m.offsetX) / m.scale + vbX;
  // Inverse of Y-flipped: py = offsetYTop + (vbTop - sy) * scale, where vbTop = vbY+vbH
  const sy = (vbY + vbH) - (pt.py - m.offsetY) / m.scale;
  return { sx, sy };
}

/**
 * Inverse of canvasToSvgSpace.
 */
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
  // Center the viewBox in the canvas (each side gets equal padding on the
  // axis that isn't the limiting one).
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
  return Math.round(value / grid) * grid;
}
```

- [ ] **Step 4: Run tests → PASS**

Expected: ~9 tests pass for coord-map.test.

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/editor/coord-map.ts packages/architecture/src/editor/coord-map.test.ts
git diff --cached --name-only
git commit -m "feat(architecture): editor — coord-map (canvas px ⇄ SVG-space, fit-to-viewBox, snap)"
```

---

### Task 4: Re-export editor utilities from index.ts; clean up .gitkeep

**Files:**
- Modify: `packages/architecture/src/index.ts`
- Delete: `packages/architecture/src/editor/.gitkeep` (no longer needed)

- [ ] **Step 1: Append editor exports to index.ts**

APPEND to `packages/architecture/src/index.ts`:
```ts
// SVG editor utilities (pure, browser-safe)
export type { Vec2 } from './editor/svg-serialize.js';
export {
  verticesToSvgPath, parsePathD, applyHint, sanitizeVertices,
} from './editor/svg-serialize.js';
export type { ViewState, CanvasPt, SvgPt } from './editor/coord-map.js';
export {
  canvasToSvgSpace, svgToCanvasSpace, fitViewBox, snap,
} from './editor/coord-map.js';
```

- [ ] **Step 2: Remove the now-redundant .gitkeep**

```bash
git rm packages/architecture/src/editor/.gitkeep
```

- [ ] **Step 3: Build + typecheck**

```bash
npm run build --workspace=@hayba/architecture
npm run typecheck --workspace=@hayba/architecture
```
Both should be silent (clean).

- [ ] **Step 4: Run all architecture tests to confirm no regressions**

```bash
npm test --workspace=@hayba/architecture
```
Expected: all tests still pass (was 156; new editor tests add ~24, bringing total to ~180).

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/src/index.ts packages/architecture/src/editor/.gitkeep
git diff --cached --name-only
git commit -m "feat(architecture): re-export editor utilities; drop .gitkeep"
```

---

### Task 5: demo/editor.js skeleton — module structure + Paper.js init

**Files:**
- Create: `packages/architecture/demo/editor.js`

This task only creates the module shell; tasks 6+ wire it into the HTML, and tasks 7–11 fill in the behavior.

- [ ] **Step 1: Create the editor.js module**

`packages/architecture/demo/editor.js`:
```js
/**
 * Hayba Architecture Atlas — SVG vertex editor (browser module).
 *
 * Public API (called by index.html):
 *   - openEditor(bindingKey: string): void
 *   - closeEditor(): void  -- internal cleanup (called on tab switch)
 *   - hasUnsavedChanges(): boolean
 *   - editorOpenSlot(slotName: string): void
 *
 * State lives in this module's `state` object (separate from the atlas-wide state).
 * Paper.js is loaded via importmap; we get it as a default import inside init().
 */

import * as paper from 'paper';
import {
  verticesToSvgPath, parsePathD, applyHint, sanitizeVertices,
  canvasToSvgSpace, svgToCanvasSpace, fitViewBox, snap,
  loadElementCatalog, registerBinding, emitElementMesh,
} from '../dist/index.js';

const PRECISION = 4;

/* ─── module-local state ──────────────────────────────────────────────── */

const state = {
  active: false,
  bindingKey: null,           // 'medieval-european-gothic::column' or null
  binding: null,              // full ElementBinding object (with bigint seed)
  element: null,              // Element definition (profileSlots, paramSchema)
  activeSlot: null,           // 'shaft' | 'base' | ...
  slots: {},                  // { [slotName]: SlotState }
  tool: 'select',             // 'select' | 'pen' | 'pan' | 'zoom'
  snapGrid: 5,                // mm
  paperScope: null,           // paper.PaperScope when active, null otherwise
  view: null,                 // ViewState (set per active slot from element.profileSlots[i].bbox)
  // Save / dirty tracking
  saveCallback: null,         // function called with the updated binding when save fires
};

/* ─── SlotState shape (per profile slot) ──────────────────────────────── */
/*
  {
    slotName: string,
    hint: ProfileHint,
    viewBox: [x, y, w, h],
    path: paper.Path,         // editable path
    dirty: boolean,
    originalSvg: string,
  }
*/

/* ─── public API ─────────────────────────────────────────────────────── */

export function openEditor(bindingKey, opts) {
  // Implemented in Task 7 — load binding + initialize slots.
  console.warn('openEditor: not yet implemented (Task 7)');
  state.bindingKey = bindingKey;
  state.saveCallback = opts?.onSave ?? null;
  state.active = true;
}

export function closeEditor() {
  // Implemented in Task 7 — dispose Paper.js + clear state.
  state.active = false;
  state.bindingKey = null;
  state.binding = null;
  state.element = null;
  state.activeSlot = null;
  state.slots = {};
}

export function hasUnsavedChanges() {
  return Object.values(state.slots).some(s => s.dirty);
}

export function editorOpenSlot(slotName) {
  // Implemented in Task 7.
  state.activeSlot = slotName;
}

/* ─── internal helpers (filled in later tasks) ───────────────────────── */
// (intentionally empty for now)
```

- [ ] **Step 2: Commit**

```bash
git add packages/architecture/demo/editor.js
git diff --cached --name-only
git commit -m "feat(architecture): editor.js skeleton (public API + state shape)"
```

---

### Task 6: Editor tab + ✎ edit button in HTML/CSS

**Files:**
- Modify: `packages/architecture/demo/index.html`

- [ ] **Step 1: Add Paper.js to the importmap**

Find the existing `<script type="importmap">` block in `demo/index.html`. Update its `imports` object to include paper:

```html
<script type="importmap">
{
  "imports": {
    "three": "https://unpkg.com/three@0.169.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.169.0/examples/jsm/",
    "paper": "https://unpkg.com/paper@0.12.18/dist/paper-core.js"
  }
}
</script>
```

(`paper-core.js` is the headless variant — smaller, no DOM helpers we don't need.)

- [ ] **Step 2: Add the Editor tab to the toolbar**

Find the existing tabs container:
```html
<div class="tabs" id="tabs">
  <button class="tab active" data-view="guides">Style guides</button>
  <button class="tab" data-view="typologies">Typologies</button>
</div>
```

Add a third tab:
```html
<div class="tabs" id="tabs">
  <button class="tab active" data-view="guides">Style guides</button>
  <button class="tab" data-view="typologies">Typologies</button>
  <button class="tab" data-view="editor">Editor</button>
</div>
```

- [ ] **Step 3: Add the Editor view container to the app**

Find the `<div class="app" id="app">` block. After the existing left/center/right panes, but inside the app div, add the editor view (initially hidden):

```html
<div class="editor-view" id="editorView" style="display:none;">
  <div class="editor-topbar">
    <div class="editor-crumb">
      <span class="editor-crumb-prefix muted">Editing /</span>
      <span class="editor-crumb-name" id="editorBindingName">— no binding loaded —</span>
    </div>
    <div class="editor-slot-tabs" id="editorSlotTabs"></div>
    <button class="editor-save-btn" id="editorSaveBtn" disabled>SAVE</button>
  </div>
  <div class="editor-body">
    <div class="editor-canvas-wrap">
      <div class="editor-toolpalette">
        <button class="editor-tool-btn active" data-tool="select" title="Select (V)">↖</button>
        <button class="editor-tool-btn" data-tool="pen" title="Pen (P) — add vertex">✎</button>
        <button class="editor-tool-btn" data-tool="pan" title="Pan (space)">✋</button>
        <button class="editor-tool-btn" data-tool="zoom" title="Zoom (scroll)">⊕</button>
        <button class="editor-tool-btn" id="editorSnapBtn" data-tool="snap" title="Snap to grid (5mm)">⊞</button>
      </div>
      <canvas id="editorCanvas" resize="true"></canvas>
      <div class="editor-statusbar" id="editorStatus">grid 5mm · 0 vertices</div>
    </div>
    <div class="editor-preview">
      <div class="editor-preview-h">Live preview</div>
      <div class="editor-preview-stage" id="editorPreviewStage"></div>
      <div class="editor-preview-stats mono muted" id="editorPreviewStats">—</div>
      <div class="editor-preview-meta" id="editorPreviewMeta">—</div>
    </div>
  </div>
</div>
```

The `.app` grid will need a `:has(.editor-view:not([style*="none"]))` or a JS-side class to flip layout. Simpler: when the Editor tab is active, JS hides the three existing panes and shows `editorView`. We handle that in Task 12.

- [ ] **Step 4: Add CSS for the editor view**

Just before the closing `</style>` tag, INSERT:

```css
  /* —— Editor view —— */
  .editor-view {
    grid-column: 1 / -1;
    display: grid;
    grid-template-rows: 44px 1fr;
    overflow: hidden;
    background: var(--bg-deep);
  }
  .editor-topbar {
    background: var(--bg-base);
    border-bottom: 1px solid var(--border-mid);
    padding: 0 18px;
    display: flex; align-items: center; gap: 16px;
  }
  .editor-crumb { display: flex; align-items: center; gap: 8px; }
  .editor-crumb-prefix { font-size: 11px; }
  .editor-crumb-name { font-weight: 600; font-size: 13px; }
  .editor-slot-tabs { display: flex; flex: 1; gap: 0; align-self: flex-end; }
  .editor-slot-tab {
    padding: 8px 14px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    font: 12px var(--font-ui);
    cursor: pointer;
    transition: color .12s, border-color .12s;
  }
  .editor-slot-tab:hover { color: var(--text-primary); }
  .editor-slot-tab.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }
  .editor-slot-tab .dirty-dot {
    display: inline-block;
    width: 6px; height: 6px;
    background: var(--accent);
    border-radius: 50%;
    margin-left: 4px;
    vertical-align: middle;
  }
  .editor-save-btn {
    background: var(--bg-elevated);
    color: var(--text-muted);
    border: 1px solid var(--border-soft);
    padding: 6px 18px;
    font: 700 11px var(--font-ui);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    cursor: not-allowed;
    border-radius: 3px;
    transition: background .12s, color .12s;
  }
  .editor-save-btn:not(:disabled) {
    background: var(--accent);
    color: #0e1219;
    cursor: pointer;
    border-color: var(--accent);
  }
  .editor-save-btn:not(:disabled):hover { background: var(--accent-hover); }

  .editor-body {
    display: grid;
    grid-template-columns: 1fr 280px;
    gap: 0;
    overflow: hidden;
  }
  .editor-canvas-wrap {
    background: var(--bg-deep);
    position: relative;
    overflow: hidden;
  }
  .editor-canvas-wrap canvas {
    width: 100%; height: 100%;
    display: block;
    background: var(--bg-deep);
    cursor: crosshair;
  }
  .editor-toolpalette {
    position: absolute;
    top: 10px; left: 10px;
    display: flex; flex-direction: column; gap: 4px;
    background: rgba(34, 38, 46, 0.92);
    padding: 4px; border-radius: 4px;
    border: 1px solid var(--border-soft);
    backdrop-filter: blur(8px);
    z-index: 5;
  }
  .editor-tool-btn {
    width: 30px; height: 30px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 14px;
    border-radius: 3px;
    transition: background .12s, color .12s, border-color .12s;
  }
  .editor-tool-btn:hover { background: var(--bg-panel); color: var(--text-primary); }
  .editor-tool-btn.active {
    background: var(--accent-dim);
    color: var(--accent);
    border-color: var(--accent);
  }
  .editor-statusbar {
    position: absolute;
    bottom: 8px; left: 12px;
    font: 11px var(--font-mono);
    color: var(--text-muted);
    background: rgba(27, 30, 36, 0.7);
    padding: 4px 8px; border-radius: 3px;
    pointer-events: none;
    z-index: 5;
  }
  .editor-preview {
    background: var(--bg-base);
    border-left: 1px solid var(--border-mid);
    padding: 14px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .editor-preview-h {
    font: 700 10px var(--font-ui);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .editor-preview-stage {
    height: 240px;
    background: var(--bg-deep);
    border: 1px solid var(--border-mid);
    border-radius: 3px;
  }
  .editor-preview-stats { font-size: 10.5px; }
  .editor-preview-meta {
    font-size: 11px; color: var(--text-secondary); line-height: 1.6;
  }

  /* —— ✎ edit button on bound-element cards —— */
  .bec-edit {
    align-self: flex-start; margin-top: 4px; margin-left: 6px;
    background: transparent;
    border: 1px solid var(--border-soft);
    color: var(--text-secondary);
    padding: 3px 8px;
    border-radius: 3px;
    font: 10.5px var(--font-ui);
    cursor: pointer;
    transition: background .12s, color .12s, border-color .12s;
  }
  .bec-edit:hover { background: var(--bg-elevated); color: var(--text-primary); border-color: var(--accent); }
```

- [ ] **Step 5: Commit**

```bash
git add packages/architecture/demo/index.html
git diff --cached --name-only
git commit -m "feat(architecture): atlas — Editor tab + view container + toolpalette CSS"
```

---

### Task 7: editor.js — load binding + initialize slots + render slot tabs

**Files:**
- Modify: `packages/architecture/demo/editor.js`

This is the meatiest task. We replace the stub `openEditor` with real logic that loads the binding, parses each slot's SVG into vertex arrays, builds Paper.js paths, and renders slot tabs.

- [ ] **Step 1: Replace editor.js with the full Task 7 version**

REPLACE the contents of `packages/architecture/demo/editor.js` with:

```js
/**
 * Hayba Architecture Atlas — SVG vertex editor (browser module).
 *
 * Public API (called by index.html):
 *   - openEditor(bindingKey, opts): void
 *   - closeEditor(): void
 *   - hasUnsavedChanges(): boolean
 *   - editorOpenSlot(slotName): void
 *   - editorSelectTool(toolName): void
 *   - editorToggleSnap(): void
 *   - editorSave(): Promise<void>
 *   - editorRefresh(): void   -- redraw status, slot tabs, preview after state changes
 */

import * as paper from 'paper';
import {
  verticesToSvgPath, parsePathD, applyHint,
  fitViewBox, snap,
  loadElementCatalog,
  registerBinding, emitElementMesh,
} from '../dist/index.js';

/* ─── module-local state ──────────────────────────────────────────────── */

const state = {
  active: false,
  bindingKey: null,
  binding: null,
  element: null,
  activeSlot: null,
  slots: {},
  tool: 'select',
  snapGrid: 5,
  paperScope: null,
  saveCallback: null,
  bindingsRef: null,   // reference to atlas-wide bindings dict; set by index.html
  kernelRef: null,     // reference to the loaded kernel module
};

/* ─── public API ─────────────────────────────────────────────────────── */

export function openEditor(bindingKey, opts) {
  state.bindingKey = bindingKey;
  state.saveCallback = opts?.onSave ?? null;
  state.bindingsRef = opts?.bindingsRef ?? null;
  state.kernelRef = opts?.kernelRef ?? null;

  const binding = state.bindingsRef?.[bindingKey];
  if (!binding) {
    console.error(`openEditor: no binding for ${bindingKey}`);
    return;
  }
  const catalog = loadElementCatalog();
  const element = catalog.elementsById.get(binding.elementId);
  if (!element) {
    console.error(`openEditor: no element ${binding.elementId}`);
    return;
  }
  state.binding = binding;
  state.element = element;
  state.slots = {};
  for (const slotDef of element.profileSlots) {
    const svgStr = binding.profiles[slotDef.name];
    if (typeof svgStr !== 'string') continue;
    const dMatch = svgStr.match(/<path\b[^>]*\bd\s*=\s*"([^"]+)"/);
    const vbMatch = svgStr.match(/viewBox\s*=\s*"([^"]+)"/);
    if (!dMatch || !vbMatch) continue;
    const [vx, vy, vw, vh] = vbMatch[1].trim().split(/\s+/).map(Number);
    let vertices;
    try {
      vertices = parsePathD(dMatch[1]);
    } catch (err) {
      console.warn(`openEditor: cannot parse ${slotDef.name} (likely curve commands):`, err.message);
      continue;
    }
    state.slots[slotDef.name] = {
      slotName: slotDef.name,
      hint: slotDef.hint,
      viewBox: [vx, vy, vw, vh],
      vertices,
      dirty: false,
      originalSvg: svgStr,
      paperPath: null,    // created when slot becomes active
    };
  }
  state.activeSlot = element.profileSlots[0]?.name ?? null;
  state.active = true;

  _initPaper();
  _renderSlotTabs();
  _loadSlotIntoCanvas(state.activeSlot);
  _refreshStatus();
  _refreshPreview();
  _refreshSaveButton();
  _refreshBreadcrumb();
}

export function closeEditor() {
  if (state.paperScope) {
    state.paperScope.project?.clear();
    state.paperScope = null;
  }
  state.active = false;
  state.bindingKey = null;
  state.binding = null;
  state.element = null;
  state.activeSlot = null;
  state.slots = {};
}

export function hasUnsavedChanges() {
  return Object.values(state.slots).some(s => s.dirty);
}

export function editorOpenSlot(slotName) {
  if (!state.slots[slotName]) return;
  state.activeSlot = slotName;
  _loadSlotIntoCanvas(slotName);
  _renderSlotTabs();
  _refreshStatus();
}

export function editorSelectTool(toolName) {
  state.tool = toolName;
  // Update the tool palette buttons.
  for (const btn of document.querySelectorAll('.editor-tool-btn[data-tool]')) {
    if (btn.dataset.tool === 'snap') continue;
    btn.classList.toggle('active', btn.dataset.tool === toolName);
  }
  // Update canvas cursor.
  const canvas = document.getElementById('editorCanvas');
  if (canvas) {
    canvas.style.cursor =
      toolName === 'select' ? 'crosshair' :
      toolName === 'pen'    ? 'cell' :
      toolName === 'pan'    ? 'grab' :
      toolName === 'zoom'   ? 'zoom-in' :
      'default';
  }
}

export function editorToggleSnap() {
  state.snapGrid = state.snapGrid === 0 ? 5 : 0;
  document.getElementById('editorSnapBtn')?.classList.toggle('active', state.snapGrid > 0);
  _refreshStatus();
}

export async function editorSave() {
  // Implemented in Task 11.
  console.warn('editorSave: not yet implemented (Task 11)');
}

export function editorRefresh() {
  if (!state.active) return;
  _refreshStatus();
  _refreshSaveButton();
  _refreshBreadcrumb();
  _renderSlotTabs();
}

/* ─── Paper.js init + per-slot loading ──────────────────────────────── */

function _initPaper() {
  const canvas = document.getElementById('editorCanvas');
  if (!canvas) return;
  paper.install(window);
  paper.setup(canvas);
  state.paperScope = paper;
}

function _loadSlotIntoCanvas(slotName) {
  const slot = state.slots[slotName];
  if (!slot || !state.paperScope) return;
  const ps = state.paperScope;
  ps.project.clear();

  // Compute view-fit transform for this slot's viewBox.
  const canvas = document.getElementById('editorCanvas');
  const view = { canvasSize: { w: canvas.clientWidth, h: canvas.clientHeight }, viewBox: slot.viewBox };
  // Note: We don't use Paper.js's view.matrix because we want explicit control;
  // we draw at canvas pixel coords by converting from SVG-space at draw time.

  // ── viewBox outline (dashed) ──
  const [vbX, vbY, vbW, vbH] = slot.viewBox;
  const tlCanvas = _svgToCanvas({ sx: vbX, sy: vbY + vbH }, view);
  const brCanvas = _svgToCanvas({ sx: vbX + vbW, sy: vbY }, view);
  const lotRect = new ps.Path.Rectangle({
    from: [tlCanvas.px, tlCanvas.py],
    to: [brCanvas.px, brCanvas.py],
  });
  lotRect.strokeColor = '#3d434e';
  lotRect.dashArray = [3, 3];
  lotRect.strokeWidth = 1;
  lotRect.data.role = 'viewbox';

  // ── grid lines ──
  if (state.snapGrid > 0) {
    const grid = new ps.Group();
    for (let x = vbX; x <= vbX + vbW; x += state.snapGrid) {
      const a = _svgToCanvas({ sx: x, sy: vbY }, view);
      const b = _svgToCanvas({ sx: x, sy: vbY + vbH }, view);
      const line = new ps.Path.Line({ from: [a.px, a.py], to: [b.px, b.py] });
      line.strokeColor = '#22262e';
      line.strokeWidth = 0.5;
      grid.addChild(line);
    }
    for (let y = vbY; y <= vbY + vbH; y += state.snapGrid) {
      const a = _svgToCanvas({ sx: vbX, sy: y }, view);
      const b = _svgToCanvas({ sx: vbX + vbW, sy: y }, view);
      const line = new ps.Path.Line({ from: [a.px, a.py], to: [b.px, b.py] });
      line.strokeColor = '#22262e';
      line.strokeWidth = 0.5;
      grid.addChild(line);
    }
    grid.data.role = 'grid';
  }

  // ── symmetric-half axis (if applicable) ──
  if (slot.hint === 'symmetric-half') {
    const a = _svgToCanvas({ sx: 0, sy: vbY }, view);
    const b = _svgToCanvas({ sx: 0, sy: vbY + vbH }, view);
    const axis = new ps.Path.Line({ from: [a.px, a.py], to: [b.px, b.py] });
    axis.strokeColor = '#B56A1D';
    axis.dashArray = [4, 4];
    axis.strokeWidth = 1;
    axis.data.role = 'axis';
  }

  // ── the editable path ──
  const path = new ps.Path();
  path.strokeColor = '#B56A1D';
  path.strokeWidth = 1.5;
  path.fillColor = new ps.Color(0.71, 0.42, 0.11, 0.12);   // accent-dim
  path.closed = slot.hint === 'closed-path';
  path.data.role = 'profile';
  for (const [sx, sy] of slot.vertices) {
    const c = _svgToCanvas({ sx, sy }, view);
    path.add(new ps.Point(c.px, c.py));
  }

  // ── vertex handles ──
  const handleGroup = new ps.Group();
  handleGroup.data.role = 'handles';
  for (let i = 0; i < path.segments.length; i++) {
    const seg = path.segments[i];
    const handle = new ps.Path.Circle({
      center: seg.point,
      radius: 5,
    });
    handle.fillColor = '#B56A1D';
    handle.strokeColor = '#1b1e24';
    handle.strokeWidth = 1.2;
    handle.data.role = 'vertex';
    handle.data.segmentIndex = i;
    handleGroup.addChild(handle);
  }

  slot.paperPath = path;
  slot.paperHandles = handleGroup;
  slot.cachedView = view;

  ps.view.draw();
}

function _svgToCanvas(svgPt, view) {
  const m = fitViewBox(view.canvasSize, view.viewBox);
  const [vbX, vbY, vbW, vbH] = view.viewBox;
  return {
    px: m.offsetX + (svgPt.sx - vbX) * m.scale,
    py: m.offsetY + ((vbY + vbH) - svgPt.sy) * m.scale,
  };
}

function _canvasToSvg(canvasPt, view) {
  const m = fitViewBox(view.canvasSize, view.viewBox);
  const [vbX, vbY, vbW, vbH] = view.viewBox;
  return {
    sx: (canvasPt.px - m.offsetX) / m.scale + vbX,
    sy: (vbY + vbH) - (canvasPt.py - m.offsetY) / m.scale,
  };
}

/* ─── UI refresh helpers ────────────────────────────────────────────── */

function _renderSlotTabs() {
  const host = document.getElementById('editorSlotTabs');
  if (!host || !state.element) return;
  host.innerHTML = state.element.profileSlots.map(slot => {
    const isActive = state.activeSlot === slot.name;
    const isDirty  = state.slots[slot.name]?.dirty;
    return `<button class="editor-slot-tab ${isActive ? 'active' : ''}" data-slot="${slot.name}">${slot.name}${isDirty ? '<span class="dirty-dot"></span>' : ''}</button>`;
  }).join('');
  for (const btn of host.querySelectorAll('button[data-slot]')) {
    btn.addEventListener('click', () => editorOpenSlot(btn.dataset.slot));
  }
}

function _refreshBreadcrumb() {
  const el = document.getElementById('editorBindingName');
  if (!el) return;
  if (state.binding) {
    el.textContent = `${state.binding.styleSheetId} · ${state.binding.elementId}`;
  } else {
    el.textContent = '— no binding loaded —';
  }
}

function _refreshStatus() {
  const el = document.getElementById('editorStatus');
  if (!el) return;
  const slot = state.slots[state.activeSlot];
  const gridText = state.snapGrid > 0 ? `grid ${state.snapGrid}mm` : 'no grid';
  const vCount = slot?.paperPath?.segments?.length ?? slot?.vertices?.length ?? 0;
  const closed = slot?.hint === 'closed-path' ? 'closed' : 'open';
  el.textContent = `${gridText} · ${vCount} vertices · ${closed}`;
}

function _refreshSaveButton() {
  const btn = document.getElementById('editorSaveBtn');
  if (!btn) return;
  btn.disabled = !hasUnsavedChanges();
}

function _refreshPreview() {
  // Implemented in Task 10.
}
```

- [ ] **Step 2: Build the architecture package so dist/ is fresh**

```bash
npm run build --workspace=@hayba/architecture
```

- [ ] **Step 3: Commit**

```bash
git add packages/architecture/demo/editor.js
git diff --cached --name-only
git commit -m "feat(architecture): editor.js — load binding, parse slot SVGs, render Paper.js path + handles"
```

---

### Task 8: Tools — select / pen / pan / zoom

**Files:**
- Modify: `packages/architecture/demo/editor.js`

- [ ] **Step 1: Add tool implementations**

At the bottom of `editor.js`, BEFORE the closing of the file but AFTER the UI refresh helpers, add:

```js
/* ─── Tool implementations (Paper.js Tool API) ──────────────────────── */

function _setupTools() {
  if (!state.paperScope) return;
  const ps = state.paperScope;

  const selectTool = new ps.Tool();
  let dragSegment = null;

  selectTool.onMouseDown = (event) => {
    if (state.tool !== 'select') return;
    const slot = state.slots[state.activeSlot];
    if (!slot) return;
    const hit = ps.project.hitTest(event.point, { fill: true, tolerance: 6 });
    if (hit && hit.item.data.role === 'vertex') {
      dragSegment = slot.paperPath.segments[hit.item.data.segmentIndex];
    } else {
      dragSegment = null;
    }
  };
  selectTool.onMouseDrag = (event) => {
    if (state.tool !== 'select' || !dragSegment) return;
    const slot = state.slots[state.activeSlot];
    if (!slot) return;
    // Convert mouse delta to canvas → svg-space → snap → back to canvas.
    let target = event.point;
    // Snap if enabled.
    const sv = _canvasToSvg({ px: target.x, py: target.y }, slot.cachedView);
    const snappedSx = state.snapGrid > 0 ? snap(sv.sx, state.snapGrid) : sv.sx;
    const snappedSy = state.snapGrid > 0 ? snap(sv.sy, state.snapGrid) : sv.sy;
    // Hint enforcement (live).
    const clamped = applyHint([[snappedSx, snappedSy]], slot.hint)[0];
    const c = _svgToCanvas({ sx: clamped[0], sy: clamped[1] }, slot.cachedView);
    dragSegment.point = new ps.Point(c.px, c.py);
    // Move the corresponding vertex handle too.
    const idx = slot.paperPath.segments.indexOf(dragSegment);
    if (idx >= 0 && slot.paperHandles) {
      slot.paperHandles.children[idx].position = new ps.Point(c.px, c.py);
    }
    _markDirty();
    _refreshStatus();
    _scheduleSlotSync();
  };
  selectTool.onMouseUp = () => { dragSegment = null; };
  selectTool.onKeyDown = (event) => {
    if (state.tool !== 'select') return;
    if (event.key === 'delete' || event.key === 'backspace') {
      const slot = state.slots[state.activeSlot];
      if (!slot) return;
      const sel = ps.project.selectedItems.filter(i => i.data.role === 'vertex');
      if (sel.length === 0) return;
      const indices = sel.map(h => h.data.segmentIndex).sort((a, b) => b - a);
      for (const idx of indices) {
        slot.paperPath.removeSegment(idx);
        slot.paperHandles.children[idx].remove();
      }
      _markDirty();
      _refreshStatus();
      _scheduleSlotSync();
      _refreshPreview();
    }
  };

  const penTool = new ps.Tool();
  penTool.onMouseDown = (event) => {
    if (state.tool !== 'pen') return;
    const slot = state.slots[state.activeSlot];
    if (!slot) return;
    let { sx, sy } = _canvasToSvg({ px: event.point.x, py: event.point.y }, slot.cachedView);
    if (state.snapGrid > 0) {
      sx = snap(sx, state.snapGrid);
      sy = snap(sy, state.snapGrid);
    }
    [[sx, sy]] = [applyHint([[sx, sy]], slot.hint)];
    const c = _svgToCanvas({ sx, sy }, slot.cachedView);
    slot.paperPath.add(new ps.Point(c.px, c.py));
    // Add a vertex handle.
    const h = new ps.Path.Circle({ center: [c.px, c.py], radius: 5 });
    h.fillColor = '#B56A1D';
    h.strokeColor = '#1b1e24';
    h.strokeWidth = 1.2;
    h.data.role = 'vertex';
    h.data.segmentIndex = slot.paperPath.segments.length - 1;
    slot.paperHandles.addChild(h);
    _markDirty();
    _refreshStatus();
    _scheduleSlotSync();
  };

  const panTool = new ps.Tool();
  panTool.onMouseDrag = (event) => {
    if (state.tool !== 'pan') return;
    // Translate the entire project view.
    ps.view.translate(event.delta);
  };

  const zoomTool = new ps.Tool();
  // Wheel handling on canvas element (Paper.js Tool doesn't natively expose scroll).
  const canvas = document.getElementById('editorCanvas');
  if (canvas) {
    canvas.addEventListener('wheel', (e) => {
      if (!state.active) return;
      e.preventDefault();
      const oldZoom = ps.view.zoom;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      ps.view.zoom = Math.max(0.2, Math.min(10, oldZoom * factor));
    }, { passive: false });
  }

  // Tools auto-switch via editorSelectTool() which sets state.tool;
  // the tool's onMouseDown etc. early-out unless state.tool matches.
  selectTool.activate();
}
```

- [ ] **Step 2: Wire `_setupTools()` into `_initPaper()`**

In `_initPaper()`, ADD a call to `_setupTools()` at the end:

```js
function _initPaper() {
  const canvas = document.getElementById('editorCanvas');
  if (!canvas) return;
  paper.install(window);
  paper.setup(canvas);
  state.paperScope = paper;
  _setupTools();
}
```

- [ ] **Step 3: Add the `_markDirty()` and `_scheduleSlotSync()` stubs**

These are called by the tools but not yet wired to dirty-tracking or preview-refresh. Implement minimal stubs now; Task 11 fleshes out `_scheduleSlotSync` (which syncs Paper.js path back to `slot.vertices`).

ADD these helpers near `_refreshStatus`:

```js
function _markDirty() {
  const slot = state.slots[state.activeSlot];
  if (!slot) return;
  if (!slot.dirty) {
    slot.dirty = true;
    _refreshSaveButton();
    _renderSlotTabs();
  }
}

let _previewQueued = false;
function _scheduleSlotSync() {
  // Sync the Paper.js path's current segment positions back to slot.vertices,
  // then queue a preview refresh.
  const slot = state.slots[state.activeSlot];
  if (!slot || !slot.paperPath) return;
  slot.vertices = slot.paperPath.segments.map((seg) => {
    const sv = _canvasToSvg({ px: seg.point.x, py: seg.point.y }, slot.cachedView);
    return [sv.sx, sv.sy];
  });
  if (!_previewQueued) {
    _previewQueued = true;
    requestAnimationFrame(() => {
      _previewQueued = false;
      _refreshPreview();
    });
  }
}
```

- [ ] **Step 4: Build + commit**

```bash
npm run build --workspace=@hayba/architecture
git add packages/architecture/demo/editor.js
git diff --cached --name-only
git commit -m "feat(architecture): editor — select / pen / pan / zoom tools with snap + hint enforcement"
```

---

### Task 9: Hint enforcement is already wired

Implementation note: hint enforcement (clamping `symmetric-half` to x≥0, etc.) is already called inline in the Pen + Select drag flows via `applyHint(...)` from Task 8. No additional code needed — this task confirms the wiring with a manual sanity check.

- [ ] **Step 1: Verify by reading the file**

```bash
grep -n "applyHint" packages/architecture/demo/editor.js
```
Expected: at least 2 hits (one in `selectTool.onMouseDrag`, one in `penTool.onMouseDown`).

- [ ] **Step 2: No commit needed** (no code change).

---

### Task 10: Live 3D preview

**Files:**
- Modify: `packages/architecture/demo/editor.js`

- [ ] **Step 1: Add the three.js preview setup + refresh**

REPLACE the stub `_refreshPreview()` with:

```js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let _preview = null;   // { scene, camera, renderer, controls, currentMesh, raf }

function _ensurePreview() {
  if (_preview) return _preview;
  const stage = document.getElementById('editorPreviewStage');
  if (!stage) return null;
  stage.innerHTML = '';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1e24);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(2.5, 3, 4);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  stage.appendChild(renderer.domElement);

  scene.add(new THREE.DirectionalLight(0xffffff, 1.2).translateX(5).translateY(8).translateZ(6));
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  scene.add(new THREE.GridHelper(10, 10, 0x3d434e, 0x2a2e36));

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.update();

  function animate() {
    _preview.raf = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  _preview = { scene, camera, renderer, controls, currentMesh: null, raf: 0 };
  animate();
  return _preview;
}

function _disposePreview() {
  if (!_preview) return;
  cancelAnimationFrame(_preview.raf);
  _preview.renderer.dispose();
  if (_preview.renderer.domElement.parentNode) {
    _preview.renderer.domElement.parentNode.removeChild(_preview.renderer.domElement);
  }
  _preview = null;
}

function _refreshPreview() {
  if (!state.active || !state.binding) return;
  const preview = _ensurePreview();
  if (!preview) return;

  // Build an ephemeral binding from the current paper.js state of every slot.
  const editedProfiles = {};
  for (const [name, slot] of Object.entries(state.slots)) {
    try {
      editedProfiles[name] = verticesToSvgPath(slot.vertices, slot.viewBox, slot.hint);
    } catch (err) {
      console.warn(`_refreshPreview: skip slot ${name}:`, err.message);
      editedProfiles[name] = slot.originalSvg;
    }
  }

  const ephemeral = { ...state.binding, profiles: editedProfiles };
  try {
    registerBinding(ephemeral);
  } catch (err) {
    console.warn('_refreshPreview: registerBinding failed:', err.message);
    return;
  }

  const result = emitElementMesh(state.binding.styleSheetId, state.binding.elementId);
  if (!result.ok) {
    document.getElementById('editorPreviewStats').textContent = `kernel error: ${result.message}`;
    return;
  }

  // Replace the mesh in the scene.
  if (preview.currentMesh) preview.scene.remove(preview.currentMesh);
  const loader = new GLTFLoader();
  loader.parse(result.glb, '', (gltf) => {
    gltf.scene.traverse((o) => {
      if (o.isMesh) {
        o.material = new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.85, metalness: 0.1 });
      }
    });
    preview.scene.add(gltf.scene);
    preview.currentMesh = gltf.scene;
    // Frame the camera around the new mesh.
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3());
    const m = Math.max(s.x, s.y, s.z, 0.5);
    preview.camera.position.set(c.x + m * 1.7, c.y + m * 0.7, c.z + m * 1.7);
    preview.controls.target.copy(c);
    preview.controls.update();
  });

  document.getElementById('editorPreviewStats').textContent =
    `${result.stats.triangles} tris · ${(result.stats.sizeBytes / 1024).toFixed(1)} kB`;
  document.getElementById('editorPreviewMeta').innerHTML =
    `Hint: <span class="accent">${state.slots[state.activeSlot]?.hint ?? '—'}</span><br>Vertices: ${state.slots[state.activeSlot]?.vertices.length ?? 0}<br>Closed: ${state.slots[state.activeSlot]?.hint === 'closed-path' ? 'yes' : 'no'}`;
}
```

- [ ] **Step 2: Wire `_disposePreview()` into `closeEditor()`**

In `closeEditor()`, ADD `_disposePreview()` before the state reset:

```js
export function closeEditor() {
  _disposePreview();
  if (state.paperScope) {
    state.paperScope.project?.clear();
    state.paperScope = null;
  }
  state.active = false;
  state.bindingKey = null;
  state.binding = null;
  state.element = null;
  state.activeSlot = null;
  state.slots = {};
}
```

- [ ] **Step 3: Build + commit**

```bash
npm run build --workspace=@hayba/architecture
git add packages/architecture/demo/editor.js
git diff --cached --name-only
git commit -m "feat(architecture): editor — live three.js preview via emitElementMesh on ephemeral binding"
```

---

### Task 11: Save / Discard flow with Phase 1 POST endpoint

**Files:**
- Modify: `packages/architecture/demo/editor.js`

- [ ] **Step 1: Replace the stub `editorSave()` with the real implementation**

REPLACE the stub `editorSave` function with:

```js
export async function editorSave() {
  if (!state.binding) return;
  if (!hasUnsavedChanges()) return;

  // Build the saved profiles: dirty slots use Paper.js state; clean slots
  // keep their originalSvg.
  const savedProfiles = {};
  const newOriginals = {};
  for (const [name, slot] of Object.entries(state.slots)) {
    if (slot.dirty) {
      const svg = verticesToSvgPath(slot.vertices, slot.viewBox, slot.hint);
      savedProfiles[name] = svg;
      newOriginals[name] = svg;
    } else {
      savedProfiles[name] = slot.originalSvg;
      newOriginals[name] = slot.originalSvg;
    }
  }
  const updatedBinding = { ...state.binding, profiles: savedProfiles };

  // In-session register so emitElementMesh sees the saved state immediately.
  registerBinding(updatedBinding);

  // Persist via Phase 1 endpoint.
  const transport = { ...updatedBinding, seed: '0x' + updatedBinding.seed.toString(16) };
  const url = `/api/bindings/${encodeURIComponent(updatedBinding.styleSheetId)}/${encodeURIComponent(updatedBinding.elementId)}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(transport),
    });
  } catch (err) {
    alert(`Save failed: network error\n${err.message}`);
    return;
  }
  if (!response.ok) {
    const txt = await response.text();
    alert(`Save failed (HTTP ${response.status}):\n${txt}`);
    return;
  }

  // Clear dirty flags, update originals.
  for (const [name, slot] of Object.entries(state.slots)) {
    slot.dirty = false;
    slot.originalSvg = newOriginals[name];
  }
  state.binding = updatedBinding;

  // Notify caller (so the atlas can refresh its `bindings` dict + bound-elements panel).
  state.saveCallback?.(updatedBinding);

  _refreshSaveButton();
  _renderSlotTabs();

  // Briefly flash the save button to confirm.
  const btn = document.getElementById('editorSaveBtn');
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = '✓ SAVED';
    setTimeout(() => { btn.textContent = orig; }, 1200);
  }
}
```

- [ ] **Step 2: Wire `Cmd/Ctrl+S` keyboard shortcut**

ADD to the bottom of `_initPaper()`:

```js
  document.addEventListener('keydown', _onGlobalKeyDown);
```

ADD this handler near other helpers:

```js
function _onGlobalKeyDown(e) {
  if (!state.active) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    editorSave().catch(err => console.error('editorSave error:', err));
  }
}
```

ADD removal in `closeEditor`:

```js
  document.removeEventListener('keydown', _onGlobalKeyDown);
```

- [ ] **Step 3: Build + commit**

```bash
npm run build --workspace=@hayba/architecture
git add packages/architecture/demo/editor.js
git diff --cached --name-only
git commit -m "feat(architecture): editor — Save flow (registerBinding + POST + Cmd+S shortcut)"
```

---

### Task 12: ✎ edit button + tab switching + launch wiring

**Files:**
- Modify: `packages/architecture/demo/index.html`

- [ ] **Step 1: Import the editor module**

Find the top of the existing `<script type="module">` block (where `import * as THREE from 'three';` lives). Add:

```js
import {
  openEditor as editorOpen,
  closeEditor as editorClose,
  hasUnsavedChanges as editorHasUnsavedChanges,
  editorSelectTool,
  editorToggleSnap,
  editorSave,
  editorRefresh,
} from './editor.js';
```

- [ ] **Step 2: Wire the Editor tab visibility**

Find the existing tab click handler (search for `document.getElementById('tabs')` or similar). The current handler likely sets `state.view = ...` and re-renders. UPDATE it to handle the editor view:

```js
document.getElementById('tabs').addEventListener('click', e => {
  const t = e.target.closest('.tab');
  if (!t) return;

  // Block tab switch if editor has unsaved changes.
  if (state.view === 'editor' && editorHasUnsavedChanges()) {
    if (!confirm('You have unsaved changes in the editor. Discard?')) return;
  }

  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  const view = t.dataset.view;
  state.view = view;

  const isEditor = view === 'editor';
  document.getElementById('editorView').style.display = isEditor ? '' : 'none';
  for (const pane of document.querySelectorAll('.pane')) {
    pane.style.display = isEditor ? 'none' : '';
  }

  if (isEditor) {
    if (state.editorLastBindingKey && bindings[state.editorLastBindingKey]) {
      editorOpen(state.editorLastBindingKey, {
        bindingsRef: bindings,
        kernelRef: kernelMod,
        onSave: (newBinding) => {
          // Refresh the local bindings dict.
          bindings[`${newBinding.styleSheetId}::${newBinding.elementId}`] =
            { ...newBinding, seed: '0x' + newBinding.seed.toString(16) };
          renderCenter();
        },
      });
    }
  } else {
    editorClose();
    if (state.view === 'typologies' && !state.typologyId) state.typologyId = typologies[0].id;
    renderLeftPane();
    renderCenter();
    renderRight();
  }
});
```

You also need to add `state.editorLastBindingKey` to the global state object near the top of the script:

```js
const state = {
  view: 'guides',
  // ...existing fields...
  editorLastBindingKey: null,
};
```

- [ ] **Step 3: Add ✎ edit buttons to bound-element cards**

Find the bound-element-card template inside `renderCenter()`. ADD a new button next to `.bec-regen`:

Replace:
```js
<button class="bec-regen" data-regen-element="${p.elementId}" data-regen-style="${p.styleSheetId}" title="Regenerate via AI">⟲ regen</button>
```

With:
```js
<div style="display: flex; gap: 6px;">
  <button class="bec-regen" data-regen-element="${p.elementId}" data-regen-style="${p.styleSheetId}" title="Regenerate via AI">⟲ regen</button>
  <button class="bec-edit" data-edit-element="${p.elementId}" data-edit-style="${p.styleSheetId}" title="Edit vertices">✎ edit</button>
</div>
```

- [ ] **Step 4: Wire the ✎ edit click**

In the existing document-level click handler, ADD a branch ABOVE the existing `.bound-element-card` open-viewer handler:

```js
  const editBtn = e.target.closest('[data-edit-element]');
  if (editBtn) {
    e.stopPropagation();
    const key = `${editBtn.dataset.editStyle}::${editBtn.dataset.editElement}`;
    state.editorLastBindingKey = key;
    // Switch to Editor tab; the tab handler does the actual openEditor call.
    document.querySelector('.tab[data-view="editor"]').click();
    return;
  }
```

- [ ] **Step 5: Wire the tool palette buttons + save button**

ADD to the bottom of the script (where other click wirings live):

```js
// Editor tool palette + save button.
for (const btn of document.querySelectorAll('.editor-tool-btn[data-tool]')) {
  btn.addEventListener('click', () => {
    if (btn.dataset.tool === 'snap') {
      editorToggleSnap();
    } else {
      editorSelectTool(btn.dataset.tool);
    }
  });
}
document.getElementById('editorSaveBtn')?.addEventListener('click', () => {
  editorSave().catch(err => alert(`Save error: ${err.message}`));
});
```

- [ ] **Step 6: Browser-close protection**

ADD near boot:

```js
window.addEventListener('beforeunload', (e) => {
  if (editorHasUnsavedChanges()) {
    e.preventDefault();
    e.returnValue = '';
  }
});
```

- [ ] **Step 7: Build + commit**

```bash
npm run build --workspace=@hayba/architecture
git add packages/architecture/demo/index.html
git diff --cached --name-only
git commit -m "feat(architecture): atlas — Editor tab switch + ✎ edit on bound cards + launch wiring"
```

---

### Task 13: Manual smoke test + screenshot

**Files:** none modified — verification only.

- [ ] **Step 1: Start the demo server**

```bash
npm run serve --workspace=@hayba/architecture
```

Open the printed URL (`http://localhost:5184/demo/` or whichever port).

- [ ] **Step 2: Run the 10-step smoke checklist from the spec**

1. Click Style guides → Medieval European → Gothic. The Gothic page shows the bound elements panel with 3 cards (column, cornice, finial).
2. Click `✎ edit` on the **column** card. Editor tab activates; canvas shows the **shaft** slot's vertices.
3. Drag a vertex. The 3D preview on the right updates within a frame; status bar shows updated vertex count.
4. Switch to the **base** slot via the slot tabs. The shaft remains dirty (● dot visible).
5. Click **SAVE** (or Cmd+S). Button flashes `✓ SAVED`. Dirty dots clear.
6. Verify the file at `packages/architecture/src/bindings/medieval-european-gothic/column.json` has been updated:
   ```bash
   git diff packages/architecture/src/bindings/medieval-european-gothic/column.json
   ```
7. Hard-refresh the page. Navigate back to Gothic → bound elements → ✎ edit. The edits persist.
8. **Restore the column binding** before continuing:
   ```bash
   git checkout packages/architecture/src/bindings/medieval-european-gothic/column.json
   ```
9. Open editor again on the column. Switch tool to **Pen** (`✎` button or P key). Click in the canvas to add a vertex — a new handle appears.
10. Switch to **Select**. Click a vertex (it should highlight). Press `Delete` — vertex removed.
11. Try to drag a vertex past `x=0` on the shaft (symmetric-half slot). Clamp at the axis line; vertex won't go negative.
12. Click another tab without saving the discarded test edits → confirm prompt appears.

- [ ] **Step 3: Take screenshots**

Capture:
1. The editor in action with the Gothic column shaft open + a few vertices visible.
2. The slot tabs with a dirty dot on one of them.
3. The 3D preview pane.

Save as `tmp_svg_editor_*.png` in the repo root (gitignored).

- [ ] **Step 4: Run the full architecture test suite to confirm no regressions**

```bash
npm test --workspace=@hayba/architecture
```
Expected: 156 (baseline) + 24 (editor pure-function tests) ≈ **180 tests pass**.

- [ ] **Step 5: Restore any test-modified bindings + commit only fixes if any**

```bash
git status
git checkout packages/architecture/src/bindings/medieval-european-gothic/   # if dirty
```

If the smoke test surfaced any bugs that required code fixes, commit those as `fix(architecture): editor — <description>`.

If everything passed first try, no commit needed.

---

## Definition of done

- [x] Editor tab visible in toolbar; clicking opens the editor view *(Task 6, 12)*
- [x] ✎ edit button on every bound-element card opens the editor for that binding *(Task 12)*
- [x] Slot tabs (one per `element.profileSlots`) at the top of the editor; dirty indicator visible *(Tasks 7, 8, 11)*
- [x] Canvas renders the active slot's path via Paper.js, with editable vertex handles *(Task 7)*
- [x] 4 tools (Select / Pen / Pan / Zoom) wired and switchable *(Task 8)*
- [x] Grid snap (default 5mm), togglable, snap applies on every vertex drag *(Tasks 7, 8)*
- [x] Hint enforcement: symmetric-half clamping with axis visualization *(Tasks 7, 8)*
- [x] Live 3D preview in right panel updates within a frame of vertex changes *(Task 10)*
- [x] Save button writes through Phase 1's POST endpoint; success clears dirty state *(Task 11)*
- [x] Discard / dirty-confirm on tab switch *(Task 12)*
- [x] `Cmd+S` keyboard shortcut for save *(Task 11)*
- [x] All 10+ manual-smoke steps pass; screenshots captured *(Task 13)*
- [x] vitest pure-function tests ≥80% on `src/editor/` *(Tasks 2, 3)*
- [x] Typecheck + build clean *(Task 4, 13)*

## Out of scope (re-stated)

- New-from-scratch binding creation in the editor
- Curve commands (C/Q/A) on load or save
- Multi-binding tabs
- Edit history beyond per-slot revert
- Real-time collaboration
- Texture editing — separate phase
- AI-assisted vertex placement
- Tessellate AI-emitted bézier curves into segments on load — v1

## Self-review notes (already applied)

- Confirmed every type / function used in later tasks is exported by an earlier task.
- Confirmed the `bindings` dict reference passed via `opts.bindingsRef` matches what `index.html` already has in its outer scope.
- Confirmed Paper.js Tool API is correctly used: tools `.activate()` themselves; we keep all active and gate by `state.tool` in handlers (alternative would be `.activate()` on each switch, but multiple simultaneous active tools is also valid and simpler for us).
- Confirmed `requestAnimationFrame` debounce for preview re-emit (single queued frame).
- Confirmed the manual-smoke checklist mirrors the spec's "Manual smoke checklist".
- Confirmed test counts: svg-serialize ~15, coord-map ~9 = 24 new tests on top of 156 baseline.
