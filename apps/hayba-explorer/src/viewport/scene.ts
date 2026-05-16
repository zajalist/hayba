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

export function createScene(canvas: HTMLCanvasElement): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(hexToColor(colors.bgDeep), 1.0);

  const scene = new THREE.Scene();

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
  const tick = () => {
    if (baking) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - prevTime) / 1000);
    prevTime = now;
    starfield.tick(dt);
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

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
      // Pause the live loop: cancel the pending frame and flag the tick
      // so any already-queued callback returns without rendering.
      baking = true;
      cancelAnimationFrame(raf);
      try {
        await fn(renderer);
      } finally {
        // Resume exactly as before. Reset prevTime so the first resumed
        // frame's dt is a normal step, not a multi-second spike.
        baking = false;
        prevTime = performance.now();
        raf = requestAnimationFrame(tick);
      }
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      starfield.dispose();
      renderer.dispose();
    },
  };
}
