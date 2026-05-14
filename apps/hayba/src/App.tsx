import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Viewport from "./viewport/Viewport";
import type { SceneHandle } from "./viewport/scene";
import { buildGlobeMesh } from "./viewport/globe";
import StatusBar, { Mono } from "./components/StatusBar";

export interface PlanetSnapshot {
  divisions: number;
  n_cells: number;
  sim_time_ma: number;
  cell_positions: number[];
  cell_plate_ids: number[];
  cell_elevation: number[];
  cell_continental: number[];
}

type Status = "idle" | "baking" | "ready" | "error";

export default function App() {
  const sceneRef = useRef<SceneHandle | null>(null);
  const [snapshot, setSnapshot] = useState<PlanetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  const handleSceneReady = useCallback((handle: SceneHandle) => {
    sceneRef.current = handle;
  }, []);

  useEffect(() => {
    setStatus("baking");
    invoke<PlanetSnapshot>("bake_demo_planet")
      .then((snap) => {
        setSnapshot(snap);
        setStatus("ready");
      })
      .catch((e) => {
        setError(String(e));
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    if (!sceneRef.current || !snapshot) return;
    const mesh = buildGlobeMesh(snapshot);
    sceneRef.current.setGlobe(mesh);
  }, [snapshot]);

  const label =
    status === "ready" ? "ready" :
    status === "baking" ? "baking" :
    status === "error" ? "error" :
    "idle";

  const body =
    status === "baking" ? "Baking demo planet…" :
    status === "ready" && snapshot ? (
      <>
        demo planet · <Mono>{snapshot.n_cells.toLocaleString()}</Mono> cells · <Mono>{snapshot.sim_time_ma.toFixed(1)}</Mono> Ma
      </>
    ) : status === "error" ? error ?? "Unknown error" :
    "Waiting";

  return (
    <>
      <Viewport onReady={handleSceneReady} />
      <StatusBar state={status} label={label}>{body}</StatusBar>
    </>
  );
}
