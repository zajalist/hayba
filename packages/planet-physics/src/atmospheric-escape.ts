/**
 * Regime classification for thermal escape: Jeans vs energy-limited hydrodynamic / blow-off.
 * Uses classical Jeans parameter and an energy-limited XUV flux proxy (Watson et al. style).
 */

const K_B = 1.380649e-23;

export type EscapeRegime = 'jeans' | 'energy_limited' | 'blow_off' | 'unknown';

export interface AtmosphericEscapeInput {
  /** Planet mass (kg) */
  planetMassKg: number;
  /** Planet radius (m) */
  planetRadiusM: number;
  /** Thermospheric temperature relevant for exobase (K) */
  exobaseTemperatureK: number;
  /** Mean molecular mass of escaping species (kg); atomic hydrogen ~1.67e-27 */
  meanMolecularMassKg: number;
  /** Extreme-ultraviolet + soft X-ray flux at orbit (W/m²) */
  xuvFluxWm2: number;
  /** Optional magnetic stand-off multiplier [0,1]: 1 = no shielding */
  magneticShieldingFactor01?: number;
}

export interface AtmosphericEscapeResult {
  regime: EscapeRegime;
  jeansParameterLambda: number;
  /** Energy-limited mass-loss rate scale (kg/s), order-of-magnitude */
  energyLimitedLossRateKgS: number;
  hydrogenThermalSpeedMs: number;
  escapeVelocityMs: number;
  notes: string;
}

export function classifyAtmosphericEscape(inp: AtmosphericEscapeInput): AtmosphericEscapeResult {
  const shield = inp.magneticShieldingFactor01 ?? 1;
  const xuv = inp.xuvFluxWm2 * shield;

  const G = 6.6743e-11;
  const vEsc = Math.sqrt((2 * G * inp.planetMassKg) / inp.planetRadiusM);
  const vTh = Math.sqrt((2 * K_B * inp.exobaseTemperatureK) / inp.meanMolecularMassKg);
  const lambda =
    (G * inp.planetMassKg * inp.meanMolecularMassKg) /
    (K_B * inp.exobaseTemperatureK * inp.planetRadiusM);

  const efficiency = 0.1;
  const energyLimited = (Math.PI * inp.planetRadiusM ** 3 * xuv * efficiency) / (G * inp.planetMassKg);

  let regime: EscapeRegime = 'unknown';
  if (lambda > 20) {
    regime = 'jeans';
  } else if (lambda < 1.5) {
    regime = 'blow_off';
  } else if (lambda < 5) {
    regime = 'energy_limited';
  } else {
    regime = 'jeans';
  }

  return {
    regime,
    jeansParameterLambda: lambda,
    energyLimitedLossRateKgS: energyLimited,
    hydrogenThermalSpeedMs: vTh,
    escapeVelocityMs: vEsc,
    notes:
      'Jeans vs hydrodynamic boundaries are fuzzy; energy-limited rate uses efficiency ~0.1. Magnetosphere reduces effective XUV via magneticShieldingFactor01.',
  };
}
