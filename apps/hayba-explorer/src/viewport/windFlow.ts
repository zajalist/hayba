import * as THREE from "three";
import { runRawPass, runPointPass } from "./bake/glPass";
import { createPingPong } from "./bake/pingpong";
import {
  INIT_FRAG,
  ADVECT_FRAG,
  FADE_FRAG,
  SPLAT_VERT,
  SPLAT_FRAG,
} from "./windFlow.glsl";

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
export const PARTICLE_DIM = 64;
export const PARTICLE_COUNT = 4096;

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

/** Display-only Lagrangian wind flow-map engine (NX-3-v2c). Owns PRIVATE
 *  particle state ping-pong (64x64) + trail ping-pong; never touches
 *  bake/erosion RTs. */
export function createWindFlow(
  renderer: THREE.WebGLRenderer,
  windRT: THREE.WebGLRenderTarget,
  climRT: THREE.WebGLRenderTarget,
): WindFlow {
  const { w, h } = windFlowSize(windRT.width, windRT.height, WINDFLOW_MAX);

  // Particle state ping-pong (64x64 RGBA32F = 4096 particles).
  const partPP = createPingPong(renderer, PARTICLE_DIM, PARTICLE_DIM, ["P"]);
  const part = partPP.rt["P"];

  // Trail ping-pong (capped equirect, accumulates point splats + fades).
  const trailPP = createPingPong(renderer, w, h, ["T"]);
  const trail = trailPP.rt["T"];

  // Seed initial particle state via a one-shot INIT pass into part[0].
  runRawPass(
    renderer,
    INIT_FRAG,
    {
      uGrid: { value: new THREE.Vector2(PARTICLE_DIM, PARTICLE_DIM) },
    },
    part[0],
  );

  // Clear both trail halves to black so the first frames aren't garbage.
  const prevTarget = renderer.getRenderTarget();
  for (const rt of trail) {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
  }
  renderer.setRenderTarget(prevTarget);

  let pRead = 0;
  let tRead = 0;
  let acc = 0;

  return {
    trailTexture(): THREE.Texture {
      return trail[tRead].texture;
    },
    step(dtSec: number): void {
      const cdt = __clampStepDt(dtSec);
      if (cdt === 0) return;
      acc += cdt;

      // (a) ADVECT particles: part[pRead] -> part[pRead ^ 1].
      runRawPass(
        renderer,
        ADVECT_FRAG,
        {
          uPrev: { value: part[pRead].texture },
          uWind: { value: windRT.texture },
          uGrid: { value: new THREE.Vector2(PARTICLE_DIM, PARTICLE_DIM) },
          uDt: { value: cdt },
          uTime: { value: acc },
        },
        part[pRead ^ 1],
      );
      pRead ^= 1;

      // (b) FADE the trail: trail[tRead] * 0.9 -> trail[tRead ^ 1].
      runRawPass(
        renderer,
        FADE_FRAG,
        {
          uPrevTrail: { value: trail[tRead].texture },
          uGrid: { value: new THREE.Vector2(w, h) },
        },
        trail[tRead ^ 1],
      );
      tRead ^= 1;

      // (c) SPLAT particles additively onto the just-faded trail.
      runPointPass(
        renderer,
        SPLAT_VERT,
        SPLAT_FRAG,
        PARTICLE_COUNT,
        {
          uPart: { value: part[pRead].texture },
          uPartDim: { value: new THREE.Vector2(PARTICLE_DIM, PARTICLE_DIM) },
          uWind: { value: windRT.texture },
          uClim: { value: climRT.texture },
        },
        trail[tRead],
        { additive: true },
      );
    },
    dispose(): void {
      part[0].dispose();
      part[1].dispose();
      trail[0].dispose();
      trail[1].dispose();
      // NEVER call disposeGlPassCache — that frees the shared bake cache.
    },
  };
}
