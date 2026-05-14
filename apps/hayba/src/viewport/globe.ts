import * as THREE from "three";
import type { PlanetSnapshot } from "../App";

// v0.1 globe: a point cloud, one point per peels cell, colored by
// continental flag. Triangulated Voronoi mesh + shaded material lands in
// v0.2 — for now this proves data flow and is enough for the
// "Hello Planet" milestone.

const CONTINENT_COLOR: [number, number, number] = [0.71, 0.42, 0.11]; // #B56A1D (accent)
const OCEAN_COLOR:     [number, number, number] = [0.13, 0.21, 0.34]; // deep slate-blue

export function buildGlobeMesh(snapshot: PlanetSnapshot): THREE.Object3D {
  const n = snapshot.n_cells;
  const positions = new Float32Array(snapshot.cell_positions);
  const colors = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    const isContinent = snapshot.cell_continental[i] === 1;
    const c = isContinent ? CONTINENT_COLOR : OCEAN_COLOR;
    colors[3 * i + 0] = c[0];
    colors[3 * i + 1] = c[1];
    colors[3 * i + 2] = c[2];
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    vertexColors: true,
    size: 0.018,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geo, mat);
  points.name = "hayba-globe";
  return points;
}
