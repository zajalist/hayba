import * as THREE from "three";

export interface PainterOptions {
  canvas: HTMLCanvasElement;
  camera: THREE.PerspectiveCamera;
  target: THREE.Object3D;
  /** Stamped paint while the left mouse is held. */
  onPaint: (x: number, y: number, z: number) => void;
  /** Hover-preview fires on every move (regardless of buttons). */
  onHover?: (x: number, y: number, z: number) => void;
  /** Pointer left the canvas or window. */
  onHoverEnd?: () => void;
  /** Returning false suppresses paint (not hover). */
  isActive?: () => boolean;
}

export interface PainterHandle {
  detach: () => void;
}

/**
 * Wires left-mouse painting and hover preview on a hidden raycast target.
 * - pointermove fires both onHover (always) and onPaint (when button 0 held).
 * - Both callbacks are throttled to one per animation frame.
 * - OrbitControls is expected to have rebound rotation to right-mouse.
 */
export function attachPainter(opts: PainterOptions): PainterHandle {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let painting = false;
  let pendingPaint: THREE.Vector3 | null = null;
  let pendingHover: THREE.Vector3 | null = null;
  let raf = 0;

  const flush = () => {
    raf = 0;
    if (pendingHover && opts.onHover) {
      opts.onHover(pendingHover.x, pendingHover.y, pendingHover.z);
    }
    pendingHover = null;
    if (pendingPaint) {
      opts.onPaint(pendingPaint.x, pendingPaint.y, pendingPaint.z);
      pendingPaint = null;
    }
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
    pendingPaint = p;
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const onMove = (ev: PointerEvent) => {
    const p = project(ev);
    if (!p) return;
    pendingHover = p;
    if (painting) pendingPaint = p;
    if (!raf) raf = requestAnimationFrame(flush);
  };
  const onUp = (ev: PointerEvent) => {
    if (!painting) return;
    painting = false;
    opts.canvas.releasePointerCapture(ev.pointerId);
    if (pendingPaint && !raf) raf = requestAnimationFrame(flush);
  };
  const onLeave = () => {
    pendingHover = null;
    if (opts.onHoverEnd) opts.onHoverEnd();
  };
  const onCtx = (ev: Event) => ev.preventDefault();

  opts.canvas.addEventListener("pointerdown", onDown);
  opts.canvas.addEventListener("pointermove", onMove);
  opts.canvas.addEventListener("pointerup", onUp);
  opts.canvas.addEventListener("pointercancel", onUp);
  opts.canvas.addEventListener("pointerleave", onLeave);
  opts.canvas.addEventListener("contextmenu", onCtx);

  return {
    detach() {
      opts.canvas.removeEventListener("pointerdown", onDown);
      opts.canvas.removeEventListener("pointermove", onMove);
      opts.canvas.removeEventListener("pointerup", onUp);
      opts.canvas.removeEventListener("pointercancel", onUp);
      opts.canvas.removeEventListener("pointerleave", onLeave);
      opts.canvas.removeEventListener("contextmenu", onCtx);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
