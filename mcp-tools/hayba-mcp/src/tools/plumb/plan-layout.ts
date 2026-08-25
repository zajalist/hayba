// Turn a PlacementPlan's anchors into actual points.
//
// expandGrammar emits items anchored to features of a shell -- "along
// floor_edge", "at wall_mid" -- and nothing builds a shell, so the anchors
// have never resolved to anywhere. This treats the room as an axis-aligned
// rectangle taken from the seed's own `w` and `h`, which is exactly right for
// the imperial `profile_curve: 'box'` case and an approximation for a cavern.
// Saying which is which is the caller's business; producing points is this
// file's, and it is pure so the geometry can be checked without an editor.

/** Anchors the shipped grammar actually uses. Anything else is reported
 *  unresolved rather than quietly placed at the origin. */
export type Anchor = 'floor_edge' | 'wall_mid' | 'arch_crown' | 'floor_low' | 'interior';

export interface RoomFootprint {
  /** Width in metres (seed attr `w`). */
  w: number;
  /** Depth in metres (seed attr `h` — the grammar uses h for the horizontal
   *  second axis, not height; the productions read it that way). */
  h: number;
  /** Centre of the room in cm, world space. */
  center_cm: [number, number, number];
}

export interface LayoutPoint {
  /** cm, world space, before any terrain conform. */
  loc_cm: [number, number, number];
  /** Degrees. Perimeter items face inward; interior items keep 0. */
  yaw_deg: number;
}

const M = 100; // metres → cm

/**
 * Points spaced evenly around the rectangle's perimeter.
 *
 * Spacing is treated as a maximum, not a target: the last gap is closed by
 * distributing the remainder rather than leaving a visible seam where the loop
 * wraps. `alternate` drops every other point, which is what the grammar's
 * `alternate: true` means for column runs.
 */
export function perimeterPoints(
  fp: RoomFootprint,
  spacing_m: number,
  alternate = false,
): LayoutPoint[] {
  const halfW = (fp.w / 2) * M;
  const halfH = (fp.h / 2) * M;
  const [cx, cy, cz] = fp.center_cm;

  const corners: Array<[number, number]> = [
    [cx - halfW, cy - halfH], [cx + halfW, cy - halfH],
    [cx + halfW, cy + halfH], [cx - halfW, cy + halfH],
  ];

  const out: LayoutPoint[] = [];
  for (let e = 0; e < 4; e++) {
    const [x0, y0] = corners[e]!;
    const [x1, y1] = corners[(e + 1) % 4]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.floor(len / Math.max(1, spacing_m * M)));
    // Face inward: the wall normal points at the centre.
    const yaw = [0, 90, 180, 270][e]!;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out.push({ loc_cm: [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, cz], yaw_deg: yaw });
    }
  }
  return alternate ? out.filter((_, i) => i % 2 === 0) : out;
}

/**
 * A run of wall segments around the rectangle, laid end to end.
 *
 * A shell does not have to mean generated geometry: a wall is a row of wall
 * meshes. Segments are spaced by the mesh's own length so they butt rather
 * than overlap or gap, and each is turned to run ALONG its wall rather than
 * facing across it -- a wall piece rotated the wrong way is the difference
 * between a room and a row of billboards.
 *
 * Corners are left as they fall: segments meet at the corner and may overlap
 * by up to half a segment. Modelling a corner piece needs a corner mesh, which
 * is a separate binding and a separate decision.
 */
export function wallSegments(fp: RoomFootprint, segmentLength_m: number): LayoutPoint[] {
  const seg = Math.max(0.1, segmentLength_m) * M;
  const halfW = (fp.w / 2) * M;
  const halfH = (fp.h / 2) * M;
  const [cx, cy, cz] = fp.center_cm;

  const walls: Array<{ from: [number, number]; to: [number, number]; yaw: number }> = [
    { from: [cx - halfW, cy - halfH], to: [cx + halfW, cy - halfH], yaw: 0 },
    { from: [cx + halfW, cy - halfH], to: [cx + halfW, cy + halfH], yaw: 90 },
    { from: [cx + halfW, cy + halfH], to: [cx - halfW, cy + halfH], yaw: 180 },
    { from: [cx - halfW, cy + halfH], to: [cx - halfW, cy - halfH], yaw: 270 },
  ];

  const out: LayoutPoint[] = [];
  for (const wall of walls) {
    const dx = wall.to[0] - wall.from[0];
    const dy = wall.to[1] - wall.from[1];
    const len = Math.hypot(dx, dy);
    const n = Math.max(1, Math.round(len / seg));
    for (let i = 0; i < n; i++) {
      // Centre of the i-th segment, so a run is centred on the wall.
      const t = (i + 0.5) / n;
      out.push({ loc_cm: [wall.from[0] + dx * t, wall.from[1] + dy * t, cz], yaw_deg: wall.yaw });
    }
  }
  return out;
}

/** Profiles a straight run of segments can honestly stand in for. An arch or a
 *  cavern is a curved section; squaring it off is a different room. */
export const SEGMENTABLE_PROFILES: ReadonlySet<string> = new Set(['box']);

/** One point at the middle of each wall, facing in. */
export function wallMidpoints(fp: RoomFootprint): LayoutPoint[] {
  const halfW = (fp.w / 2) * M;
  const halfH = (fp.h / 2) * M;
  const [cx, cy, cz] = fp.center_cm;
  return [
    { loc_cm: [cx, cy - halfH, cz], yaw_deg: 0 },
    { loc_cm: [cx + halfW, cy, cz], yaw_deg: 90 },
    { loc_cm: [cx, cy + halfH, cz], yaw_deg: 180 },
    { loc_cm: [cx - halfW, cy, cz], yaw_deg: 270 },
  ];
}

/** Deterministic PRNG — the same seed must give the same room twice. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points inside the rectangle, inset so nothing lands in a wall. */
export function interiorPoints(fp: RoomFootprint, count: number, seed: number): LayoutPoint[] {
  const r = rng(seed);
  const inset = 0.85;
  const halfW = (fp.w / 2) * M * inset;
  const halfH = (fp.h / 2) * M * inset;
  const [cx, cy, cz] = fp.center_cm;
  return Array.from({ length: Math.max(0, count) }, () => ({
    loc_cm: [cx + (r() * 2 - 1) * halfW, cy + (r() * 2 - 1) * halfH, cz] as [number, number, number],
    yaw_deg: Number((r() * 360).toFixed(1)),
  }));
}

/** Which anchor an emit op asks for, or null when it names one we cannot place. */
export function anchorOf(meta: Record<string, unknown>): Anchor | null {
  const named = (meta.along ?? meta.at) as string | undefined;
  if (!named) return 'interior';
  const known: Anchor[] = ['floor_edge', 'wall_mid', 'arch_crown', 'floor_low', 'interior'];
  return known.includes(named as Anchor) ? (named as Anchor) : null;
}

/** Anchors that describe a surface of a shell nothing builds yet. Reported
 *  rather than approximated -- a decal on an arch crown placed at floor height
 *  is not a near miss, it is in the wrong place. */
export const NEEDS_SHELL: ReadonlySet<Anchor> = new Set<Anchor>(['arch_crown', 'floor_low']);

export interface ResolveResult {
  points: LayoutPoint[];
  /** Set when the anchor cannot be placed without a shell, or is unknown. */
  unresolved?: string;
}

/** Points for one plan item. */
export function pointsFor(
  meta: Record<string, unknown>,
  fp: RoomFootprint,
  opts: { scatterCount?: number; seed?: number } = {},
): ResolveResult {
  const anchor = anchorOf(meta);
  if (anchor === null) {
    return { points: [], unresolved: `anchor "${String(meta.along ?? meta.at)}" is not one this layout knows` };
  }
  if (NEEDS_SHELL.has(anchor)) {
    return { points: [], unresolved: `anchor "${anchor}" is a feature of a shell, and no shell is built yet` };
  }
  if (anchor === 'floor_edge') {
    return { points: perimeterPoints(fp, (meta.spacing_m as number) ?? 2.5, meta.alternate === true) };
  }
  if (anchor === 'wall_mid') {
    return { points: wallMidpoints(fp) };
  }
  return { points: interiorPoints(fp, opts.scatterCount ?? 8, opts.seed ?? 1337) };
}
