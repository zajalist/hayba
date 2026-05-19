import * as THREE from "three";
import { runRawPass } from "./bake/glPass";
import { createPingPong } from "./bake/pingpong";
import { WINDFLOW_FRAG } from "./windFlow.glsl";

/** Cap the long side to `max`, preserving the source aspect, integer,
 *  always >= 1. Equirect WIND is 2:1 but this works for any aspect. */
export function windFlowSize(
  srcW: number,
  srcH: number,
  max: number,
): { w: number; h: number } {
  const long = Math.max(srcW, srcH);
  const scale = long > max ? max / long : 1;
  return {
    w: Math.max(1, Math.round(srcW * scale)),
    h: Math.max(1, Math.round(srcH * scale)),
  };
}

export const WINDFLOW_MAX = 1024;

/** Clamp a frame dt to a sane sim step (<= 1/15 s; NaN/negative -> 0). */
export function __clampStepDt(dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  return Math.min(dt, 1 / 15);
}

export interface WindFlow {
  trailTexture(): THREE.Texture;
  step(dtSec: number): void;
  dispose(): void;
}

/** Display-only Eulerian wind flow-map engine. Owns a PRIVATE 2-RT
 *  trail ping-pong; never touches bake/erosion RTs. */
export function createWindFlow(
  renderer: THREE.WebGLRenderer,
  windRT: THREE.WebGLRenderTarget,
): WindFlow {
  const { w, h } = windFlowSize(windRT.width, windRT.height, WINDFLOW_MAX);
  const pp = createPingPong(renderer, w, h, ["TRAIL"]);
  const trail = pp.rt["TRAIL"]; // [RT0, RT1]
  const prevTarget = renderer.getRenderTarget();
  for (const rt of trail) {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
  }
  renderer.setRenderTarget(prevTarget);
  let read = 0;
  let acc = 0;

  return {
    trailTexture(): THREE.Texture {
      return trail[read].texture;
    },
    step(dtSec: number): void {
      const dt = __clampStepDt(dtSec);
      if (dt === 0) return;
      acc += dt;
      const src = trail[read];
      const dst = trail[read ^ 1];
      runRawPass(
        renderer,
        WINDFLOW_FRAG,
        {
          uPrevTrail: { value: src.texture },
          uWind: { value: windRT.texture },
          uGrid: { value: new THREE.Vector2(w, h) },
          uDt: { value: dt },
          uTime: { value: acc },
        },
        dst,
      );
      read ^= 1;
    },
    dispose(): void {
      trail[0].dispose();
      trail[1].dispose();
    },
  };
}
