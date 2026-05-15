/**
 * Kopparapu et al. (2014, ApJL 787 L29) habitable-zone boundaries for 1 M⊕,
 * using Table 1 polynomial in ΔT = T_eff − 5780 K (same form as VPL reference code).
 * Distances: d = sqrt(L☉ / S_eff) AU.
 *
 * Ramirez / Kopparapu mass dependence: inner-edge S_eff scales with planetary mass;
 * outer edge taken independent of mass (VPL recommendation).
 */

export interface HabitableZoneSeff {
  recentVenus: number;
  runawayGreenhouse: number;
  maximumGreenhouse: number;
  earlyMars: number;
}

export interface HabitableZoneAu {
  optimisticInner: number;
  conservativeInner: number;
  conservativeOuter: number;
  optimisticOuter: number;
}

export interface HabitableZoneResult {
  luminositySolar: number;
  stellarTeffK: number;
  planetMassEarth: number;
  seff: HabitableZoneSeff;
  distanceAu: HabitableZoneAu;
}

function kopparapu2014Seff(
  seffSun: number,
  a: number,
  b: number,
  c: number,
  d: number,
  deltaTK: number,
): number {
  const t = deltaTK;
  return seffSun + a * t + b * t * t + c * t ** 3 + d * t ** 4;
}

/** Inner-edge flux multiplier vs Earth mass (Kopparapu+ 2014 mass extension; VPL figures). */
export function innerEdgeMassFactor(planetMassEarth: number): number {
  const m = planetMassEarth;
  if (m <= 0 || !Number.isFinite(m)) return 1;
  const lg = Math.log10(m);
  // Piecewise log-linear fit to cited endpoints: 0.1 M⊕ −10%, 1 M⊕ 0%, 5 M⊕ +7%.
  if (m <= 0.1) return 0.9;
  if (m >= 5) return 1.07;
  const lg0 = Math.log10(0.1);
  const lg5 = Math.log10(5);
  const t = (lg - lg0) / (lg5 - lg0);
  return 0.9 + t * (1.07 - 0.9);
}

function auFromSeff(luminositySolar: number, seff: number): number {
  return Math.sqrt(luminositySolar / seff);
}

export function computeHabitableZone(
  luminositySolar: number,
  stellarTeffK: number,
  planetMassEarth = 1,
): HabitableZoneResult {
  const dT = stellarTeffK - 5780;
  const innerMul = innerEdgeMassFactor(planetMassEarth);

  const recentVenus = kopparapu2014Seff(1.766, 2.136e-4, 2.533e-8, -1.332e-11, -3.097e-15, dT);
  let runawayGreenhouse = kopparapu2014Seff(1.107, 1.332e-4, 1.58e-8, -8.308e-12, -1.931e-15, dT);
  const maximumGreenhouse = kopparapu2014Seff(0.356, 6.171e-5, 1.689e-9, -3.198e-12, -5.575e-16, dT);
  const earlyMars = kopparapu2014Seff(0.32, 5.547e-5, 1.526e-9, -2.874e-12, -5.011e-16, dT);

  runawayGreenhouse *= innerMul;

  const seff: HabitableZoneSeff = {
    recentVenus,
    runawayGreenhouse,
    maximumGreenhouse,
    earlyMars,
  };

  return {
    luminositySolar,
    stellarTeffK,
    planetMassEarth,
    seff,
    distanceAu: {
      optimisticInner: auFromSeff(luminositySolar, recentVenus),
      conservativeInner: auFromSeff(luminositySolar, runawayGreenhouse),
      conservativeOuter: auFromSeff(luminositySolar, maximumGreenhouse),
      optimisticOuter: auFromSeff(luminositySolar, earlyMars),
    },
  };
}
