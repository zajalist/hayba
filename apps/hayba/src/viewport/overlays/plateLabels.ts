import * as THREE from "three";
import type { PlanetSnapshot } from "../../App";

export interface PlateLabelsHandle {
  group: THREE.Group;
  setVisible: (v: boolean) => void;
  update: (snap: PlanetSnapshot) => void;
  dispose: () => void;
}

/** Build a sprite per plate, positioned at the plate's centroid on the unit sphere. */
export function buildPlateLabels(): PlateLabelsHandle {
  const group = new THREE.Group();
  group.renderOrder = 10;
  const sprites: THREE.Sprite[] = [];

  // Hi-res canvas for crisp 1x display; sprite scaled down in world units.
  const SIZE = 128;
  const makeSprite = (text: string): THREE.Sprite => {
    const canvas = document.createElement("canvas");
    canvas.width = SIZE; canvas.height = SIZE;
    const ctx = canvas.getContext("2d")!;
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const r  = SIZE * 0.40;

    // Slate radial gradient with a subtle top-left highlight
    const grad = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    grad.addColorStop(0.0, "rgba(70, 76, 88, 0.96)");
    grad.addColorStop(0.65, "rgba(28, 32, 40, 0.92)");
    grad.addColorStop(1.0, "rgba(18, 20, 26, 0.92)");

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Crisp white edge
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    ctx.stroke();

    // Number, white, sized to fit comfortably
    ctx.font = "bold 56px Consolas, monospace";
    ctx.fillStyle = "#FFFFFF";
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

  const update = (snap: PlanetSnapshot) => {
    for (const s of sprites) {
      group.remove(s);
      const mat = s.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
    sprites.length = 0;

    // plateId → [sumX, sumY, sumZ, count] over cells assigned to that plate
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
    for (const [pid, [x, y, z, n]] of sums) {
      if (n === 0) continue;
      const v = new THREE.Vector3(x / n, y / n, z / n).normalize().multiplyScalar(1.04);
      const sprite = makeSprite(String(pid));
      sprite.position.copy(v);
      group.add(sprite);
      sprites.push(sprite);
    }
  };

  return {
    group,
    setVisible: (v) => { group.visible = v; },
    update,
    dispose: () => {
      for (const s of sprites) {
        const mat = s.material as THREE.SpriteMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
      group.clear();
    },
  };
}
