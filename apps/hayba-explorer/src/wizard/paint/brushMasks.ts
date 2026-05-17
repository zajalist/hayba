export type MaskName = "round-soft" | "round-hard" | "splatter" | "ridge" | "cluster";

export const MASK_NAMES: readonly MaskName[] = [
  "round-soft", "round-hard", "splatter", "ridge", "cluster",
];

const SIZE = 64;

// Deterministic hash for splatter/cluster placement (no Math.random — masks must be stable).
function hash01(i: number): number {
  let h = (i + 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function buildRoundSoft(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE * 2 - 1;
      const v = (y + 0.5) / SIZE * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      // Gaussian sigma=0.4
      out[y * SIZE + x] = r > 1 ? 0 : Math.exp(-(r * r) / (2 * 0.4 * 0.4));
    }
  }
  return out;
}

function buildRoundHard(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE * 2 - 1;
      const v = (y + 0.5) / SIZE * 2 - 1;
      out[y * SIZE + x] = (u * u + v * v) <= 1 ? 1 : 0;
    }
  }
  return out;
}

function buildSplatter(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  const N_STAMPS = 8;
  const stamps: [number, number, number, number][] = [];
  for (let i = 0; i < N_STAMPS; i++) {
    const angle = hash01(i * 13 + 1) * Math.PI * 2;
    const dist  = hash01(i * 13 + 2) * 0.75;
    const radius = 0.18 + hash01(i * 13 + 3) * 0.12;
    const intensity = 0.5 + hash01(i * 13 + 4) * 0.5;
    stamps.push([Math.cos(angle) * dist, Math.sin(angle) * dist, radius, intensity]);
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE * 2 - 1;
      const v = (y + 0.5) / SIZE * 2 - 1;
      let val = 0;
      for (const [cx, cy, r, intensity] of stamps) {
        const du = u - cx, dv = v - cy;
        const dr = Math.sqrt(du * du + dv * dv) / r;
        if (dr < 1) val = Math.max(val, intensity * Math.exp(-(dr * dr) / 0.32));
      }
      out[y * SIZE + x] = u * u + v * v > 1 ? 0 : val;
    }
  }
  return out;
}

function buildRidge(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE * 2 - 1; // perpendicular axis
      const v = (y + 0.5) / SIZE * 2 - 1; // along axis (brush "up")
      if (u * u + v * v > 1) { out[y * SIZE + x] = 0; continue; }
      // Strong along v, narrow in u: gaussian on u with sigma=0.15
      const w = Math.exp(-(u * u) / (2 * 0.15 * 0.15)) * 0.8;
      out[y * SIZE + x] = w;
    }
  }
  return out;
}

function buildCluster(): Float32Array {
  const out = new Float32Array(SIZE * SIZE);
  // 3 large gaussian blobs + 5 small ones
  const blobs: [number, number, number, number][] = [
    [-0.2,  0.2, 0.35, 1.0], [ 0.3, -0.1, 0.30, 0.9], [ 0.05,  0.4, 0.28, 0.85],
  ];
  for (let i = 0; i < 5; i++) {
    const angle = hash01(i * 17 + 100) * Math.PI * 2;
    const dist  = 0.35 + hash01(i * 17 + 101) * 0.4;
    blobs.push([Math.cos(angle) * dist, Math.sin(angle) * dist, 0.10 + hash01(i * 17 + 102) * 0.08, 0.5 + hash01(i * 17 + 103) * 0.3]);
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5) / SIZE * 2 - 1;
      const v = (y + 0.5) / SIZE * 2 - 1;
      if (u * u + v * v > 1) { out[y * SIZE + x] = 0; continue; }
      let val = 0;
      for (const [cx, cy, sigma, intensity] of blobs) {
        const du = u - cx, dv = v - cy;
        const d2 = du * du + dv * dv;
        val = Math.max(val, intensity * Math.exp(-d2 / (2 * sigma * sigma)));
      }
      out[y * SIZE + x] = val;
    }
  }
  return out;
}

const LUTS: Record<MaskName, Float32Array> = {
  "round-soft": buildRoundSoft(),
  "round-hard": buildRoundHard(),
  "splatter":   buildSplatter(),
  "ridge":      buildRidge(),
  "cluster":    buildCluster(),
};

/** Sample mask at normalised brush-local coordinates u, v ∈ [-1, +1].
 *  Returns 0 outside the unit disc. */
export function sampleMask(name: MaskName, u: number, v: number): number {
  if (u < -1 || u > 1 || v < -1 || v > 1) return 0;
  const lut = LUTS[name];
  const x = Math.min(SIZE - 1, Math.max(0, Math.floor((u * 0.5 + 0.5) * SIZE)));
  const y = Math.min(SIZE - 1, Math.max(0, Math.floor((v * 0.5 + 0.5) * SIZE)));
  return lut[y * SIZE + x];
}
