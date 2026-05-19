// SETTINGS-1: user-facing fidelity preset → bake-resolution tier.
// Pure (no React/GL). The 3 levels index BAKE_RES_TIERS
// (0:1024² 1:2048² 2:2560²); every bake pass is #217
// resolution-invariant so this scales quality/perf, not correctness.
// Persisted to localStorage so users set it once for their hardware.

export type Fidelity = "low" | "medium" | "high";

/** Matches DEFAULT_BAKE_RES (BAKE_RES_TIERS[0]) — the safe default. */
export const DEFAULT_FIDELITY: Fidelity = "low";

const TIER: Record<Fidelity, number> = { low: 0, medium: 1, high: 2 };

/** Fidelity → BAKE_RES_TIERS index. Unknown → low's tier (0). */
export function fidelityToTier(f: Fidelity): number {
  return TIER[f] ?? TIER.low;
}

/** BAKE_RES_TIERS index → Fidelity. Out-of-range → "low". */
export function tierToFidelity(idx: number): Fidelity {
  return idx === 1 ? "medium" : idx === 2 ? "high" : "low";
}

const KEY = "hayba.fidelity";

/** Read the persisted fidelity; never throws (storage absent/blocked/
 *  garbage → DEFAULT_FIDELITY). */
export function loadFidelity(): Fidelity {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    return v === "low" || v === "medium" || v === "high"
      ? v
      : DEFAULT_FIDELITY;
  } catch {
    return DEFAULT_FIDELITY;
  }
}

/** Persist the fidelity; swallows any error (private mode / quota →
 *  non-persistent fallback, app still works). */
export function saveFidelity(f: Fidelity): void {
  try {
    globalThis.localStorage?.setItem(KEY, f);
  } catch {
    /* non-persistent fallback */
  }
}
