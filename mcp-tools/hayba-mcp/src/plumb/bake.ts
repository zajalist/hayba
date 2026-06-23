// Deterministic profile bake — turns raw UE asset bounds + collision into the
// geometry/physics half of a Profile. No AI here: this is the free, exact part.
// The qualitative half (affordances, front/up semantics) is layered on later by
// profile_annotate. Units arrive from UE in centimetres (UE world unit); we
// convert to metres (PLUMB canonical space).

import type { Profile } from './contracts.js';

const CM_TO_M = 0.01;

/** What the UE side hands us for a bake (already JSON, cm units). */
export interface UeBoundsInput {
  asset_id: string;
  /** Axis-aligned bounds in cm: origin (centre) + box extent (half-size). */
  origin_cm: [number, number, number];
  extent_cm: [number, number, number];
  /** Optional: pivot-to-base offset in cm (negative when pivot is above base,
   *  e.g. SM_GiantTree_01 ≈ -380). Defaults to -extent.z (base at box bottom). */
  pivot_to_base_cm?: number;
  /** Optional mass estimate (kg) and density-derived CoM (cm, local). */
  mass_kg?: number;
  com_cm?: [number, number, number];
  /** Optional convex base footprint (cm, local XY). Falls back to the AABB box. */
  footprint_cm?: [number, number][];
}

const m3 = (v: [number, number, number]): [number, number, number] => [v[0] * CM_TO_M, v[1] * CM_TO_M, v[2] * CM_TO_M];

export function bakeProfile(input: UeBoundsInput, baked_at: string, profileArchetype = 'rigid_prop'): Profile {
  const origin = m3(input.origin_cm);
  const extent = m3(input.extent_cm);
  const aabb = {
    min: [origin[0] - extent[0], origin[1] - extent[1], origin[2] - extent[2]] as [number, number, number],
    max: [origin[0] + extent[0], origin[1] + extent[1], origin[2] + extent[2]] as [number, number, number],
  };
  const volume_m3 = 8 * extent[0] * extent[1] * extent[2];

  // ground_offset_m: z of the base contact surface relative to the pivot.
  const ground_offset_m = (input.pivot_to_base_cm ?? -input.extent_cm[2]) * CM_TO_M;

  const footprint: [number, number][] = input.footprint_cm
    ? input.footprint_cm.map(([x, y]) => [x * CM_TO_M, y * CM_TO_M])
    : [
        [aabb.min[0], aabb.min[1]], [aabb.max[0], aabb.min[1]],
        [aabb.max[0], aabb.max[1]], [aabb.min[0], aabb.max[1]],
      ];

  const topZ = aabb.max[2];
  const midZ = (aabb.min[2] + aabb.max[2]) / 2;
  const sockets = [
    { id: 'floor_edge', type: 'edge' as const, frame: { pos: [origin[0], origin[1], aabb.min[2]] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] } },
    { id: 'wall_mid', type: 'wall' as const, frame: { pos: [origin[0], origin[1], midZ] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] } },
    { id: 'arch_crown', type: 'ceiling' as const, frame: { pos: [origin[0], origin[1], topZ] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number] } },
  ];

  return {
    asset_id: input.asset_id,
    bake_version: 1,
    profile: profileArchetype,
    geometry: { aabb, obb: { center: origin, extents: extent, quat: [0, 0, 0, 1] }, volume_m3 },
    semantics: { up: [0, 0, 1], front: [1, 0, 0], affordances: [], sockets },
    physical: {
      mass_kg: input.mass_kg,
      com: input.com_cm ? m3(input.com_cm) : origin,
    },
    structural: { support_footprint: footprint, ground_offset_m },
    rest_states: ['upright'],
    regions: [],
    provenance: { auto: true, edited_fields: [], locked: [] },
    baked_at,
  };
}
