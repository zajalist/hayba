/**
 * Kernel-internal types. Plain data, no methods, easy to test for byte equality.
 *
 * Coordinate convention: engine Y-up, right-handed. SVG coords (Y-down, mm)
 * are converted at parse time by `svg-parse.ts`. All meshes in this module
 * use meters as length units.
 */

export type Vec2 = readonly [number, number];     // (x, y)
export type Vec3 = readonly [number, number, number];  // (x, y, z)

/** 4x4 column-major transformation matrix. */
export type Mat4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

/** A 2D path of points. Closed paths repeat the first point at the end. */
export interface SvgPath {
  readonly hint: 'closed-path' | 'open-path' | 'symmetric-half' | 'tileable';
  readonly points: readonly Vec2[];
  /** Optional bbox in the SVG's viewBox coordinate system, for debug. */
  readonly bbox?: readonly [number, number, number, number];
}

/**
 * A triangle mesh in engine coordinates (meters, Y-up).
 *
 * - positions: tightly packed [x0,y0,z0, x1,y1,z1, ...] (length = vertexCount * 3)
 * - normals:   tightly packed [nx0,ny0,nz0, ...]      (length = vertexCount * 3)
 * - indices:   triangle indices (length = triangleCount * 3); always Uint32Array
 *
 * Mesh objects are immutable by convention. Primitive ops return new instances.
 */
export interface Mesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/** Identity-helper matrix builders, used by primitives.ts. */
export const IDENTITY: Mat4 = [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];
