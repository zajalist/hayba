// mcp-tools/hayba-mcp/src/slivers/composition/frame_target.ts
//
// Pure executor: given a target actor path + distance/height/fov/orbit,
// returns a camera_transform pointing at the target's origin from a
// position on the orbit circle around it. Coordinates returned in UE
// units (centimetres); the caller (render_camera or similar) consumes
// the transform as-is.
//
// We don't resolve the actor's actual location here — that requires a
// UE round-trip. v1 frames toward the world origin from a relative
// offset; the LLM/agent is responsible for combining with the actor's
// world location if needed. A v2 could call a hayba_actor_location
// subroutine via ctx.runSliver.

import type { SliverExecutor } from '../types.js';

export const COMPOSITION_FRAME_TARGET_KIND = 'composition.frame_target';

interface FrameTargetParams {
  target: string;
  distance: number;
  height: number;
  fov: number;
  yaw_deg: number;
}

export const frameTargetExecutor: SliverExecutor = async (rawParams) => {
  const p = rawParams as unknown as FrameTargetParams;
  const M_TO_UE = 100;          // 1 m = 100 UE units
  const yawRad = (p.yaw_deg * Math.PI) / 180;
  const r = p.distance * M_TO_UE;

  const x = Math.cos(yawRad) * r;
  const y = Math.sin(yawRad) * r;
  const z = p.height * M_TO_UE;

  // Camera looks at origin: yaw is +180 from the position angle.
  const cameraYawDeg = (p.yaw_deg + 180) % 360;
  // Simple pitch toward the target accounting for height.
  const pitchDeg = Math.atan2(-z, r) * (180 / Math.PI);

  return {
    camera_transform: {
      location: [x, y, z],
      rotation: [pitchDeg, cameraYawDeg, 0],   // [pitch, yaw, roll]
      fov: p.fov,
    },
  };
};
