// mcp-tools/hayba-mcp/src/slivers/composition/frame_target.ts
//
// Pure executor: given a target's world location + distance/height/fov/
// orbit angle, returns a camera_transform that orbits the target and
// looks back at it. Coordinates returned in UE units (centimetres).
//
// The sliver stays pure: it does NOT resolve an actor by path (that
// would need a UE round-trip). Instead the target's world position is
// an explicit input, `target_location`. The UE Slivers panel fills it
// automatically from the picked actor; an LLM/agent calling the MCP
// tool passes it directly. Omitting it frames the world origin.

import type { SliverExecutor } from '../types.js';

export const COMPOSITION_FRAME_TARGET_KIND = 'composition.frame_target';

interface FrameTargetParams {
  target: string;
  target_location?: [number, number, number];
  distance: number;
  height: number;
  fov: number;
  yaw_deg: number;
}

export const frameTargetExecutor: SliverExecutor = async (rawParams) => {
  const p = rawParams as unknown as FrameTargetParams;
  const M_TO_UE = 100;          // 1 m = 100 UE units

  // Pivot — the point the camera frames. Defaults to the world origin
  // when no target location is supplied.
  const pivot = p.target_location ?? [0, 0, 0];

  const yawRad = (p.yaw_deg * Math.PI) / 180;
  const r = p.distance * M_TO_UE;

  // Orbit offset from the pivot.
  const offX = Math.cos(yawRad) * r;
  const offY = Math.sin(yawRad) * r;
  const offZ = p.height * M_TO_UE;

  const location: [number, number, number] = [
    pivot[0] + offX,
    pivot[1] + offY,
    pivot[2] + offZ,
  ];

  // Camera looks back at the pivot: yaw is +180 from the orbit angle.
  const cameraYawDeg = (p.yaw_deg + 180) % 360;
  // Pitch toward the pivot, accounting for the camera's height above it.
  const pitchDeg = Math.atan2(-offZ, r) * (180 / Math.PI);

  return {
    camera_transform: {
      location,
      rotation: [pitchDeg, cameraYawDeg, 0],   // [pitch, yaw, roll]
      fov: p.fov,
    },
  };
};
