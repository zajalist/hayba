import { z } from 'zod';
import {
  christensenAubertDipoleEstimate,
  classifyAtmosphericEscape,
  computeHabitableZone,
  exampleStabilityReport,
  readStabilityReportSchemaJson,
  tidalLockingTimescale,
} from '@hayba/planet-physics';

export const hzSchema = z.object({
  luminosity_solar: z.number().positive(),
  stellar_teff_k: z.number().min(2600).max(7200),
  planet_mass_earth: z.number().positive().optional().default(1),
});

export const tidalSchema = z.object({
  semi_major_axis_m: z.number().positive(),
  planet_mass_kg: z.number().positive(),
  planet_radius_m: z.number().positive(),
  initial_omega_rad_s: z.number(),
  normalized_moment_of_inertia: z.number().positive(),
  love_k2: z.number().positive(),
  tidal_q: z.number().positive(),
});

export const dynamoSchema = z.object({
  core_radius_m: z.number().positive(),
  core_density_kg_m3: z.number().positive(),
  omega_rad_s: z.number().finite(),
  cmb_heat_flux_wm2: z.number().positive(),
});

export const escapeSchema = z.object({
  planet_mass_kg: z.number().positive(),
  planet_radius_m: z.number().positive(),
  exobase_temperature_k: z.number().positive(),
  mean_molecular_mass_kg: z.number().positive(),
  xuv_flux_wm2: z.number().nonnegative(),
  magnetic_shielding_factor01: z.number().min(0).max(1).optional(),
});

export function planetHabitableZone(p: z.infer<typeof hzSchema>) {
  return computeHabitableZone(p.luminosity_solar, p.stellar_teff_k, p.planet_mass_earth);
}

export function planetTidalLocking(p: z.infer<typeof tidalSchema>) {
  return tidalLockingTimescale({
    semiMajorAxisM: p.semi_major_axis_m,
    planetMassKg: p.planet_mass_kg,
    planetRadiusM: p.planet_radius_m,
    initialOmegaRadS: p.initial_omega_rad_s,
    normalizedMomentOfInertia: p.normalized_moment_of_inertia,
    loveK2: p.love_k2,
    tidalQ: p.tidal_q,
  });
}

export function planetDynamoField(p: z.infer<typeof dynamoSchema>) {
  return christensenAubertDipoleEstimate({
    coreRadiusM: p.core_radius_m,
    coreDensityKgM3: p.core_density_kg_m3,
    omegaRadS: p.omega_rad_s,
    cmbHeatFluxWm2: p.cmb_heat_flux_wm2,
  });
}

export function planetEscapeRegime(p: z.infer<typeof escapeSchema>) {
  return classifyAtmosphericEscape({
    planetMassKg: p.planet_mass_kg,
    planetRadiusM: p.planet_radius_m,
    exobaseTemperatureK: p.exobase_temperature_k,
    meanMolecularMassKg: p.mean_molecular_mass_kg,
    xuvFluxWm2: p.xuv_flux_wm2,
    magneticShieldingFactor01: p.magnetic_shielding_factor01,
  });
}

export function planetStabilityReportPayload() {
  return {
    schema_json: readStabilityReportSchemaJson(),
    example: exampleStabilityReport(),
  };
}
