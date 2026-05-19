// Phase-2 P2.1 — single source of truth for the equirect bake
// resolution. Equirect is strictly 2:1. Ceiling ~3.3M texels (user
// asked for "up to 3 million"); every bake pass (climate, masks,
// erosion) is resolution-invariant (#217) so any tier is correct,
// only perf scales.
export interface BakeRes {
  readonly w: number;
  readonly h: number;
}

/** Ascending tiers. 2.1M is today's default; 3.28M is the new ceiling. */
export const BAKE_RES_TIERS: readonly BakeRes[] = [
  { w: 1024, h: 512 },
  { w: 2048, h: 1024 },
  { w: 2560, h: 1280 },
] as const;

// NX-1: default to the cheapest tier (1024×512). The user can pick a
// higher tier in-app (App bake-tier selector); every pass is
// resolution-invariant (#217) so quality, not correctness, scales.
export const DEFAULT_BAKE_RES: BakeRes = BAKE_RES_TIERS[0];

/** Snap an arbitrary (w,h) to a valid tier: exact tier match wins;
 *  anything non-2:1, unknown, or oversize falls back to the max tier
 *  (never silently bakes an invalid/over-budget grid). */
export function clampBakeRes(w: number, h: number): BakeRes {
  const hit = BAKE_RES_TIERS.find((t) => t.w === w && t.h === h);
  if (hit) return hit;
  return BAKE_RES_TIERS[BAKE_RES_TIERS.length - 1];
}
