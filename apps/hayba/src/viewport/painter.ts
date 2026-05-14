import * as THREE from "three";

export interface PainterOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  target: THREE.Object3D;
  onPaint: (x: number, y: number, z: number) => void;
  /** Returning false suppresses paint (e.g. no active plate). */
  isActive?: () => boolean;
}

export interface PainterHandle {
  detach: () => void;
}

/**
 * Wires left-mouse-button painting on a hidden raycast target. Drag = stream
 * of paint events throttled to one per animation frame (~60Hz). OrbitControls
 * is expected to have already rebound rotation to the right mouse button.
 */
export function attachPainter(opts: PainterOptions): PainterHandle {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let painting = false;
  let pendingPoint: THREE.Vector3 | null = null;
  let raf = 0;

  const flush = () => {
    raf = 0;
    if (!pendingPoint) return;
    opts.onPaint(pendingPoint.x, pendingPoint.y, pendingPoint.z);
    pendingPoint = null;
  };

  const project = (ev: PointerEvent): THREE.Vector3 | null => {
    const rect = opts.canvas.getBoundingClientRect();
    ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -(((ev.clientY - rect.top) / rect.height) * 2 - 1);
    raycaster.setFromCamera(ndc, opts.camera);
    const hits = raycaster.intersectObject(opts.target, false);
    if (hits.length === 0) return null;
    return hits[0].point.clone().normalize();
  };

  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0) return;
    if (opts.isActive && !opts.isActive()) return;
    const p = project(ev);
    if (!p) return;
    painting = true;
    opts.canvas.setPointerCapture(ev.pointerId);
    pendingPoint = p;
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const onMove = (ev: PointerEvent) => {
    if (!painting) return;
    const p = project(ev);
    if (!p) return;
    pendingPoint = p;
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const onUp = (ev: PointerEvent) => {
    if (!painting) return;
    painting = false;
    opts.canvas.releasePointerCapture(ev.pointerId);
    if (pendingPoint && !raf) raf = requestAnimationFrame(flush);
  };

  opts.canvas.addEventListener("pointerdown", onDown);
  opts.canvas.addEventListener("pointermove", onMove);
  opts.canvas.addEventListener("pointerup", onUp);
  opts.canvas.addEventListener("pointercancel", onUp);
  // Suppress browser context menu so right-click-drag rotates cleanly.
  const onCtx = (ev: Event) => ev.preventDefault();
  opts.canvas.addEventListener("contextmenu", onCtx);

  return {
    detach() {
      opts.canvas.removeEventListener("pointerdown", onDown);
      opts.canvas.removeEventListener("pointermove", onMove);
      opts.canvas.removeEventListener("pointerup", onUp);
      opts.canvas.removeEventListener("pointercancel", onUp);
      opts.canvas.removeEventListener("contextmenu", onCtx);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
