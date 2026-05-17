import type { Mat4, Mesh, SvgPath } from './types.js';
import { IDENTITY } from './types.js';

export const IDENTITY_M: Mat4 = IDENTITY;

export function translateY(ty: number): Mat4 {
  return [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, ty, 0, 1];
}

export function translate(tx: number, ty: number, tz: number): Mat4 {
  return [1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  tx, ty, tz, 1];
}

export function scale(sx: number, sy: number, sz: number): Mat4 {
  return [sx, 0, 0, 0,  0, sy, 0, 0,  0, 0, sz, 0,  0, 0, 0, 1];
}

export function rotateY(angle: number): Mat4 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return [c, 0, -s, 0,  0, 1, 0, 0,  s, 0, c, 0,  0, 0, 0, 1];
}

export function compose(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = new Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let v = 0;
      for (let k = 0; k < 4; k++) v += a[k * 4 + i] * b[j * 4 + k];
      out[j * 4 + i] = v;
    }
  }
  return out as unknown as Mat4;
}

export function transform(mesh: Mesh, m: Mat4): Mesh {
  const n = mesh.positions.length / 3;
  const positions = new Float32Array(mesh.positions.length);
  const normals   = new Float32Array(mesh.normals.length);
  for (let i = 0; i < n; i++) {
    const x = mesh.positions[i * 3], y = mesh.positions[i * 3 + 1], z = mesh.positions[i * 3 + 2];
    positions[i * 3]     = m[0] * x + m[4] * y + m[8]  * z + m[12];
    positions[i * 3 + 1] = m[1] * x + m[5] * y + m[9]  * z + m[13];
    positions[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    const nx = mesh.normals[i * 3], ny = mesh.normals[i * 3 + 1], nz = mesh.normals[i * 3 + 2];
    let rx = m[0] * nx + m[4] * ny + m[8]  * nz;
    let ry = m[1] * nx + m[5] * ny + m[9]  * nz;
    let rz = m[2] * nx + m[6] * ny + m[10] * nz;
    const len = Math.hypot(rx, ry, rz) || 1;
    normals[i * 3]     = rx / len;
    normals[i * 3 + 1] = ry / len;
    normals[i * 3 + 2] = rz / len;
  }
  return { positions, normals, indices: new Uint32Array(mesh.indices) };
}

/**
 * Revolve a 2D symmetric-half profile around the Y axis.
 *
 * - profile.points are (x, y) in millimeters; x >= 0.
 * - The profile is open (vertical strip with one end at the axis); revolving
 *   gives a lathe-style surface.
 * - segments must be >= 3; sweep_deg in (0, 360].
 * - Output mesh in METERS (mm -> m by /1000).
 */
export function revolve(
  profile: SvgPath,
  axis: 'Y',
  segments: number,
  sweep_deg: number,
): Mesh {
  if (profile.hint !== 'symmetric-half') {
    throw new Error('revolve: requires a symmetric-half profile');
  }
  if (segments < 3) throw new Error('revolve: segments must be >= 3');
  if (sweep_deg <= 0 || sweep_deg > 360) throw new Error('revolve: sweep_deg in (0, 360]');
  if (axis !== 'Y') throw new Error('revolve: only Y axis supported in v1');
  if (profile.points.length < 2) throw new Error('revolve: profile needs >= 2 points');

  const pts = profile.points;
  const M = pts.length;
  const N = segments;
  const sweep_rad = (sweep_deg * Math.PI) / 180;
  const isFullCircle = sweep_deg === 360;

  const profileM = pts.map(([x, y]) => [x / 1000, y / 1000] as const);

  // Full circle re-uses ring 0 as ring N -> N rings stored, N transitions (with wrap).
  // Partial sweep: N+1 rings stored, N transitions.
  const ringCount = isFullCircle ? N : N + 1;
  const vertCount = M * ringCount;

  const positions = new Float32Array(vertCount * 3);
  const normals   = new Float32Array(vertCount * 3);

  for (let r = 0; r < ringCount; r++) {
    const theta = (r / N) * sweep_rad;
    const c = Math.cos(theta), s = Math.sin(theta);
    for (let i = 0; i < M; i++) {
      const [x, y] = profileM[i];
      const vIdx = (r * M + i) * 3;
      positions[vIdx]     = x * c;
      positions[vIdx + 1] = y;
      positions[vIdx + 2] = x * s;
      const len = Math.hypot(c, s) || 1;
      normals[vIdx]     = c / len;
      normals[vIdx + 1] = 0;
      normals[vIdx + 2] = s / len;
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < N; r++) {
    const r0 = r * M;
    const r1 = (isFullCircle ? ((r + 1) % N) : (r + 1)) * M;
    // Profile is OPEN (symmetric-half) so connect i to i+1 for i in [0, M-1).
    for (let i = 0; i < M - 1; i++) {
      const a = r0 + i;
      const b = r0 + i + 1;
      const c = r1 + i + 1;
      const d = r1 + i;
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }

  return { positions, normals, indices: new Uint32Array(indices) };
}

/**
 * Loft (skin) between N closed-path profiles placed at N 3D positions.
 *
 * Constraints (v1):
 * - All profiles must have the same point count. Caller pre-resamples to match.
 * - All profiles have hint 'closed-path'.
 * - Each profile's (x, y) maps to (px + x/1000, py, pz + y/1000) in engine coords.
 *
 * Caps (top/bottom polygon fill) are NOT generated.
 *
 * IMPORTANT: closed paths use Convention A - N points, no duplicate endpoint.
 * Therefore the seam-closing strip uses MODULAR wrap: (i, (i+1) % M).
 */
export function loft(profiles: SvgPath[], positions: ReadonlyArray<readonly [number, number, number]>): Mesh {
  if (profiles.length < 2) throw new Error('loft: need at least 2 profiles');
  if (profiles.length !== positions.length) {
    throw new Error('loft: profiles and positions must have equal length');
  }
  if (!profiles.every(p => p.hint === 'closed-path')) {
    throw new Error('loft: requires closed-path profiles');
  }
  const M = profiles[0].points.length;
  if (!profiles.every(p => p.points.length === M)) {
    throw new Error('loft: all profiles must have the same number of points (resample first)');
  }

  const L = profiles.length;
  const vertCount = M * L;
  const positionsBuf = new Float32Array(vertCount * 3);
  const normalsBuf   = new Float32Array(vertCount * 3);

  for (let li = 0; li < L; li++) {
    const [px, py, pz] = positions[li];
    const pts = profiles[li].points;
    for (let i = 0; i < M; i++) {
      const [x, y] = pts[i];
      const vIdx = (li * M + i) * 3;
      positionsBuf[vIdx]     = px + x / 1000;
      positionsBuf[vIdx + 1] = py;
      positionsBuf[vIdx + 2] = pz + y / 1000;
      const dx = positionsBuf[vIdx]     - px;
      const dz = positionsBuf[vIdx + 2] - pz;
      const len = Math.hypot(dx, dz) || 1;
      normalsBuf[vIdx]     = dx / len;
      normalsBuf[vIdx + 1] = 0;
      normalsBuf[vIdx + 2] = dz / len;
    }
  }

  const indices: number[] = [];
  for (let li = 0; li < L - 1; li++) {
    const r0 = li * M;
    const r1 = (li + 1) * M;
    // Modular wrap: i to (i+1) % M closes the seam.
    for (let i = 0; i < M; i++) {
      const a = r0 + i;
      const b = r0 + ((i + 1) % M);
      const c = r1 + ((i + 1) % M);
      const d = r1 + i;
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }

  return {
    positions: positionsBuf,
    normals: normalsBuf,
    indices: new Uint32Array(indices),
  };
}

/**
 * Concatenate two or more meshes into a single mesh. Index buffers are
 * offset by the cumulative vertex count of preceding meshes. No deduplication.
 */
export function mergeMeshes(meshes: Mesh[]): Mesh {
  if (meshes.length === 0) throw new Error('mergeMeshes: input must be non-empty');
  let totalVerts = 0;
  let totalIndices = 0;
  for (const m of meshes) {
    totalVerts   += m.positions.length / 3;
    totalIndices += m.indices.length;
  }
  const positions = new Float32Array(totalVerts * 3);
  const normals   = new Float32Array(totalVerts * 3);
  const indices   = new Uint32Array(totalIndices);

  let vCursor = 0;
  let iCursor = 0;
  for (const m of meshes) {
    positions.set(m.positions, vCursor * 3);
    normals.set(m.normals, vCursor * 3);
    for (let i = 0; i < m.indices.length; i++) {
      indices[iCursor + i] = m.indices[i] + vCursor;
    }
    vCursor += m.positions.length / 3;
    iCursor += m.indices.length;
  }

  return { positions, normals, indices };
}
