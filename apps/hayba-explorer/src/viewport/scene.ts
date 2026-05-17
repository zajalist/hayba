import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { colors } from "@hayba/design-tokens";
import { createStarfield, type StarfieldHandle } from "./starfield";

export interface SceneHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  canvas: HTMLCanvasElement;
  /** Invisible unit sphere used as the painter raycast target. */
  raycastTarget: THREE.Mesh;
  dispose: () => void;
  /** Replace the current globe object (point cloud or future mesh). */
  setGlobe: (object: THREE.Object3D | null) => void;
  /**
   * Run an offline GPU job (the A15 erosion bake) with the live render
   * loop PAUSED — "bake-then-watch". Erosion is a heavy multi-pass
   * offscreen job; sharing the renderer with the per-frame `tick`
   * (render-target thrash + GPU contention) would both slow the bake and
   * stutter the viewport. So: cancel the pending `requestAnimationFrame`,
   * await `fn(renderer)`, then resume the tick exactly as before
   * (`prevTime` is reset so the resumed frame's `dt` is not a huge spike).
   * The tick always resumes even if `fn` throws/rejects (try/finally).
   */
  runBake: (fn: (renderer: THREE.WebGLRenderer) => Promise<void> | void) => Promise<void>;
}

function hexToColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

// TODO(bake-debug): remove after feedback-loop root-caused.
// Dev-only EXTERNAL-RENDER-DURING-BAKE detector. The GPU bake runs with
// the live render loop paused (`runBake`: baking=true + loopEpoch bump).
// If ANY code path issues a main-scene `renderer.render(...)` while a bake
// owns the renderer (a competing rAF, OrbitControls, ResizeObserver, a
// React state-driven render, three.js internals — anything the static
// audit could not see), it aliases the bake's bound RTs/textures and
// causes the "Feedback loop formed between Framebuffer and active
// Texture" GL spam. We do NOT suppress the render (we want the diagnostic
// and to confirm causation) — we monkey-patch `renderer.render` to log
// the FIRST such call per bake WITH its stack, so the trigger is named.
// Gated by an explicit const AND import.meta.env.DEV so prod is
// byte-for-byte unaffected (Vite tree-shakes the dead branch).
const BAKE_DEBUG_SCENE = true;
// See pingpong.ts for the `unknown`-cast rationale (Vite-injected env,
// undefined under bare Node — keeps tsc + headless tests both happy).
const _bakeDbgScene =
  BAKE_DEBUG_SCENE &&
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;

export function createScene(canvas: HTMLCanvasElement): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(hexToColor(colors.bgDeep), 1.0);

  const scene = new THREE.Scene();

  // TODO(bake-debug): remove after feedback-loop root-caused.
  // Bake-scoped diagnostic state for the EXTERNAL-RENDER detector. `baking`
  // (declared further down) flips true while a bake owns the renderer; the
  // monkey-patched `render` below logs the first competing call per bake.
  let _bakeExternalRenderLogged = false;
  let _bakeGuardBlocks = 0;
  if (_bakeDbgScene) {
    const origRender = renderer.render.bind(renderer);
    renderer.render = ((sc: THREE.Object3D, cam: THREE.Camera) => {
      // `baking` is hoisted (function-scoped `let` below); read lazily.
      if (_sceneBaking && sc === scene) {
        if (!_bakeExternalRenderLogged) {
          _bakeExternalRenderLogged = true;
          // eslint-disable-next-line no-console
          console.error(
            "[bake-feedback] EXTERNAL RENDER during bake (main scene) from: " +
              (new Error().stack ?? "(no stack)"),
          );
        }
        // Do NOT suppress — render anyway so causation is confirmed by the
        // GL feedback-loop spam appearing right after this log line.
      }
      return origRender(sc as THREE.Scene, cam as THREE.PerspectiveCamera);
    }) as typeof renderer.render;
  }
  // Mirror of `baking` readable by the patched render above (set/reset in
  // runBake). TODO(bake-debug): remove with the rest of this block.
  let _sceneBaking = false;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(0, 0, 3.5);
  camera.lookAt(0, 0, 0);

  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(2, 1.5, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(hexToColor(colors.secondary).getHex(), 0.25);
  fill.position.set(-2, -1, -2);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0x404040, 0.5));

  // Starfield backdrop — slow rotation + per-star twinkle. Sits at render
  // order -10 so it never z-fights the globe.
  const starfield: StarfieldHandle = createStarfield();
  scene.add(starfield.object);

  // Invisible unit sphere — sole purpose is raycast hit-testing for the painter.
  // Slightly inside the cell radius so we don't catch point-cloud sprites first.
  const raycastTarget = new THREE.Mesh(
    new THREE.SphereGeometry(0.999, 64, 32),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  raycastTarget.name = "painter-target";
  scene.add(raycastTarget);

  let currentGlobe: THREE.Object3D | null = null;

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 8;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.8;
  // v0.2 painter binding: left mouse free for paint, right rotates, middle zooms.
  controls.mouseButtons = {
    LEFT:   null as unknown as THREE.MOUSE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT:  THREE.MOUSE.ROTATE,
  };

  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      const w = Math.max(1, Math.floor(width));
      const h = Math.max(1, Math.floor(height));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  });
  ro.observe(canvas);

  let raf = 0;
  let prevTime = performance.now();
  // True while a bake owns the renderer; the tick must not reschedule
  // itself (and a stray in-flight tick must not render) until resumed.
  let baking = false;
  // Monotonic loop epoch. Each `tick` captures the epoch it was scheduled
  // under; `runBake` bumps the epoch so ANY callback queued before the
  // bake started (or that somehow slipped through) is provably inert when
  // it finally fires — it neither renders nor reschedules. This makes the
  // suspension robust across the Phase-1 `await yieldToLoop()` macrotask
  // gaps: the render loop cannot touch the renderer while bake RTs are
  // bound, independent of rAF/cancel timing races.
  let loopEpoch = 0;
  const scheduleTick = () => {
    const myEpoch = loopEpoch;
    raf = requestAnimationFrame(() => {
      // Drop if a bake is running or this callback belongs to a
      // superseded epoch (cancelled/replaced loop generation).
      if (baking || myEpoch !== loopEpoch) {
        // TODO(bake-debug): remove after feedback-loop root-caused.
        // Count how often the rAF tick was correctly suppressed during a
        // bake — proves the loopEpoch/baking guard is actually engaging
        // (vs. the competing render coming from a NON-rAF path).
        if (_bakeDbgScene && baking) _bakeGuardBlocks++;
        return;
      }
      const now = performance.now();
      const dt = Math.min(0.1, (now - prevTime) / 1000);
      prevTime = now;
      starfield.tick(dt);
      controls.update();
      renderer.render(scene, camera);
      scheduleTick();
    });
  };
  scheduleTick();

  return {
    renderer,
    scene,
    camera,
    controls,
    canvas,
    raycastTarget,
    setGlobe(object) {
      if (currentGlobe) {
        scene.remove(currentGlobe);
        if ((currentGlobe as THREE.Mesh).geometry) (currentGlobe as THREE.Mesh).geometry.dispose();
        const mat = (currentGlobe as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      }
      currentGlobe = object;
      if (object) scene.add(object);
    },
    async runBake(fn) {
      // Pause the live loop: flag the tick, bump the epoch (so any
      // callback already queued under the old epoch is inert when it
      // fires — it won't render or reschedule even across the bake's
      // `await yieldToLoop()` macrotask gaps), and cancel the pending
      // frame. With the epoch guard the render loop provably cannot
      // render the globe while bake render targets are bound.
      baking = true;
      loopEpoch++;
      cancelAnimationFrame(raf);
      // TODO(bake-debug): remove after feedback-loop root-caused. Mirror
      // `baking` for the patched render + reset per-bake diagnostics.
      _sceneBaking = true;
      _bakeExternalRenderLogged = false;
      _bakeGuardBlocks = 0;
      try {
        await fn(renderer);
      } finally {
        // Resume "bake-then-watch": reset prevTime so the first resumed
        // frame's dt is a normal step (not a multi-second spike), bump
        // the epoch again so the resumed loop is the sole live
        // generation, then re-arm a single fresh tick.
        baking = false;
        loopEpoch++;
        prevTime = performance.now();
        scheduleTick();
        // TODO(bake-debug): remove after feedback-loop root-caused.
        // Per-bake summary — ALWAYS prints once so the user has a
        // definitive line whether or not a competing render fired:
        //  - externalRender=NO  → no main-scene render slipped through;
        //    the GL feedback spam (if any) is a true intra-bake texture
        //    self-alias → look for [bake-feedback] SELF-ALIAS lines.
        //  - externalRender=YES → a competing render fired; the stack
        //    above names the trigger (rAF/controls/resize/React).
        // guardBlocks counts rAF ticks correctly suppressed during the
        // bake (proves the loopEpoch/baking guard engaged).
        if (_bakeDbgScene) {
          _sceneBaking = false;
          // eslint-disable-next-line no-console
          console.error(
            `[bake-feedback] bake summary: externalRender=` +
              `${_bakeExternalRenderLogged ? "YES" : "NO"} ` +
              `rafGuardBlocks=${_bakeGuardBlocks}`,
          );
        }
      }
    },
    dispose() {
      // Bump the epoch so any in-flight rAF callback is inert, then
      // cancel the pending frame.
      loopEpoch++;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      starfield.dispose();
      renderer.dispose();
    },
  };
}
