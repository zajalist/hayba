// Analytic Earth-like template.
//
// Generates a recognisable, latitude/longitude-plausible Earth purely from
// cell directions on the unit sphere — NO external data, network, or bundled
// assets. The result is NOT pixel-accurate; it only needs continents at
// roughly correct latitudes (so the climate / biome / current / orographic
// debug map modes read believably against known geography).
//
// Axis convention (matches the rest of hayba-explorer):
//   - `y` is the POLE axis. +y = North pole, -y = South pole.
//     Verified against HeightPainter.tickStroke, which builds its tangent
//     frame from an "up" vector of (0, 1, 0).
//   - Latitude  = asin(clamp(y, -1, 1)) in degrees, range -90 (S) .. +90 (N).
//   - Longitude = atan2(z, x) in degrees, range -180 .. +180. The 0° meridian
//     lies along +x; +90° along +z. The absolute longitude origin is
//     arbitrary (the globe has no fixed prime meridian), so continents are
//     placed on a self-consistent longitude frame, not a real-world datum.

const PI = Math.PI;
const RAD2DEG = 180 / PI;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// --- Deterministic value-noise -------------------------------------------
// Small integer hash → [0,1). Stable for a given (x,y,z) lattice point so the
// whole template is reproducible run-to-run.
function hash3(ix: number, iy: number, iz: number): number {
  let h = (ix | 0) * 374761393 + (iy | 0) * 668265263 + (iz | 0) * 2147483647;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  // Map to [0,1).
  return (h >>> 0) / 4294967296;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// 3-D value noise sampled on the cell direction. Inputs are scaled before
// being passed in (frequency lives at the call site).
function valueNoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  // Smooth interpolation weights.
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);

  const c000 = hash3(ix, iy, iz);
  const c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1);
  const c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);

  const x00 = lerp(c000, c100, ux);
  const x10 = lerp(c010, c110, ux);
  const x01 = lerp(c001, c101, ux);
  const x11 = lerp(c011, c111, ux);
  const y0 = lerp(x00, x10, uy);
  const y1 = lerp(x01, x11, uy);
  return lerp(y0, y1, uz); // [0,1)
}

// Fractal Brownian motion over the unit-sphere direction. Returns ~[-1,1].
function fbm(dx: number, dy: number, dz: number, octaves: number, baseFreq: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = baseFreq;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * (valueNoise(dx * freq, dy * freq, dz * freq) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03; // non-integer lacunarity avoids axis-aligned banding
  }
  return sum / norm;
}

// --- Continental blobs ----------------------------------------------------
// Each region is a smooth elliptical membership in (lon, lat) space. Longitude
// difference wraps around ±180. `skew` shears lat as a function of lon so a
// blob can lean (e.g. the Americas trending NW->SE).
interface Region {
  name: string;
  lon: number;     // centre longitude (deg)
  lat: number;     // centre latitude (deg)
  lonHW: number;   // longitude half-width (deg)
  latHW: number;   // latitude half-width (deg)
  skew: number;    // lat shift per deg of lon offset
  height: number;  // peak land elevation contribution (0..1)
}

// Longitudes here are an internal, self-consistent frame (no real datum).
// Latitudes are chosen to match real-world geography so climate masks read
// correctly: equatorial Africa/SE-Asia, N-S Americas, mid-southern Australia,
// circumpolar Antarctica, high-north Greenland.
const REGIONS: Region[] = [
  // Eurasia — broad, temperate-to-boreal, spanning a wide longitude band.
  { name: "Eurasia",       lon:  70, lat:  48, lonHW: 78, latHW: 26, skew: -0.10, height: 0.70 },
  // Africa — straddles the equator, narrowing south.
  { name: "Africa",        lon:  18, lat:   2, lonHW: 30, latHW: 38, skew:  0.05, height: 0.55 },
  // North America — temperate/boreal, leaning NW.
  { name: "North America", lon: -98, lat:  46, lonHW: 42, latHW: 30, skew:  0.18, height: 0.66 },
  // South America — equator to deep-south, leaning SE, narrow.
  { name: "South America", lon: -62, lat: -18, lonHW: 22, latHW: 36, skew: -0.30, height: 0.62 },
  // Australia — mid-southern, compact.
  { name: "Australia",     lon: 135, lat: -26, lonHW: 26, latHW: 18, skew:  0.00, height: 0.42 },
  // Greenland — small, high north.
  { name: "Greenland",     lon: -42, lat:  74, lonHW: 16, latHW: 11, skew:  0.00, height: 0.55 },
];

// Antarctica is handled separately as a circumpolar cap (all longitudes,
// lat below ~ -62) rather than an ellipse, so it reads as a polar continent.
const ANTARCTICA_LAT_EDGE = -62; // membership ramps in below this latitude
const ANTARCTICA_LAT_FULL = -72; // fully land south of here

function lonDelta(a: number, b: number): number {
  let d = a - b;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

// Smooth membership of (lon,lat) in a region: 1 at centre → 0 outside.
function regionMembership(r: Region, lonDeg: number, latDeg: number): number {
  const dLon = lonDelta(lonDeg, r.lon);
  const dLat = latDeg - r.lat - r.skew * dLon;
  // Elliptical normalised distance.
  const nx = dLon / r.lonHW;
  const ny = dLat / r.latHW;
  const dist = Math.sqrt(nx * nx + ny * ny);
  // Solid core out to 0.55, smooth edge fading to 0 at 1.0.
  return 1 - smoothstep(0.55, 1.0, dist);
}

/**
 * Build an Earth-like elevation field, one value per cell, in [-1, 1].
 *
 * @param positions Flat unit-sphere xyz, 3 floats per cell (x,y,z).
 * @param n         Cell count.
 * @returns Float32Array(n): deep ocean ≈ -1.0, continental shelf small
 *          negative, land ≈ +0.04 .. ~+0.85, a few mountain belts up to ~0.9.
 */
export function earthElevations(positions: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    const z = positions[3 * i + 2];

    const latDeg = Math.asin(clamp(y, -1, 1)) * RAD2DEG; // -90..90
    const lonDeg = Math.atan2(z, x) * RAD2DEG;           // -180..180

    // --- Continental membership (max-combine) ---------------------------
    let m = 0;
    // Track the two strongest gradients so we can raise mountains where
    // continental edges of different regions overlap/converge.
    let m1 = 0;
    let m2 = 0;
    let landHeight = 0;
    for (let r = 0; r < REGIONS.length; r++) {
      const reg = REGIONS[r];
      const mr = regionMembership(reg, lonDeg, latDeg);
      if (mr > m) m = mr;
      if (mr > m1) {
        m2 = m1;
        m1 = mr;
      } else if (mr > m2) {
        m2 = mr;
      }
      // Height contribution weighted by this region's membership.
      if (mr > 0) landHeight = Math.max(landHeight, mr * reg.height);
    }

    // Antarctica — circumpolar cap, every longitude.
    const antM = smoothstep(ANTARCTICA_LAT_EDGE, ANTARCTICA_LAT_FULL, latDeg);
    if (antM > m) m = antM;
    if (antM > 0) landHeight = Math.max(landHeight, antM * 0.50);

    // --- Noise: edge break + interior variation -------------------------
    // Coastline break: warp the membership so coasts aren't clean ellipses.
    const edgeNoise = fbm(x, y, z, 4, 6.0);   // medium frequency
    const fineNoise = fbm(x, y, z, 5, 14.0);  // interior texture

    // Push membership around the 0.5 contour to crinkle coastlines.
    let mm = m + edgeNoise * 0.18;
    mm = clamp(mm, 0, 1);

    // --- Elevation assembly --------------------------------------------
    let elev: number;
    if (mm <= 0.001) {
      // Open ocean — deep baseline (matches compose deep-ocean default).
      elev = -1.0 + fineNoise * 0.04; // tiny ripple, stays near -1
    } else {
      // Land/shelf transition centred on the coast contour (~0.18 wide).
      const landFrac = smoothstep(0.0, 0.20, mm); // 0 at coast → 1 inland

      // Ocean side of the contour: ramp abyss(-1) → shelf(~-0.05).
      const oceanElev = lerp(-1.0, -0.05, smoothstep(0.0, 0.12, mm));

      // Land side: gentle plains plus a few mountain belts.
      // Base plains: small positive rising with how far inland we are.
      const plains = 0.04 + landFrac * (0.10 + landHeight * 0.55);
      // Interior relief from fbm — rolling terrain.
      const relief = fineNoise * 0.12 * landFrac;
      // Orogenic belts: where two strong region gradients meet (m1 & m2 both
      // sizeable) OR near the inland edge of a strong continent, raise a
      // ridge so the orographic mask sees real mountains.
      const convergence = smoothstep(0.25, 0.75, Math.min(m1, m2) * 2.0);
      const edgeRidge = smoothstep(0.45, 0.85, mm) * landHeight;
      const mountains =
        (convergence * 0.45 + edgeRidge * 0.45) *
        (0.6 + 0.4 * (fineNoise * 0.5 + 0.5));

      const landElev = plains + relief + mountains;

      // Blend ocean/land across the coast contour for a soft shelf.
      elev = lerp(oceanElev, landElev, landFrac);
    }

    out[i] = clamp(elev, -1, 1);
  }

  return out;
}

// ── Real Earth heightmap (bundled equirectangular grayscale DEM) ──────────
// `public/earth-heightmap.png` is a 4096×2048 equirectangular grayscale
// relief (downscaled from a 21600×10800 world elevation map). Sampled per
// cell by (lat, lon) with bilinear luminance. Same axis convention as
// `earthElevations`. Use this for real geography; fall back to the analytic
// generator if the asset fails to load.
const EARTH_HEIGHTMAP_URL = "/earth-heightmap.png";
// This is an ETOPO-style FULL-RANGE DEM: grey is ~linear in metres from
// deep ocean to Everest, so sea level sits where the LOWEST land begins —
// measured on this map at grey ≈ 0.55 (ocean ≤ ~0.29; lowest land — Amazon
// 0.565, Greenland 0.561, France 0.604). Below SEA_GRAY = ocean (negative,
// deeper where darker); at/above = land. A power curve (LAND_EXP) keeps
// low land genuinely low so mid-latitude continents don't get inflated to
// km-high terrain and then frozen by the lapse rate. Tune if the map is
// replaced.
// 0.40 was too low (continental-shelf bloat); 0.52 too high (real coasts
// clipped to ocean). 0.46 sits in the shelf→land gap (ocean ≤ ~0.34,
// lowest land ~0.56) — tune this one constant if coasts still look off.
const SEA_GRAY = 0.46;
const LAND_GAIN = 0.85;
const LAND_EXP = 1.6;

export async function earthElevationsFromImage(
  positions: Float32Array,
  n: number,
): Promise<Float32Array> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("earth-heightmap.png failed to load"));
    im.src = EARTH_HEIGHTMAP_URL;
  });
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  if (W === 0 || H === 0) throw new Error("earth-heightmap.png has zero size");

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context unavailable");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, W, H).data;

  // Bilinear luminance (R channel — the DEM is grayscale so R=G=B). x wraps
  // (longitude is periodic); y clamps (poles).
  const lum = (px: number, py: number): number => {
    const x0 = Math.floor(px);
    const y0 = Math.floor(py);
    const fx = px - x0;
    const fy = py - y0;
    const wrap = (a: number, m: number): number => ((a % m) + m) % m;
    const clampi = (a: number, m: number): number =>
      a < 0 ? 0 : a >= m ? m - 1 : a;
    const xa = wrap(x0, W);
    const xb = wrap(x0 + 1, W);
    const ya = clampi(y0, H);
    const yb = clampi(y0 + 1, H);
    const g = (xi: number, yi: number): number => data[(yi * W + xi) * 4];
    const top = g(xa, ya) + (g(xb, ya) - g(xa, ya)) * fx;
    const bot = g(xa, yb) + (g(xb, yb) - g(xa, yb)) * fx;
    return (top + (bot - top) * fy) / 255;
  };

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = positions[3 * i];
    const y = positions[3 * i + 1];
    const z = positions[3 * i + 2];
    const latDeg = Math.asin(clamp(y, -1, 1)) * RAD2DEG; // +90 N .. -90 S
    const lonDeg = Math.atan2(z, x) * RAD2DEG; // -180 .. 180
    // Flip longitude: our sphere's atan2(z,x) runs opposite the image's
    // west→east, so the un-flipped sample rendered a mirror-image Earth.
    const u = 1 - (lonDeg + 180) / 360; // 0..1, east-west corrected
    const v = (90 - latDeg) / 180; // 0 = north (top row)
    const L = lum(u * W, v * H);
    let elev: number;
    if (L >= SEA_GRAY) {
      const landN = (L - SEA_GRAY) / (1 - SEA_GRAY); // 0 coast .. 1 peak
      elev = Math.pow(landN, LAND_EXP) * LAND_GAIN; // low land stays low
    } else {
      elev = -((SEA_GRAY - L) / SEA_GRAY);
    }
    out[i] = clamp(elev, -1, 1);
  }
  return out;
}
