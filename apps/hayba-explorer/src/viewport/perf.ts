// NX-1 perf core. Pure + headless (no GL/React) so the adaptive-scale
// hysteresis and the on-demand render gate are unit-tested without a
// WebGL context. scene.ts is the only integrator.

export interface PerfSnapshot {
  fps: number;
  ms: number; // last frame ms
  emaMs: number; // smoothed frame ms
  calls: number; // renderer.info.render.calls
  triangles: number; // renderer.info.render.triangles
  scale: number; // current adaptive render scale (× clamped DPR)
  gpuMs: number | null; // EXT_disjoint_timer_query, or null
  bakeMs: number | null; // last bake wall time, or null
}

export interface FrameMeter {
  push(dtMs: number): { fps: number; ms: number; emaMs: number };
}

/** EMA frame-time meter. `alpha` = smoothing (higher = snappier). */
export function createFrameMeter(alpha = 0.1): FrameMeter {
  let ema = 0;
  let init = false;
  return {
    push(dtMs: number) {
      const ms = dtMs > 0 ? dtMs : 0.0001;
      ema = init ? ema + alpha * (ms - ema) : ms;
      init = true;
      return { fps: 1000 / ms, ms: dtMs, emaMs: ema };
    },
  };
}

export interface AdaptiveOpts {
  budgetMs: number;
  floor: number;
  ceil: number;
  downStep: number;
  upStep: number;
  upHoldFrames: number;
}

export const DEFAULT_ADAPTIVE: AdaptiveOpts = {
  budgetMs: 22,
  floor: 0.5,
  ceil: 1,
  downStep: 0.85,
  upStep: 1.05,
  upHoldFrames: 45,
};

function clampN(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Pure hysteresis controller. State (the up-hold counter) is passed
 *  in and returned — no internal mutable state, fully testable.
 *  Over budget → step down immediately, reset hold. Comfortably under
 *  (< 0.8·budget) for `upHoldFrames` consecutive frames → step up,
 *  reset hold. Mid-band → hold steady, reset hold (no creep-up). */
export function adaptiveScale(
  emaMs: number,
  cur: number,
  hold: number,
  opts: AdaptiveOpts = DEFAULT_ADAPTIVE,
): { scale: number; hold: number } {
  if (emaMs > opts.budgetMs) {
    return { scale: clampN(cur * opts.downStep, opts.floor, opts.ceil), hold: 0 };
  }
  if (emaMs < opts.budgetMs * 0.8) {
    const h = hold + 1;
    if (h >= opts.upHoldFrames) {
      return {
        scale: clampN(cur * opts.upStep, opts.floor, opts.ceil),
        hold: 0,
      };
    }
    return { scale: cur, hold: h };
  }
  return { scale: cur, hold: 0 };
}

export interface RenderGate {
  /** Mark the scene dirty (something visible changed). */
  markDirty(nowMs: number): void;
  /** Render this frame? dirty since last clear, OR within the
   *  post-dirty settle window (covers OrbitControls damping, which
   *  markDirty()s every damped frame). */
  tick(nowMs: number): boolean;
  /** Consume the dirty flag for the frame just rendered. */
  clear(): void;
}

export function createRenderGate(settleMs = 250): RenderGate {
  let dirty = false;
  let lastDirty = -Infinity;
  return {
    markDirty(nowMs: number) {
      dirty = true;
      lastDirty = nowMs;
    },
    tick(nowMs: number) {
      return dirty || nowMs - lastDirty < settleMs;
    },
    clear() {
      dirty = false;
    },
  };
}
