import * as THREE from "three";
import type { PlanetSnapshot } from "../../App";

export interface PoleLabelsHandle {
  group: THREE.Group;
  setVisible: (v: boolean) => void;
  /** Re-evaluate occlusion against the current snapshot's plate centroids. */
  update: (snap: PlanetSnapshot) => void;
  dispose: () => void;
}

/** Build N / S pole sprite labels. Auto-hides each label when a plate label
 *  is rendered too close to that pole (angular separation < SUPPRESS_RAD)
 *  so the two don't overlap. */
export function buildPoleLabels(): PoleLabelsHandle {
  const group = new THREE.Group();
  group.renderOrder = 11;
  group.name = "pole-labels";

  const make = (text: string): THREE.Sprite => {
    const canvas = document.createElement("canvas");
    const SIZE = 128;
    canvas.width = SIZE; canvas.height = SIZE;
    const ctx = canvas.getContext("2d")!;
    const cx = SIZE / 2, cy = SIZE / 2;
    const r  = SIZE * 0.40;
    // Subtle radial fill so the label reads against any planet color.
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0,   "rgba(40, 44, 52, 0.88)");
    grad.addColorStop(1,   "rgba(20, 22, 28, 0.92)");
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(222, 212, 195, 0.85)";   // beige edge
    ctx.stroke();
    ctx.font = "600 56px Segoe UI, Noto Sans, system-ui, sans-serif";
    ctx.fillStyle = "#DED4C3";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cx, cy + 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.10, 0.10, 1);
    return sprite;
  };

  const NORTH_POS = new THREE.Vector3(0,  1.14, 0);
  const SOUTH_POS = new THREE.Vector3(0, -1.14, 0);
  // ~14° great-circle radius. If a plate's centroid is within this of the
  // pole, suppress the pole label (the plate-number label is already there).
  const SUPPRESS_DOT = Math.cos(THREE.MathUtils.degToRad(14));

  const n = make("N");
  n.position.copy(NORTH_POS);
  const s = make("S");
  s.position.copy(SOUTH_POS);
  group.add(n);
  group.add(s);

  const update = (snap: PlanetSnapshot) => {
    // Compute plate centroids on the unit sphere.
    const sums = new Map<number, [number, number, number, number]>();
    for (let i = 0; i < snap.cell_plate_ids.length; i++) {
      const pid = snap.cell_plate_ids[i];
      if (pid < 0) continue;
      const x = snap.cell_positions[i * 3 + 0];
      const y = snap.cell_positions[i * 3 + 1];
      const z = snap.cell_positions[i * 3 + 2];
      const cur = sums.get(pid) ?? [0, 0, 0, 0];
      cur[0] += x; cur[1] += y; cur[2] += z; cur[3] += 1;
      sums.set(pid, cur);
    }

    let nearNorth = false;
    let nearSouth = false;
    const up = new THREE.Vector3(0, 1, 0);
    const dn = new THREE.Vector3(0, -1, 0);
    for (const [, [x, y, z, c]] of sums) {
      if (c === 0) continue;
      const v = new THREE.Vector3(x / c, y / c, z / c).normalize();
      if (v.dot(up) >= SUPPRESS_DOT) nearNorth = true;
      if (v.dot(dn) >= SUPPRESS_DOT) nearSouth = true;
    }
    n.visible = !nearNorth;
    s.visible = !nearSouth;
  };

  return {
    group,
    setVisible: (v) => { group.visible = v; },
    update,
    dispose: () => {
      for (const sprite of [n, s]) {
        const mat = sprite.material as THREE.SpriteMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
      group.clear();
    },
  };
}
