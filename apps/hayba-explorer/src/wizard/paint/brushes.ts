export type BrushMode = "raise" | "lower" | "smooth" | "flatten" | "noise";

export interface ApplyModeArgs {
  mode: BrushMode;
  current: number;
  w: number;              // brush weight = falloff * mask * strength
  neighborAvg: number;    // average of direct grid neighbours
  flattenTarget: number;  // flatten target elevation (-1..+1)
  noiseSample: number;    // FBM sample at this cell in [0, 1]
}

const PER_TICK_DELTA = 0.05;

/** Pure per-cell elevation update. Returns the new elevation (unclamped — caller clamps). */
export function applyMode(args: ApplyModeArgs): number {
  const { mode, current, w, neighborAvg, flattenTarget, noiseSample } = args;
  switch (mode) {
    case "raise":   return current + w * PER_TICK_DELTA;
    case "lower":   return current - w * PER_TICK_DELTA;
    case "smooth":  return current + (neighborAvg - current) * w;
    case "flatten": return current + (flattenTarget - current) * w;
    case "noise":   return current + w * PER_TICK_DELTA * (noiseSample - 0.5);
  }
}

// ── Deterministic value-noise FBM ────────────────────────────────────────

function hash3i(x: number, y: number, z: number, seed: number): number {
  let h = ((x | 0) * 374761393) ^ ((y | 0) * 668265263) ^ ((z | 0) * 2147483647) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Trilinear-interpolated value noise. Output in [0, 1]. */
export function valueNoise(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = smoothstep(fx), sy = smoothstep(fy), sz = smoothstep(fz);

  const v000 = hash3i(ix,     iy,     iz,     seed);
  const v100 = hash3i(ix + 1, iy,     iz,     seed);
  const v010 = hash3i(ix,     iy + 1, iz,     seed);
  const v110 = hash3i(ix + 1, iy + 1, iz,     seed);
  const v001 = hash3i(ix,     iy,     iz + 1, seed);
  const v101 = hash3i(ix + 1, iy,     iz + 1, seed);
  const v011 = hash3i(ix,     iy + 1, iz + 1, seed);
  const v111 = hash3i(ix + 1, iy + 1, iz + 1, seed);

  const x00 = v000 + (v100 - v000) * sx;
  const x10 = v010 + (v110 - v010) * sx;
  const x01 = v001 + (v101 - v001) * sx;
  const x11 = v011 + (v111 - v011) * sx;
  const y0 = x00 + (x10 - x00) * sy;
  const y1 = x01 + (x11 - x01) * sy;
  return y0 + (y1 - y0) * sz;
}

/** 4-octave FBM. Output normalised to [0, 1]. */
export function fbm(x: number, y: number, z: number, octaves: number, seed: number): number {
  let amp = 1, freq = 1, sum = 0, totalAmp = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, z * freq, seed + i * 31) * amp;
    totalAmp += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / totalAmp;
}
