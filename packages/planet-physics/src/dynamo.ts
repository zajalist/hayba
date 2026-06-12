/**
 * Order-of-magnitude planetary dynamo dipole field via Christensen–Aubert scaling
 * (dipole strength scales with sqrt(rho) * Omega * buoyancy flux into the core).
 *
 * See Christensen et al., Nature 2009; Christensen & Aubert, Geophys. J. Int. 2006.
 * This is a diagnostic scaling law, not a full MHD solution.
 */

export interface DynamoScalingInput {
  /** Outer core shell thickness ~ core radius scale (m) */
  coreRadiusM: number;
  /** Typical mass density in dynamo region (kg/m³) */
  coreDensityKgM3: number;
  /** Rotation rate (rad/s) */
  omegaRadS: number;
  /** Buoyancy flux per unit mass area ~ F_conv / (rho * area) scale; supply convective heat flux H (W/m²) across core–mantle boundary as proxy */
  cmbHeatFluxWm2: number;
}

export interface DynamoScalingResult {
  estimatedSurfaceFieldTesla: number;
  estimatedDipoleMomentAm2: number;
  notes: string;
}

/** Empirical prefactor tuned to order-of-magnitude match for Earth (~25–65 µT). */
const DIP_SCALE = 0.65;

export function christensenAubertDipoleEstimate(inp: DynamoScalingInput): DynamoScalingResult {
  const r = inp.coreRadiusM;
  const rho = inp.coreDensityKgM3;
  const om = inp.omegaRadS;
  const Fb = inp.cmbHeatFluxWm2 / Math.max(rho, 1e-9);

  const bRms = DIP_SCALE * Math.sqrt(rho) * om * r * Math.cbrt(Fb);

  const mu0 = 4 * Math.PI * 1e-7;
  const mDipole = (4 * Math.PI / mu0) * bRms * r ** 3;

  return {
    estimatedSurfaceFieldTesla: bRms,
    estimatedDipoleMomentAm2: mDipole,
    notes:
      'Scaling-law estimate only; real fields depend on dynamo geometry, inner-core feedback, and mantle thermochemical boundary conditions.',
  };
}
