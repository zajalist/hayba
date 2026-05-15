export type FalloffKind = "linear" | "smooth" | "hard";

/** Brush falloff at normalised distance `d` from the brush center.
 *  d=0 → 1 (full strength), d>=1 → 0 (outside the brush). */
export function falloff(kind: FalloffKind, d: number): number {
  if (d >= 1) return 0;
  if (d <= 0) return 1;
  switch (kind) {
    case "linear": return 1 - d;
    case "smooth": {
      // Standard smoothstep, inverted so d=0 → 1, d=1 → 0
      const t = 1 - d;
      return t * t * (3 - 2 * t);
    }
    case "hard":   return 1; // hard edge — full strength up to the disc rim
  }
}
