import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Viewport from "./viewport/Viewport";
import type { SceneHandle } from "./viewport/scene";
import { buildGlobeMesh } from "./viewport/globe";

export interface PlanetSnapshot {
  divisions: number;
  n_cells: number;
  sim_time_ma: number;
  cell_positions: number[];
  cell_plate_ids: number[];
  cell_elevation: number[];
  cell_continental: number[];
}

export default function App() {
  const sceneRef = useRef<SceneHandle | null>(null);
  const [snapshot, setSnapshot] = useState<PlanetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSceneReady = useCallback((handle: SceneHandle) => {
    sceneRef.current = handle;
  }, []);

  useEffect(() => {
    invoke<PlanetSnapshot>("bake_demo_planet")
      .then(setSnapshot)
      .catch((e) => setError(String(e)));
  }, []);

  // When both the scene and the snapshot are ready, swap the placeholder
  // sphere for the real point-cloud globe. Runs once per snapshot change.
  useEffect(() => {
    if (!sceneRef.current || !snapshot) return;
    const mesh = buildGlobeMesh(snapshot);
    sceneRef.current.setGlobe(mesh);
  }, [snapshot]);

  return (
    <>
      <Viewport onReady={handleSceneReady} />
      {error && (
        <div style={{ position: "fixed", top: 8, left: 8, color: "#d77f24", fontSize: 12 }}>
          error: {error}
        </div>
      )}
      {snapshot && (
        <div style={{ position: "fixed", top: 8, left: 8, color: "#a8aeb8", fontSize: 12 }}>
          planet ready — n_cells={snapshot.n_cells}, sim_time_ma={snapshot.sim_time_ma.toFixed(1)}
        </div>
      )}
    </>
  );
}
