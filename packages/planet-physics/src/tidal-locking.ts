/**
 * Analytic tidal-locking timescale (Darwin–Kaula style, constant-Q approximation).
 * t_lock ≈ ω a⁶ I Q / (3 G m_p² k₂ R⁵) with ω initial spin rate (rad/s).
 */

const G = 6.6743e-11;

export interface TidalLockingInput {
  /** Semimajor axis (m) */
  semiMajorAxisM: number;
  /** Planet mass (kg) */
  planetMassKg: number;
  /** Planet radius (m) */
  planetRadiusM: number;
  /** Initial angular velocity (rad/s); Earth today ~ 7.292e-5 */
  initialOmegaRadS: number;
  /** Normalized moment of inertia I / (M R²); rocky planet ~0.33 */
  normalizedMomentOfInertia: number;
  /** Tidal Love number k₂ (dimensionless); Earth ~0.3 */
  loveK2: number;
  /** Tidal dissipation quality factor Q; rocky ~100–500 */
  tidalQ: number;
}

export interface TidalLockingResult {
  lockTimeSeconds: number;
  lockTimeYears: number;
  /** Eccentricity below which circularization / pseudosynchronous spin becomes relevant (order-of-magnitude placeholder using e_crit ~ few × 0.01 for hot giants; here conservative literature hook). */
  eccentricityPseudoSyncNote: string;
}

export function tidalLockingTimescale(p: TidalLockingInput): TidalLockingResult {
  const { semiMajorAxisM: a, planetMassKg: Mp, planetRadiusM: R } = p;
  const I = p.normalizedMomentOfInertia * Mp * R * R;
  const numerator = p.initialOmegaRadS * a ** 6 * I * p.tidalQ;
  const denominator = 3 * G * Mp ** 2 * p.loveK2 * R ** 5;
  const tLock = numerator / denominator;

  return {
    lockTimeSeconds: tLock,
    lockTimeYears: tLock / (365.25 * 86400),
    eccentricityPseudoSyncNote:
      'For nonzero eccentricity, equilibrium spin is often pseudosynchronous rather than synchronous; use a reduced spin model or dissipation partition across orbital harmonics.',
  };
}
