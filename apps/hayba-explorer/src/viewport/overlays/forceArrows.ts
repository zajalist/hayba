import * as THREE from "three";
import type { PlanetSnapshot } from "../../App";

export interface ForceArrowsHandle {
  group: THREE.Group;
  setVisible: (v: boolean) => void;
  /** snap = current snapshot, omegas = Euler-pole angular velocities per plate id. */
  update: (snap: PlanetSnapshot, omegas: Map<number, THREE.Vector3>) => void;
  dispose: () => void;
}

const ARROW_SCALE = 0.35;
const ARROW_MIN   = 0.02;
const ARROW_MAX   = 0.20;

export function buildForceArrows(): ForceArrowsHandle {
  const group = new THREE.Group();
  group.renderOrder = 11;
  const arrows: THREE.ArrowHelper[] = [];
  const beige = new THREE.Color("#DED4C3");

  const update = (snap: PlanetSnapshot, omegas: Map<number, THREE.Vector3>) => {
    for (const a of arrows) {
      group.remove(a);
      a.dispose();
    }
    arrows.length = 0;

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
      const omega = omegas.get(pid);
      if (!omega) continue;
      const origin = new THREE.Vector3(x / n, y / n, z / n).normalize().multiplyScalar(1.02);
      // Instantaneous linear velocity at centroid: v = omega × r
      const v = new THREE.Vector3().crossVectors(omega, origin);
      const len = THREE.MathUtils.clamp(v.length() * ARROW_SCALE, ARROW_MIN, ARROW_MAX);
      if (len <= 1e-4) continue;
      v.normalize();
      const arrow = new THREE.ArrowHelper(v, origin, len, beige.getHex(), len * 0.4, len * 0.25);
      group.add(arrow);
      arrows.push(arrow);
    }
  };

  return {
    group,
    setVisible: (v) => { group.visible = v; },
    update,
    dispose: () => {
      for (const a of arrows) a.dispose();
      group.clear();
    },
  };
}
