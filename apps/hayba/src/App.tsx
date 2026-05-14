import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Viewport from "./viewport/Viewport";
import type { SceneHandle } from "./viewport/scene";
import { buildGlobe, type GlobeHandle } from "./viewport/globe";
import { attachPainter, type PainterHandle } from "./viewport/painter";
import StatusBar, { Mono } from "./components/StatusBar";
import WizardPanel from "./wizard/WizardPanel";
import { createDefaultDraft, type WizardDraft } from "./wizard/state";
import { buildCellKdTree, nearestCell, type KdTree } from "./wizard/kdtree";

export interface PlanetSnapshot {
  divisions: number;
  n_cells: number;
  sim_time_ma: number;
  cell_positions: number[];
  cell_plate_ids: number[];
  cell_elevation: number[];
  cell_continental: number[];
}

interface WizardInit {
  divisions: number;
  n_cells: number;
  cell_positions: number[];
}

type Mode = "wizard" | "baking" | "viewing";

const INITIAL_DIVISIONS = 64;

export default function App() {
  const sceneRef = useRef<SceneHandle | null>(null);
  const globeRef = useRef<GlobeHandle | null>(null);
  const painterRef = useRef<PainterHandle | null>(null);
  const kdTreeRef = useRef<KdTree | null>(null);
  const cellCountRef = useRef(0);
  // Latest draft + active plate held in a ref alongside state so the painter
  // callback always sees fresh values without re-attaching.
  const draftRef = useRef<WizardDraft | null>(null);
  const activePlateRef = useRef<number>(1);

  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [activePlateId, setActivePlateId] = useState(1);
  const [mode, setMode] = useState<Mode>("wizard");
  const [snapshot, setSnapshot] = useState<PlanetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Init the wizard at the chosen resolution. Loads cell positions, builds
  // ── the kd-tree, builds the globe object, and seeds a default draft.
  const initWizard = useCallback(async (divisions: number, preserveDraft?: WizardDraft) => {
    const init = await invoke<WizardInit>("start_wizard", { divisions });
    const positions = new Float32Array(init.cell_positions);
    kdTreeRef.current = buildCellKdTree(positions);
    cellCountRef.current = init.n_cells;

    const newDraft =
      preserveDraft && preserveDraft.divisions === divisions
        ? preserveDraft
        : createDefaultDraft(divisions, preserveDraft?.seed ?? await invoke<number>("roll_seed"));
    setDraft(newDraft);
    draftRef.current = newDraft;

    // Pick a sensible initial active plate (first continental).
    const firstContinental = newDraft.plates.find((p) => p.continental)?.id ?? 1;
    setActivePlateId(firstContinental);
    activePlateRef.current = firstContinental;

    const scene = sceneRef.current;
    if (scene) {
      const globe = buildGlobe(positions);
      globeRef.current = globe;
      scene.setGlobe(globe.object);
      globe.recolorFromDraft(newDraft, init.n_cells);
    }
  }, []);

  // Mount once: build the scene callback; init the first wizard draft when the scene is ready.
  const handleSceneReady = useCallback((handle: SceneHandle) => {
    sceneRef.current = handle;
    // Attach the painter; the callback reads activePlateRef + kdTreeRef + draftRef.
    painterRef.current = attachPainter({
      canvas: handle.canvas,
      camera: handle.camera,
      target: handle.raycastTarget,
      isActive: () => {
        if (!draftRef.current) return false;
        const ap = draftRef.current.plates.find((p) => p.id === activePlateRef.current);
        return !!ap?.continental;
      },
      onPaint: (x, y, z) => {
        const tree = kdTreeRef.current;
        const drft = draftRef.current;
        if (!tree || !drft) return;
        const cell = nearestCell(tree, x, y, z);
        if (cell < 0) return;
        const ap = drft.plates.find((p) => p.id === activePlateRef.current);
        if (!ap || !ap.continental) return;
        // Add cell if not already in this plate's stroke; remove from any other plate that claimed it.
        let mutated = false;
        for (const plate of drft.plates) {
          if (plate.id === ap.id) continue;
          const at = plate.cell_ids.indexOf(cell);
          if (at >= 0) {
            plate.cell_ids.splice(at, 1);
            mutated = true;
          }
        }
        if (!ap.cell_ids.includes(cell)) {
          ap.cell_ids.push(cell);
          mutated = true;
        }
        if (mutated) {
          // Recolor the globe in place from the mutated draft.
          globeRef.current?.recolorFromDraft(drft, cellCountRef.current);
          // Trigger a render of the plate row's painted-count by refreshing state.
          setDraft({ ...drft, plates: drft.plates.map((p) => ({ ...p, cell_ids: [...p.cell_ids] })) });
        }
      },
    });

    // First boot — pull a seed and build the initial wizard.
    initWizard(INITIAL_DIVISIONS).catch((e) => setError(String(e)));
  }, [initWizard]);

  // Keep refs in sync with state.
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { activePlateRef.current = activePlateId; }, [activePlateId]);

  // ── Wizard actions
  const handleChangeDivisions = useCallback((divisions: number) => {
    initWizard(divisions).catch((e) => setError(String(e)));
  }, [initWizard]);

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

  const handleTogglePlateContinental = useCallback((id: number) => {
    if (!draft) return;
    const next: WizardDraft = {
      ...draft,
      plates: draft.plates.map((p) =>
        p.id === id ? { ...p, continental: !p.continental, cell_ids: !p.continental ? p.cell_ids : [] } : p
      ),
    };
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
      globeRef.current?.recolorFromSnapshot(snap);
    } catch (e) {
      setError(String(e));
      setMode("wizard");
    }
  }, [draft]);

  const handleEditWizard = useCallback(() => {
    setMode("wizard");
    if (draft) globeRef.current?.recolorFromDraft(draft, cellCountRef.current);
  }, [draft]);

  // ── Status bar copy
  const statusLabel =
    mode === "wizard" ? "draft" :
    mode === "baking" ? "baking" :
    error ? "error" : "ready";

  const statusBody =
    mode === "wizard" ? (draft ? <>
      {draft.plates.filter((p) => p.continental).length} continental plates · <Mono>{cellCountRef.current.toLocaleString()}</Mono> cells · seed <Mono>{draft.seed}</Mono>
    </> : "Loading…")
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
          activePlateId={activePlateId}
          onChangeDivisions={handleChangeDivisions}
          onReroll={handleReroll}
          onActivatePlate={setActivePlateId}
          onTogglePlateContinental={handleTogglePlateContinental}
          onBake={handleBake}
          busy={mode !== "wizard" as any}
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
            fontFamily: '"Noto Sans", system-ui, sans-serif',
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
