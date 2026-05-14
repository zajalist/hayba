import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import Viewport from "./viewport/Viewport";
import type { SceneHandle } from "./viewport/scene";
import { buildGlobe, PLATE_PALETTE, type GlobeHandle } from "./viewport/globe";
import { attachPainter, type PainterHandle } from "./viewport/painter";
import StatusBar, { Mono } from "./components/StatusBar";
import SettingsModal from "./components/SettingsModal";
import DockToolbar, { type ToolName } from "./components/DockToolbar";
import TopMenuBar from "./components/TopMenuBar";
import RecenterButton from "./components/RecenterButton";
import ConfirmDialog from "./components/ConfirmDialog";
import { createDefaultDraft, type WizardDraft, type PresetName } from "./wizard/state";
import { buildCellKdTree, cellsWithinRadius, type KdTree } from "./wizard/kdtree";

export interface PlanetSnapshot {
  divisions: number;
  n_cells: number;
  sim_time_ma: number;
  cell_positions: number[];
  cell_plate_ids: number[];
  cell_elevation: number[];
  cell_continental: number[];
  cell_is_boundary: number[];
}

interface WizardInit {
  divisions: number;
  n_cells: number;
  cell_positions: number[];
}

type Mode = "wizard" | "baking" | "viewing";

const INITIAL_DIVISIONS = 64;
const TOP_HEIGHT = 32 + 28; // menu strip + tab strip
const BOTTOM_HEIGHT = 28;

function angularToChord(rad: number): number {
  return 2 * Math.sin(rad / 2);
}

export default function App() {
  const sceneRef = useRef<SceneHandle | null>(null);
  const globeRef = useRef<GlobeHandle | null>(null);
  const painterRef = useRef<PainterHandle | null>(null);
  const kdTreeRef = useRef<KdTree | null>(null);
  const cellCountRef = useRef(0);

  const draftRef = useRef<WizardDraft | null>(null);
  const activeToolRef = useRef<ToolName>("brush");
  const previewRef = useRef<number[]>([]);

  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [mode, setMode] = useState<Mode>("wizard");
  const [snapshot, setSnapshot] = useState<PlanetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ToolName>("brush");
  const [pendingDivisions, setPendingDivisions] = useState<number | null>(null);

  useEffect(() => {
    activeToolRef.current = activeTool;
    const scene = sceneRef.current;
    if (!scene) return;
    const c = scene.controls;
    if (activeTool === "rotate") {
      c.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      c.enablePan = false;
    } else if (activeTool === "zoom") {
      c.mouseButtons = { LEFT: THREE.MOUSE.DOLLY, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      c.enablePan = false;
    } else if (activeTool === "pan") {
      c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      c.enablePan = true;
    } else {
      c.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      c.enablePan = false;
    }
  }, [activeTool]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if      (k === "b") setActiveTool("brush");
      else if (k === "e") setActiveTool("erase");
      else if (k === "r") setActiveTool("rotate");
      else if (k === "z") setActiveTool("zoom");
      else if (k === "p") setActiveTool("pan");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const initWizard = useCallback(async (
    divisions: number,
    carry?: { preset?: PresetName; seed?: number },
  ) => {
    const init = await invoke<WizardInit>("start_wizard", { divisions });
    const positions = new Float32Array(init.cell_positions);
    kdTreeRef.current = buildCellKdTree(positions);
    cellCountRef.current = init.n_cells;

    const seed = carry?.seed ?? await invoke<number>("roll_seed");
    const fresh = createDefaultDraft(divisions, seed);
    if (carry?.preset) fresh.preset = carry.preset;

    setDraft(fresh);
    draftRef.current = fresh;

    const scene = sceneRef.current;
    if (scene) {
      const globe = buildGlobe(positions);
      globeRef.current = globe;
      scene.setGlobe(globe.object);
      globe.recolorFromDraft(fresh, init.n_cells);
    }
  }, []);

  const handleSceneReady = useCallback((handle: SceneHandle) => {
    sceneRef.current = handle;

    painterRef.current = attachPainter({
      canvas: handle.canvas,
      camera: handle.camera,
      target: handle.raycastTarget,
      isActive: () => {
        const t = activeToolRef.current;
        return !!draftRef.current && (t === "brush" || t === "erase");
      },
      onHover: (x, y, z) => {
        const tree = kdTreeRef.current;
        const drft = draftRef.current;
        if (!tree || !drft) return;
        const t = activeToolRef.current;
        if (t !== "brush" && t !== "erase") {
          if (previewRef.current.length === 0) return;
          previewRef.current = [];
          globeRef.current?.recolorFromDraft(drft, cellCountRef.current);
          return;
        }
        const chord = angularToChord(drft.brush_radius_rad);
        previewRef.current = cellsWithinRadius(tree, x, y, z, chord);
        globeRef.current?.recolorFromDraft(
          drft,
          cellCountRef.current,
          previewRef.current,
          t === "erase" ? "erase" : "paint",
        );
      },
      onHoverEnd: () => {
        if (previewRef.current.length === 0) return;
        previewRef.current = [];
        const drft = draftRef.current;
        if (drft) globeRef.current?.recolorFromDraft(drft, cellCountRef.current);
      },
      onPaint: (x, y, z) => {
        const tree = kdTreeRef.current;
        const drft = draftRef.current;
        if (!tree || !drft) return;
        const t = activeToolRef.current;
        if (t !== "brush" && t !== "erase") return;
        const chord = angularToChord(drft.brush_radius_rad);
        const hits = cellsWithinRadius(tree, x, y, z, chord);
        if (hits.length === 0) return;

        const seen = new Set(drft.continental_cells);
        let mutated = false;
        if (t === "brush") {
          for (const c of hits) if (!seen.has(c)) { seen.add(c); mutated = true; }
        } else {
          for (const c of hits) if (seen.delete(c)) mutated = true;
        }
        if (!mutated) return;
        const next: WizardDraft = { ...drft, continental_cells: Array.from(seen) };
        draftRef.current = next;
        setDraft(next);
        previewRef.current = hits;
        globeRef.current?.recolorFromDraft(
          next,
          cellCountRef.current,
          previewRef.current,
          t === "erase" ? "erase" : "paint",
        );
      },
    });

    initWizard(INITIAL_DIVISIONS).catch((e) => setError(String(e)));
  }, [initWizard]);

  useEffect(() => { draftRef.current = draft; }, [draft]);

  const handleChangeDivisions = useCallback((divisions: number) => {
    const d = draftRef.current;
    if (!d || divisions === d.divisions) return;
    if (d.continental_cells.length > 0) {
      setPendingDivisions(divisions);
      return;
    }
    initWizard(divisions, { preset: d.preset, seed: d.seed }).catch((e) => setError(String(e)));
  }, [initWizard]);

  const confirmChangeDivisions = useCallback(() => {
    const divisions = pendingDivisions;
    if (divisions == null) return;
    setPendingDivisions(null);
    const d = draftRef.current;
    initWizard(divisions, { preset: d?.preset, seed: d?.seed }).catch((e) => setError(String(e)));
  }, [pendingDivisions, initWizard]);

  const cancelChangeDivisions = useCallback(() => setPendingDivisions(null), []);

  const handleChangePreset = useCallback((preset: PresetName) => {
    if (!draft) return;
    const next = { ...draft, preset };
    setDraft(next);
    draftRef.current = next;
  }, [draft]);

  const handleChangeBrushRadius = useCallback((rad: number) => {
    if (!draft) return;
    const next = { ...draft, brush_radius_rad: rad };
    setDraft(next);
    draftRef.current = next;
  }, [draft]);

  const handleReroll = useCallback(async () => {
    try {
      const seed = await invoke<number>("roll_seed");
      if (!draft) return;
      const next: WizardDraft = { ...draft, seed };
      setDraft(next);
      draftRef.current = next;
    } catch (e) {
      setError(String(e));
    }
  }, [draft]);

  const handleBake = useCallback(async () => {
    if (!draft) return;
    setMode("baking");
    try {
      const snap = await invoke<PlanetSnapshot>("bake_from_wizard", { draft });
      setSnapshot(snap);
      setMode("viewing");
      globeRef.current?.recolorFromSnapshot(snap, PLATE_PALETTE);
    } catch (e) {
      setError(String(e));
      setMode("wizard");
    }
  }, [draft]);

  const handleEditWizard = useCallback(() => {
    setMode("wizard");
    if (draft) globeRef.current?.recolorFromDraft(draft, cellCountRef.current);
  }, [draft]);

  const statusLabel =
    mode === "wizard" ? activeTool :
    mode === "baking" ? "baking" :
    error ? "error" : "ready";

  const statusBody =
    mode === "wizard" && draft ? (
      <>{draft.preset} · <Mono>{cellCountRef.current.toLocaleString()}</Mono> cells · <Mono>{draft.continental_cells.length.toLocaleString()}</Mono> painted</>
    ) : mode === "wizard" ? "Loading…"
    : mode === "baking" ? "Running tectonic step loop…"
    : snapshot ? <>
      planet baked · <Mono>{snapshot.n_cells.toLocaleString()}</Mono> cells · <Mono>{snapshot.sim_time_ma.toFixed(1)}</Mono> Ma
    </> : "—";

  const showWizard = mode === "wizard";
  const getScene = useCallback(() => sceneRef.current, []);

  return (
    <>
      <div style={{
        position: "fixed",
        top: TOP_HEIGHT,
        bottom: BOTTOM_HEIGHT,
        left: 0,
        right: 0,
      }}>
        <Viewport onReady={handleSceneReady} />
      </div>

      <TopMenuBar documentTitle={mode === "viewing" ? "Planet (baked)" : "Untitled"} />

      {showWizard && draft && (
        <DockToolbar
          active={activeTool}
          onChange={setActiveTool}
          brushRadius={draft.brush_radius_rad}
          onChangeBrushRadius={handleChangeBrushRadius}
        />
      )}

      {showWizard && draft && (
        <SettingsModal
          draft={draft}
          busy={false}
          topOffset={TOP_HEIGHT}
          onChangeDivisions={handleChangeDivisions}
          onChangePreset={handleChangePreset}
          onReroll={handleReroll}
          onBake={handleBake}
        />
      )}

      <RecenterButton getScene={getScene} />

      {mode === "viewing" && (
        <button
          type="button"
          onClick={handleEditWizard}
          style={{
            position: "fixed",
            top: TOP_HEIGHT + 22,
            right: 22,
            zIndex: 60,
            background: "rgba(34, 38, 46, 0.92)",
            border: "1px solid #2f343d",
            borderRadius: "3px",
            color: "#B56A1D",
            fontFamily: '"Segoe UI", "Noto Sans", system-ui, sans-serif',
            fontSize: 10,
            letterSpacing: "0.32em",
            textTransform: "uppercase",
            padding: "8px 14px",
            cursor: "pointer",
            fontWeight: 600,
            backdropFilter: "blur(10px)",
          }}
        >
          Edit wizard →
        </button>
      )}

      <StatusBar
        state={mode === "baking" ? "baking" : error ? "error" : mode === "viewing" ? "ready" : "idle"}
        label={statusLabel}
      >
        {error ? `Error: ${error}` : statusBody}
      </StatusBar>

      <ConfirmDialog
        open={pendingDivisions !== null}
        title="Change detail level?"
        body={
          <>
            Switching resolution rebuilds the planet's icosphere at a different cell count.
            Your <strong style={{ color: "#B56A1D" }}>{draft?.continental_cells.length.toLocaleString() ?? 0} painted cells</strong> will be wiped — there's no way to map them across resolutions.
          </>
        }
        confirmLabel="change & wipe"
        cancelLabel="keep current"
        destructive
        onConfirm={confirmChangeDivisions}
        onCancel={cancelChangeDivisions}
      />
    </>
  );
}
