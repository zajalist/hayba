// TS cube-sphere mirror — Task A13.
//
// FORMULA-IDENTICAL port of the committed Rust oracle
//   apps/hayba-explorer/src-tauri/src/erosion/cubesphere.rs
// (HEAD 2437729). Every constant, face-basis vector, sign, dominant-axis
// branch, and 0.5-offset/scale convention is copied VERBATIM from that file
// so the GPU port (A15) equals the CPU oracle and A18's CPU↔GPU parity holds.
//
// Rust is f32; TS is f64. That is intentional and acceptable: parity is
// defined by the >0.9999 roundtrip dot and A18's RMSE budget, NOT bit
// exactness. What MUST match is the *formulas* — so there is zero structural
// divergence between the two paths. Do not "improve" anything here.
//
// Face indexing: 0=+X 1=-X 2=+Y 3=-Y 4=+Z 5=-Z.

export type Vec3 = [number, number, number];

/** A corner where three cube faces meet. Mirrors Rust `CornerJunction`. */
export interface CornerJunction {
  faces: [number, number, number];
}

// Rust:
//   const FACE_NEI: [[u8;4];6] = // +X,-X,+Y,-Y,+Z,-Z adjacency (right,left,up,down)
//       [[5,4,2,3],[4,5,2,3],[0,1,5,4],[0,1,4,5],[0,1,2,3],[1,0,2,3]];
// Values derived empirically by Rust's
// `face_adjacency_is_geometrically_continuous` test — copied verbatim, NOT
// re-derived. Entry order per face = right, left, up, down.
export const FACE_NEI: readonly (readonly [number, number, number, number])[] = [
  [5, 4, 2, 3],
  [4, 5, 2, 3],
  [0, 1, 5, 4],
  [0, 1, 4, 5],
  [0, 1, 2, 3],
  [1, 0, 2, 3],
] as const;

// Rust:
//   fn warp(a: f32)   -> f32 { (a * std::f32::consts::FRAC_PI_4).tan() }
//   fn unwarp(a: f32) -> f32 { a.atan() * (4.0 / std::f32::consts::PI) }
// `FRAC_PI_4` == π/4. `unwarp` uses the corrected `4/π` inverse (NOT `2/π`):
// it is the exact functional inverse of `warp`, so unwarp(warp(a)) == a.
export function warp(a: number): number {
  return Math.tan(a * (Math.PI / 4));
}
export function unwarp(a: number): number {
  return Math.atan(a) * (4.0 / Math.PI);
}

/**
 * Map a face-local (u,v) ∈ [0,1]² to a unit sphere position.
 *
 * Exact port of Rust `CubeSphere::face_uv_to_sphere`:
 *   let a = warp(2.0*u - 1.0); let b = warp(2.0*v - 1.0);
 *   let d = match face {
 *       0 => Vec3::new( 1.0,   b,  -a),
 *       1 => Vec3::new(-1.0,   b,   a),
 *       2 => Vec3::new(  a, 1.0,  -b),
 *       3 => Vec3::new(  a,-1.0,   b),
 *       4 => Vec3::new(  a,   b, 1.0),
 *       _ => Vec3::new( -a,   b,-1.0),
 *   };
 *   d.normalize()
 */
export function faceUvToSphere(face: number, u: number, v: number): Vec3 {
  const a = warp(2.0 * u - 1.0);
  const b = warp(2.0 * v - 1.0);
  let d: Vec3;
  switch (face) {
    case 0:
      d = [1.0, b, -a];
      break;
    case 1:
      d = [-1.0, b, a];
      break;
    case 2:
      d = [a, 1.0, -b];
      break;
    case 3:
      d = [a, -1.0, b];
      break;
    case 4:
      d = [a, b, 1.0];
      break;
    default: // 5 (Rust `_` arm)
      d = [-a, b, -1.0];
      break;
  }
  const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  return [d[0] / len, d[1] / len, d[2] / len];
}

/**
 * Map a sphere position to (face, u, v). Need not be unit length — only the
 * dominant axis and ratios matter, exactly as in Rust.
 *
 * Exact port of Rust `CubeSphere::sphere_to_face_uv`:
 *   let (ax,ay,az)=(p.x.abs(),p.y.abs(),p.z.abs());
 *   let (face,a,b) = if ax>=ay && ax>=az {
 *       if p.x>0.0 {(0u8,-p.z/ax,p.y/ax)} else {(1,p.z/ax,p.y/ax)}
 *   } else if ay>=az {
 *       if p.y>0.0 {(2u8,p.x/ay,-p.z/ay)} else {(3,p.x/ay,p.z/ay)}
 *   } else if p.z>0.0 {(4u8,p.x/az,p.y/az)} else {(5,-p.x/az,p.y/az)};
 *   (face, 0.5*(unwarp(a)+1.0), 0.5*(unwarp(b)+1.0))
 */
export function sphereToFaceUv(p: Vec3): {
  face: number;
  u: number;
  v: number;
} {
  const px = p[0];
  const py = p[1];
  const pz = p[2];
  const ax = Math.abs(px);
  const ay = Math.abs(py);
  const az = Math.abs(pz);

  let face: number;
  let a: number;
  let b: number;
  if (ax >= ay && ax >= az) {
    if (px > 0.0) {
      face = 0;
      a = -pz / ax;
      b = py / ax;
    } else {
      face = 1;
      a = pz / ax;
      b = py / ax;
    }
  } else if (ay >= az) {
    if (py > 0.0) {
      face = 2;
      a = px / ay;
      b = -pz / ay;
    } else {
      face = 3;
      a = px / ay;
      b = pz / ay;
    }
  } else if (pz > 0.0) {
    face = 4;
    a = px / az;
    b = py / az;
  } else {
    face = 5;
    a = -px / az;
    b = py / az;
  }

  return {
    face,
    u: 0.5 * (unwarp(a) + 1.0),
    v: 0.5 * (unwarp(b) + 1.0),
  };
}

/**
 * Four neighbouring faces of `f`, ordered right, left, up, down.
 * Mirrors Rust `CubeSphere::face_neighbours` (the `debug_assert!(f < 6)`
 * becomes a JS range check).
 */
export function faceNeighbours(
  f: number,
): readonly [number, number, number, number] {
  if (f < 0 || f >= 6) {
    throw new RangeError(`face index out of range: ${f}`);
  }
  return FACE_NEI[f];
}

/**
 * The 8 cube-corner junctions (static topology). Verbatim from Rust
 * `CubeSphere::corner_junctions`:
 *   [0,2,4],[0,2,5],[0,3,4],[0,3,5],[1,2,4],[1,2,5],[1,3,4],[1,3,5]
 */
export function cornerJunctions(): CornerJunction[] {
  return [
    { faces: [0, 2, 4] },
    { faces: [0, 2, 5] },
    { faces: [0, 3, 4] },
    { faces: [0, 3, 5] },
    { faces: [1, 2, 4] },
    { faces: [1, 2, 5] },
    { faces: [1, 3, 4] },
    { faces: [1, 3, 5] },
  ];
}
