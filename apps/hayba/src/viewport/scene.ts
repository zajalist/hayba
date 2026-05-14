import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { colors } from "@hayba/design-tokens";

export interface SceneHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  dispose: () => void;
  /** Replace the current globe with a new mesh / points object. */
  setGlobe: (object: THREE.Object3D | null) => void;
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

  // Lights — keyed warm + cool fill, evoking the Hayba palette without
  // shouting through. Materials we ship later can be tuned against these.
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(2, 1.5, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(hexToColor(colors.secondary).getHex(), 0.25);
  fill.position.set(-2, -1, -2);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0x404040, 0.5));

  // Placeholder while the real globe loads.
  const placeholder = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.8 }),
  );
  scene.add(placeholder);

  let currentGlobe: THREE.Object3D | null = placeholder;

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 8;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.8;

  // Resize handling — driven by parent observer rather than window resize so
  // the canvas tracks the viewport container precisely.
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
  const tick = () => {
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
    setGlobe(object) {
      if (currentGlobe) {
        scene.remove(currentGlobe);
        // Best-effort cleanup. v0.1 swap is one-shot so leaks are bounded.
        if ((currentGlobe as THREE.Mesh).geometry) (currentGlobe as THREE.Mesh).geometry.dispose();
        const mat = (currentGlobe as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      }
      currentGlobe = object;
      if (object) scene.add(object);
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
    },
  };
}
