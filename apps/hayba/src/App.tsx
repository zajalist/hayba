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
import BoundaryPopover from "./components/BoundaryPopover";
import PhaseStrip from "./components/PhaseStrip";
import PhaseSteps, { type PhaseStepId } from "./components/PhaseSteps";
import { createDefaultDraft, pairKey, type WizardDraft, type PresetName, type BoundaryType } from "./wizard/state";
import { BoundaryModel, setBoundary, clearBoundary } from "./wizard/boundary-model";
import { buildCellKdTree, cellsWithinRadius, nearestCell, type KdTree } from "./wizard/kdtree";

export interface PlanetSnapshot {
  divisions: number;
  n_cells: number;
  sim_time_ma: number;
  cell_positions: number[];
  cell_plate_ids: number[];
  cell_elevation: number[];
  cell_continental: number[];
  cell_is_boundary: number[];
  cell_neighbor_plate: number[];
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

/** Map (mode, playing) → current phase-step pill in the bottom bar. */
function currentPhaseStep(mode: Mode, playing: boolean): PhaseStepId {
  if (mode === "wizard" || mode === "baking") return "compose";
  return playing ? "animate" : "boundaries";
}

/** Mirrors hayba_tectonics_v2::time::era_for_ma. */
function eraForMa(ma: number): string {
  if (ma < 0.0117) return "Holocene";
  if (ma < 2.58)   return "Pleistocene";
  if (ma < 5.333)  return "Pliocene";
  if (ma < 23.03)  return "Miocene";
  if (ma < 33.9)   return "Oligocene";
  if (ma < 56.0)   return "Eocene";
  if (ma < 66.0)   return "Paleocene";
  if (ma < 145.0)  return "Cretaceous";
  if (ma < 201.4)  return "Jurassic";
  if (ma < 251.9)  return "Triassic";
  if (ma < 298.9)  return "Permian";
  if (ma < 358.9)  return "Carboniferous";
  if (ma < 419.2)  return "Devonian";
  if (ma < 443.8)  return "Silurian";
  if (ma < 485.4)  return "Ordovician";
  if (ma < 538.8)  return "Cambrian";
  return "Precambrian";
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
  // Mode mirror — read by the painter so post-bake hover doesn't repaint the
  // planet from the (now-stale) wizard draft.
  const modeRef = useRef<Mode>("wizard");
  const snapshotRef = useRef<PlanetSnapshot | null>(null);
  // Single source of truth for cell → boundary-pair mapping. Rebuilt once
  // each time a snapshot lands; read by both the click handler and the
  // globe's recolor path.
  const boundaryModelRef = useRef<BoundaryModel | null>(null);

  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [mode, setMode] = useState<Mode>("wizard");
  const [snapshot, setSnapshot] = useState<PlanetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ToolName>("brush");
  const [pendingDivisions, setPendingDivisions] = useState<number | null>(null);
  // Post-bake boundary editing — popover anchored at screen coords, with
  // the plate pair the user clicked.
  const [boundaryPopover, setBoundaryPopover] = useState<{
    screenX: number; screenY: number; plateA: number; plateB: number;
  } | null>(null);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);

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

  // Space toggles play/pause in viewing mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code !== "Space") return;
      if (modeRef.current !== "viewing") return;
      e.preventDefault();
      setPlaying((p) => !p);
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
        return modeRef.current === "wizard" && !!draftRef.current && (t === "brush" || t === "erase");
      },
      onHover: (x, y, z) => {
        // Painter is wizard-mode-only. After bake we leave the snapshot alone.
        if (modeRef.current !== "wizard") return;
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
        if (modeRef.current !== "wizard") return;
        if (previewRef.current.length === 0) return;
        previewRef.current = [];
        const drft = draftRef.current;
        if (drft) globeRef.current?.recolorFromDraft(drft, cellCountRef.current);
      },
      onPaint: (x, y, z) => {
        if (modeRef.current !== "wizard") return;
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
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  // Playback is post-bake only.
  useEffect(() => {
    if (mode !== "viewing" && playing) setPlaying(false);
  }, [mode, playing]);
  useEffect(() => {
    snapshotRef.current = snapshot;
    // Rebuild the BoundaryModel once per new snapshot.
    boundaryModelRef.current = snapshot ? BoundaryModel.fromSnapshot(snapshot) : null;
  }, [snapshot]);

  // Re-tint baked boundaries when assignments change.
  useEffect(() => {
    if (mode !== "viewing" || !snapshot || !draft) return;
    const bm = boundaryModelRef.current;
    globeRef.current?.recolorFromSnapshot(
      snapshot, PLATE_PALETTE,
      bm ? { model: bm, assignments: draft.boundary_types } : undefined,
    );
  }, [mode, snapshot, draft?.boundary_types]);

  // Animation tick — advance the Rust sim on rAF cadence while `playing`.
  // step_planet(1) per tick = dt_ma per tick, so the visual delta stays
  // gentle. Cancellation flag bridges the async gap.
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled || !playingRef.current) return;
      invoke<PlanetSnapshot>("step_planet", { nSteps: 1 })
        .then((snap) => {
          if (cancelled || !playingRef.current) return;
          setSnapshot(snap);
          const bm = BoundaryModel.fromSnapshot(snap);
          boundaryModelRef.current = bm;
          const drft = draftRef.current;
          if (drft) {
            globeRef.current?.recolorFromSnapshot(snap, PLATE_PALETTE, {
              model: bm, assignments: drft.boundary_types,
            });
          } else {
            globeRef.current?.recolorFromSnapshot(snap, PLATE_PALETTE);
          }
          if (!cancelled && playingRef.current) requestAnimationFrame(tick);
        })
        .catch((e) => {
          setPlaying(false);
          setError(String(e));
        });
    };
    requestAnimationFrame(tick);
    return () => { cancelled = true; };
  }, [playing]);

  // Post-bake boundary picking — listens to clicks on the canvas while in
  // viewing mode. Raycasts → nearest cell → if it's a boundary cell, walks
  // its neighbours to find the adjacent plate, then opens the popover at
  // the screen coords.
  useEffect(() => {
    if (mode !== "viewing") return;
    const scene = sceneRef.current;
    if (!scene) return;
    const canvas = scene.canvas;
    const onPointer = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const tree = kdTreeRef.current;
      const bm = boundaryModelRef.current;
      if (!tree || !bm) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -(((ev.clientY - rect.top) / rect.height) * 2 - 1),
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, scene.camera);
      const hits = ray.intersectObject(scene.raycastTarget, false);
      if (hits.length === 0) return;
      const p = hits[0].point.clone().normalize();
      const cell = nearestCell(tree, p.x, p.y, p.z);
      const key = bm.pairKeyForCell(cell);
      if (!key) {
        setBoundaryPopover(null);
        return;
      }
      const members = bm.membersFor(key);
      if (!members) return;
      setBoundaryPopover({
        screenX: ev.clientX,
        screenY: ev.clientY,
        plateA: members[0],
        plateB: members[1],
      });
    };
    canvas.addEventListener("pointerdown", onPointer);
    return () => canvas.removeEventListener("pointerdown", onPointer);
  }, [mode]);

  // ESC dismisses the boundary popover.
  useEffect(() => {
    if (!boundaryPopover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBoundaryPopover(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [boundaryPopover]);

  // Live-apply boundary assignments — Rust rewrites plate omegas on the
  // running model so the change is visible immediately. No re-bake.
  const applyBoundaryTypesLive = useCallback(async (types: Record<string, BoundaryType>) => {
    try {
      const snap = await invoke<PlanetSnapshot>("apply_boundary_types", { boundaryTypes: types });
      setSnapshot(snap);
      const bm = BoundaryModel.fromSnapshot(snap);
      boundaryModelRef.current = bm;
      globeRef.current?.recolorFromSnapshot(snap, PLATE_PALETTE, { model: bm, assignments: types });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleSetBoundary = useCallback((type: BoundaryType) => {
    if (!boundaryPopover || !draft) return;
    const key = pairKey(boundaryPopover.plateA, boundaryPopover.plateB);
    const nextTypes = setBoundary(draft.boundary_types, key, type);
    const next: WizardDraft = { ...draft, boundary_types: nextTypes };
    setDraft(next);
    draftRef.current = next;
    setBoundaryPopover(null);
    applyBoundaryTypesLive(nextTypes);
  }, [boundaryPopover, draft, applyBoundaryTypesLive]);

  const handleClearBoundary = useCallback(() => {
    if (!boundaryPopover || !draft) return;
    const key = pairKey(boundaryPopover.plateA, boundaryPopover.plateB);
    const nextTypes = clearBoundary(draft.boundary_types, key);
    const next: WizardDraft = { ...draft, boundary_types: nextTypes };
    setDraft(next);
    draftRef.current = next;
    setBoundaryPopover(null);
    applyBoundaryTypesLive(nextTypes);
  }, [boundaryPopover, draft, applyBoundaryTypesLive]);

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
      const bm = BoundaryModel.fromSnapshot(snap);
      boundaryModelRef.current = bm;
      globeRef.current?.recolorFromSnapshot(snap, PLATE_PALETTE, {
        model: bm, assignments: draft.boundary_types,
      });
    } catch (e) {
      setError(String(e));
      setMode("wizard");
    }
  }, [draft]);

  const handleEditWizard = useCallback(() => {
    previewRef.current = [];
    invoke("reset_sim").catch(() => {});
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
        <ViewingChrome
          topOffset={TOP_HEIGHT}
          assignedCount={Object.keys(draft?.boundary_types ?? {}).length}
          onEditWizard={handleEditWizard}
        />
      )}

      {boundaryPopover && draft && (
        <BoundaryPopover
          screenX={boundaryPopover.screenX}
          screenY={boundaryPopover.screenY}
          plateA={boundaryPopover.plateA}
          plateB={boundaryPopover.plateB}
          current={draft.boundary_types[pairKey(boundaryPopover.plateA, boundaryPopover.plateB)]}
          onPick={handleSetBoundary}
          onClear={handleClearBoundary}
          onDismiss={() => setBoundaryPopover(null)}
        />
      )}

      <StatusBar
        state={mode === "baking" ? "baking" : error ? "error" : mode === "viewing" ? "ready" : "idle"}
        label={statusLabel}
        centerSlot={
          <PhaseSteps current={currentPhaseStep(mode, playing)} />
        }
        rightSlot={mode === "viewing" && snapshot ? (
          <PhaseStrip
            simTimeMa={snapshot.sim_time_ma}
            era={eraForMa(snapshot.sim_time_ma)}
            playing={playing}
            onTogglePlay={() => setPlaying((p) => !p)}
          />
        ) : null}
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

function ViewingChrome({ topOffset, assignedCount, onEditWizard }: {
  topOffset: number;
  assignedCount: number;
  onEditWizard: () => void;
}) {
  const BEIGE = "#DED4C3";
  const baseBtn: React.CSSProperties = {
    background: "rgba(34, 38, 46, 0.92)",
    border: "1px solid #2f343d",
    borderRadius: "10px",
    color: BEIGE,
    fontFamily: '"Segoe UI", "Noto Sans", system-ui, sans-serif',
    fontSize: 12,
    letterSpacing: "0.02em",
    padding: "8px 14px",
    cursor: "pointer",
    fontWeight: 500,
    backdropFilter: "blur(10px)",
  };
  return (
    <>
      {/* Boundary editor hint banner — top center, fades the user toward
          clicking the pink seams. */}
      <div
        style={{
          position: "fixed",
          top: topOffset + 22,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 60,
          background: "rgba(34, 38, 46, 0.92)",
          border: "1px solid #2f343d",
          borderRadius: 10,
          padding: "8px 16px",
          fontSize: 12,
          color: "#a8aeb8",
          fontFamily: '"Segoe UI", "Noto Sans", system-ui, sans-serif',
          letterSpacing: "0.01em",
          backdropFilter: "blur(10px)",
          pointerEvents: "none",
        }}
      >
        Click a pink seam to set boundary type
        {assignedCount > 0 && (
          <span style={{ marginLeft: 10, color: "#B56A1D" }}>
            · {assignedCount} assigned
          </span>
        )}
      </div>

      <div style={{
        position: "fixed",
        top: topOffset + 22,
        right: 22,
        zIndex: 60,
        display: "flex",
        gap: 8,
      }}>
        <button type="button" onClick={onEditWizard} style={baseBtn}>
          Edit wizard →
        </button>
      </div>
    </>
  );
}
