import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Viewport from "./viewport/Viewport";
import type { SceneHandle } from "./viewport/scene";
import { buildGlobe, PLATE_PALETTE, type GlobeHandle } from "./viewport/globe";
import { attachPainter, type PainterHandle } from "./viewport/painter";
import StatusBar, { Mono } from "./components/StatusBar";
import WizardPanel from "./wizard/WizardPanel";
import { createDefaultDraft, type WizardDraft, type PresetName } from "./wizard/state";
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
}

interface WizardInit {
  divisions: number;
  n_cells: number;
  cell_positions: number[];
}

type Mode = "wizard" | "baking" | "viewing";

const INITIAL_DIVISIONS = 64;

/** Angular radius (rad) → chord on unit sphere. */
function angularToChord(rad: number): number {
  return 2 * Math.sin(rad / 2);
}

export default function App() {
  const sceneRef = useRef<SceneHandle | null>(null);
  const globeRef = useRef<GlobeHandle | null>(null);
  const painterRef = useRef<PainterHandle | null>(null);
  const kdTreeRef = useRef<KdTree | null>(null);
  const cellCountRef = useRef(0);

  // Draft lives in a ref alongside state so the painter callback always sees
  // the freshest cell set without re-attaching listeners on every paint.
  const draftRef = useRef<WizardDraft | null>(null);

  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [mode, setMode] = useState<Mode>("wizard");
  const [snapshot, setSnapshot] = useState<PlanetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Cells highlighted under the hovering brush (preview before click).
  const previewRef = useRef<number[]>([]);

  // Positions stay around so we can re-project painted cells when the user
  // switches resolution — each old painted cell becomes the nearest cell at
  // the new resolution.
  const cellPositionsRef = useRef<Float32Array | null>(null);

  const initWizard = useCallback(async (
    divisions: number,
    carry?: { preset?: PresetName; seed?: number; previousPaint?: number[]; previousPositions?: Float32Array },
  ) => {
    const init = await invoke<WizardInit>("start_wizard", { divisions });
    const positions = new Float32Array(init.cell_positions);
    const tree = buildCellKdTree(positions);
    kdTreeRef.current = tree;
    cellPositionsRef.current = positions;
    cellCountRef.current = init.n_cells;

    const seed = carry?.seed ?? await invoke<number>("roll_seed");
    const fresh = createDefaultDraft(divisions, seed);
    if (carry?.preset) fresh.preset = carry.preset;

    // Re-project old painted cells onto the new sphere. Each old cell's
    // position → nearest cell on the new resolution. De-duplicate.
    if (carry?.previousPaint && carry?.previousPositions) {
      const reprojected = new Set<number>();
      for (const oldCell of carry.previousPaint) {
        const base = oldCell * 3;
        if (base + 2 >= carry.previousPositions.length) continue;
        const cell = nearestCell(
          tree,
          carry.previousPositions[base],
          carry.previousPositions[base + 1],
          carry.previousPositions[base + 2],
        );
        if (cell >= 0) reprojected.add(cell);
      }
      fresh.continental_cells = Array.from(reprojected);
    }

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
      isActive: () => !!draftRef.current,
      onHover: (x, y, z) => {
        const tree = kdTreeRef.current;
        const drft = draftRef.current;
        if (!tree || !drft) return;
        const chord = angularToChord(drft.brush_radius_rad);
        previewRef.current = cellsWithinRadius(tree, x, y, z, chord);
        globeRef.current?.recolorFromDraft(drft, cellCountRef.current, previewRef.current);
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
        const chord = angularToChord(drft.brush_radius_rad);
        const hits = cellsWithinRadius(tree, x, y, z, chord);
        if (hits.length === 0) return;

        const seen = new Set(drft.continental_cells);
        let added = 0;
        for (const cell of hits) {
          if (!seen.has(cell)) {
            seen.add(cell);
            added++;
          }
        }
        if (added === 0) return;
        const next: WizardDraft = { ...drft, continental_cells: Array.from(seen) };
        draftRef.current = next;
        setDraft(next);
        previewRef.current = hits;
        globeRef.current?.recolorFromDraft(next, cellCountRef.current, previewRef.current);
      },
    });

    initWizard(INITIAL_DIVISIONS).catch((e) => setError(String(e)));
  }, [initWizard]);

  useEffect(() => { draftRef.current = draft; }, [draft]);

  // ── Wizard actions
  const handleChangeDivisions = useCallback((divisions: number) => {
    const d = draftRef.current;
    const positions = cellPositionsRef.current;
    initWizard(divisions, {
      preset: d?.preset,
      seed: d?.seed,
      previousPaint: d?.continental_cells,
      previousPositions: positions ?? undefined,
    }).catch((e) => setError(String(e)));
  }, [initWizard]);

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

  const handleClearContinents = useCallback(() => {
    if (!draft) return;
    const next: WizardDraft = { ...draft, continental_cells: [] };
    setDraft(next);
    draftRef.current = next;
    globeRef.current?.recolorFromDraft(next, cellCountRef.current);
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

  // ── Status copy
  const statusLabel =
    mode === "wizard" ? "draft" :
    mode === "baking" ? "baking" :
    error ? "error" : "ready";

  const statusBody =
    mode === "wizard" && draft ? (
      <>{draft.preset} · <Mono>{cellCountRef.current.toLocaleString()}</Mono> cells · <Mono>{draft.continental_cells.length.toLocaleString()}</Mono> painted · seed <Mono>{draft.seed}</Mono></>
    ) : mode === "wizard" ? "Loading…"
    : mode === "baking" ? "Running tectonic step loop…"
    : snapshot ? <>
      planet baked · <Mono>{snapshot.n_cells.toLocaleString()}</Mono> cells · <Mono>{snapshot.sim_time_ma.toFixed(1)}</Mono> Ma
    </> : "—";

  return (
    <>
      <Viewport onReady={handleSceneReady} />
      {mode === "wizard" && draft && (
        <WizardPanel
          draft={draft}
          onChangeDivisions={handleChangeDivisions}
          onChangePreset={handleChangePreset}
          onChangeBrushRadius={handleChangeBrushRadius}
          onReroll={handleReroll}
          onClearContinents={handleClearContinents}
          onBake={handleBake}
          busy={false}
        />
      )}
      {mode === "viewing" && (
        <button
          type="button"
          onClick={handleEditWizard}
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            zIndex: 60,
            background: "rgba(34, 38, 46, 0.92)",
            border: "1px solid #3d434e",
            color: "#e5e8eb",
            fontFamily: '"Segoe UI", "Noto Sans", system-ui, sans-serif',
            fontSize: 11,
            letterSpacing: "0.18em",
            textTransform: "lowercase",
            padding: "8px 14px",
            cursor: "pointer",
            backdropFilter: "blur(6px)",
          }}
        >
          edit wizard
        </button>
      )}
      <StatusBar state={mode === "baking" ? "baking" : error ? "error" : mode === "viewing" ? "ready" : "idle"} label={statusLabel}>
        {error ? `Error: ${error}` : statusBody}
      </StatusBar>
    </>
  );
}
