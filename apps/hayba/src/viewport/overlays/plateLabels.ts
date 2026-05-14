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

  const makeSprite = (text: string): THREE.Sprite => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.font = "bold 36px Consolas, monospace";
    ctx.fillStyle = "#DED4C3";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 32, 32);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.08, 0.08, 1);
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
