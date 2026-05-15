import React, { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import Viewport from "./viewport/Viewport";
import type { SceneHandle } from "./viewport/scene";
import { buildGlobe, PLATE_PALETTE, type GlobeHandle } from "./viewport/globe";
import { buildGlobeMesh, type GlobeMeshHandle } from "./viewport/mesh";
import { SATMAP_NAMES, SATMAP_FAMILIES, METADATA as SATMAP_METADATA, type SatMapName } from "./viewport/satmap-loader";
import { attachPainter, type PainterHandle } from "./viewport/painter";
import StatusBar, { Mono } from "./components/StatusBar";
import TopBar from "./components/TopBar";
import RightPanel from "./components/RightPanel";
import type { PanelCategory } from "./components/CategoryStrip";
import ComposePanel from "./components/panels/ComposePanel";
import BoundariesPanel from "./components/panels/BoundariesPanel";
import DensitiesPanelDocked from "./components/panels/DensitiesPanelDocked";
import SimulatePanel from "./components/panels/SimulatePanel";
import SettingsPanel from "./components/panels/SettingsPanel";
import DockToolbar, { type ToolName } from "./components/DockToolbar";
import RecenterButton from "./components/RecenterButton";
import ConfirmDialog from "./components/ConfirmDialog";
import BoundaryPopover from "./components/BoundaryPopover";
import { IconPlay, IconPause, IconReset } from "./components/icons";
import { buildPlateLabels, type PlateLabelsHandle } from "./viewport/overlays/plateLabels";
import { buildForceArrows, type ForceArrowsHandle } from "./viewport/overlays/forceArrows";
import { buildPoleLabels,  type PoleLabelsHandle  } from "./viewport/overlays/poleLabels";
import { createDefaultDraft, pairKey, type WizardDraft, type PresetName, type BoundaryType } from "./wizard/state";
import { BoundaryModel, setBoundary, clearBoundary } from "./wizard/boundary-model";
import { buildCellKdTree, cellsWithinRadius, nearestCell, type KdTree } from "./wizard/kdtree";
import { HeightPainter, type BrushConfig } from "./wizard/paint/HeightPainter";
import HeightPaintPanel from "./components/panels/HeightPaintPanel";
import { buildPainterMesh, type PainterMeshHandle } from "./viewport/painterMesh";

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
  cell_slope: number[];
  cell_latitude_band: number[];
  cell_age_ma: number[];
  cell_crust_thickness_km: number[];
  cell_volcanic_intensity: number[];
  cell_collision_kind: number[];
  cell_subduction_progress: number[];
  cell_is_continent_buffer: number[];
  cell_orogenic_uplift: number[];
  cell_mor_age_steps: number[];
}

interface WizardInit {
  divisions: number;
  n_cells: number;
  cell_positions: number[];
}

// Phase lifecycle:
//   wizard     — composing (presets, paint continents, seed, detail)
//   baking     — transient while the Rust sim crunches the initial frames
//   boundaries — post-bake. Click pink seams → convergent/divergent.
//   densities  — assign plate density rank (continental-floats-over-oceanic).
//   simulating — sim is live. Play/Pause + time scrubbing available.
type Mode = "wizard" | "baking" | "boundaries" | "densities" | "simulating";

const INITIAL_DIVISIONS = 64;

function angularToChord(rad: number): number {
  return 2 * Math.sin(rad / 2);
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

function statusMode(mode: Mode): "compose" | "boundaries" | "densities" | "simulate" {
  if (mode === "boundaries") return "boundaries";
  if (mode === "densities")  return "densities";
  if (mode === "simulating") return "simulate";
  return "compose"; // wizard + baking both report as compose
}

function statusChips(
  mode: Mode,
  draft: WizardDraft | null,
  snap: PlanetSnapshot | null,
  cellCount: number,
): { label: string; value: React.ReactNode }[] {
  if (mode === "wizard" || mode === "baking") {
    if (!draft) return [];
    return [
      { label: "Preset",  value: draft.preset },
      { label: "Cells",   value: cellCount.toLocaleString() },
      { label: "Painted", value: draft.continental_cells.length.toLocaleString() },
      { label: "Brush",   value: `${(draft.brush_radius_rad * 180 / Math.PI).toFixed(1)}°` },
    ];
  }
  if (mode === "boundaries") {
    const assigned = Object.keys(draft?.boundary_types ?? {}).length;
    return [{ label: "Assigned", value: `${assigned} / —` }];
  }
  if (mode === "densities") {
    return [{ label: "Plates", value: snap ? new Set(snap.cell_plate_ids.filter((p) => p >= 0)).size : 0 }];
  }
  if (snap) {
    return [
      { label: "Era",   value: eraForMa(snap.sim_time_ma) },
      { label: "Time",  value: `${snap.sim_time_ma.toFixed(1)} Ma` },
    ];
  }
  return [];
}

function statusHint(mode: Mode): string | undefined {
  if (mode === "boundaries") return "Click a pink seam to assign convergent or divergent.";
  if (mode === "densities")  return "Drag plates to reorder. Top = lightest.";
  return undefined;
}

function buildAdjacency(triangles: Uint32Array, nCells: number): number[][] {
  const adj: number[][] = Array.from({ length: nCells }, () => []);
  const pushUnique = (arr: number[], v: number): void => {
    if (!arr.includes(v)) arr.push(v);
  };
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
    pushUnique(adj[a], b); pushUnique(adj[a], c);
    pushUnique(adj[b], a); pushUnique(adj[b], c);
    pushUnique(adj[c], a); pushUnique(adj[c], b);
  }
  return adj;
}

function invertBrushMode(b: BrushConfig): BrushConfig {
  if (b.mode === "raise") return { ...b, mode: "lower" };
  if (b.mode === "lower") return { ...b, mode: "raise" };
  return b;
}

export default function App() {
  const sceneRef = useRef<SceneHandle | null>(null);
  const globeRef = useRef<GlobeHandle | null>(null);
  const globeMeshRef = useRef<GlobeMeshHandle | null>(null);
  const painterRef = useRef<PainterHandle | null>(null);
  const kdTreeRef = useRef<KdTree | null>(null);
  const cellCountRef = useRef(0);

  // Height-painter (sculpt phase) state. Distinct from `painterRef` which is
  // the continent-painting hover/click handler.
  const heightPainterRef = useRef<HeightPainter | null>(null);
  const painterMeshRef = useRef<PainterMeshHandle | null>(null);
  const positionsRef = useRef<Float32Array | null>(null);
  const trianglesRef = useRef<Uint32Array | null>(null);
  const adjRef = useRef<number[][] | null>(null);

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

  // Overlay refs
  const plateLabelsRef = useRef<PlateLabelsHandle | null>(null);
  const forceArrowsRef = useRef<ForceArrowsHandle | null>(null);
  const poleLabelsRef  = useRef<PoleLabelsHandle  | null>(null);

  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [mode, setMode] = useState<Mode>("wizard");
  const [snapshot, setSnapshot] = useState<PlanetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ToolName>("brush");
  const [pendingDivisions, setPendingDivisions] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);

  // Height painter UI state
  const [paintedCount, setPaintedCount] = useState(0);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [paintBrush, setPaintBrush] = useState<BrushConfig>({
    mode: "raise",
    radiusRad: 0.06,
    strength: 0.3,
    falloff: "smooth",
    mask: "round-soft",
    flattenTarget: 0,
    noiseScale: 4,
  });

  // Panel state
  const [panelCategory, setPanelCategory] = useState<PanelCategory>("compose");
  const [showPlateLabels, setShowPlateLabels] = useState(true);
  const [showForceArrows, setShowForceArrows] = useState(true);

  // SatMap & terrain rendering settings (apply post-bake to the triangulated mesh)
  // Default to a high-contrast biome so the SatMap pipeline is unmistakable
  // when the user bakes a fresh planet — they can switch to anything else
  // from the Settings panel afterwards.
  const DEFAULT_SATMAP: SatMapName = SATMAP_NAMES.includes("arid_hot_dunes")
    ? "arid_hot_dunes"
    : SATMAP_NAMES[0];
  const [satMap, setSatMap] = useState<SatMapName>(DEFAULT_SATMAP);
  const [exaggeration, setExaggeration] = useState(1.0);
  const [showPlateOutlines, setShowPlateOutlines] = useState(true);
  const [showBoundaryGlow, setShowBoundaryGlow] = useState(true);

  useEffect(() => { globeMeshRef.current?.setSatMap(satMap); }, [satMap]);
  useEffect(() => { globeMeshRef.current?.setExaggeration(exaggeration); }, [exaggeration]);
  useEffect(() => { globeMeshRef.current?.setShowPlateOutlines(showPlateOutlines); }, [showPlateOutlines]);
  useEffect(() => { globeMeshRef.current?.setShowBoundaryGlow(showBoundaryGlow); }, [showBoundaryGlow]);

  // Click-on-planet boundary popover (replaces selected-seam editor in the side panel)
  const [boundaryPopover, setBoundaryPopover] = useState<{
    screenX: number; screenY: number; plateA: number; plateB: number;
  } | null>(null);

  // Cell inspector — simulating mode only. Click a cell to read its sim state.
  const [selectedCell, setSelectedCell] = useState<number | null>(null);

  // Playback speed (steps per rAF tick). 1× is the wizard's dt_ma per frame.
  const [speedMult, setSpeedMult] = useState<1 | 2 | 4 | 8>(1);
  const speedRef = useRef<1 | 2 | 4 | 8>(1);
  useEffect(() => { speedRef.current = speedMult; }, [speedMult]);

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

  // Space toggles play/pause — only valid in the simulating phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code !== "Space") return;
      if (modeRef.current !== "simulating") return;
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
    positionsRef.current = positions;
    // Invalidate per-grid caches — divisions may have changed.
    trianglesRef.current = null;
    adjRef.current = null;
    heightPainterRef.current = null;
    setPaintedCount(0);
    setCanUndo(false);
    setCanRedo(false);

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

    // Mount overlays
    const labels = buildPlateLabels();
    const arrows = buildForceArrows();
    const poles  = buildPoleLabels();
    handle.scene.add(labels.group);
    handle.scene.add(arrows.group);
    handle.scene.add(poles.group);
    plateLabelsRef.current = labels;
    forceArrowsRef.current = arrows;
    poleLabelsRef.current  = poles;
    labels.setVisible(false);
    arrows.setVisible(false);
    poles.setVisible(true);   // N/S poles always visible (auto-hidden if a plate label collides)

    initWizard(INITIAL_DIVISIONS).catch((e) => setError(String(e)));
  }, [initWizard]);

  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { playingRef.current = playing; }, [playing]);

  // Playback is locked to the simulating phase.
  useEffect(() => {
    if (mode !== "simulating" && playing) setPlaying(false);
  }, [mode, playing]);
  useEffect(() => {
    snapshotRef.current = snapshot;
    // Rebuild the BoundaryModel once per new snapshot.
    boundaryModelRef.current = snapshot ? BoundaryModel.fromSnapshot(snapshot) : null;
  }, [snapshot]);

  // Re-tint baked boundaries whenever assignments change in any post-bake phase.
  useEffect(() => {
    if (mode === "wizard" || mode === "baking" || !snapshot || !draft) return;
    const bm = boundaryModelRef.current;
    globeRef.current?.recolorFromSnapshot(
      snapshot, PLATE_PALETTE,
      bm ? { model: bm, assignments: draft.boundary_types } : undefined,
    );
    globeMeshRef.current?.updateFromSnapshot(snapshot);
  }, [mode, snapshot, draft?.boundary_types]);

  // Animation tick — advance the Rust sim on rAF cadence while `playing`.
  // step_planet(1) per tick = dt_ma per tick, so the visual delta stays
  // gentle. Cancellation flag bridges the async gap.
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled || !playingRef.current) return;
      invoke<PlanetSnapshot>("step_planet", { nSteps: speedRef.current })
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
          globeMeshRef.current?.updateFromSnapshot(snap);
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

  // Boundary picking only fires during the boundaries phase.
  useEffect(() => {
    if (mode !== "boundaries") return;
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
      // Try the displaced mesh first (so we hit the actual cell the user
      // sees — extruded continents would otherwise let the ray pass through
      // and hit a DIFFERENT cell on the unit sphere). Fall back to the
      // invisible unit-sphere raycast target for ocean cells where the
      // mesh and the sphere coincide.
      const targets: THREE.Object3D[] = [];
      const meshObj = globeMeshRef.current?.object;
      if (meshObj) targets.push(meshObj);
      targets.push(scene.raycastTarget);
      const hits = ray.intersectObjects(targets, false);
      if (hits.length === 0) {
        console.log("[boundary-click] no raycast hit");
        return;
      }
      const p = hits[0].point.clone().normalize();
      const cell = nearestCell(tree, p.x, p.y, p.z);
      const key = bm.pairKeyForCell(cell);
      console.log(`[boundary-click] cell=${cell} pairKey=${key ?? "(interior)"}`);
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

  // Cell inspector — simulating mode only. Click a cell to select it for
  // readout in the right panel.
  useEffect(() => {
    if (mode !== "simulating") return;
    const scene = sceneRef.current;
    if (!scene) return;
    const canvas = scene.canvas;
    const onPointer = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const tree = kdTreeRef.current;
      if (!tree) return;
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
      setSelectedCell(cell);
    };
    canvas.addEventListener("pointerdown", onPointer);
    return () => canvas.removeEventListener("pointerdown", onPointer);
  }, [mode]);

  // Height-painter lifecycle. When the user is in the compose panel pre-bake
  // during wizard mode, lazily build the adjacency list + painter mesh and
  // swap it in for the point-cloud globe. On leave, restore the globe and
  // tear down the GL resources. Painter state itself persists across visits.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const active = panelCategory === "compose" && mode === "wizard";

    if (!active) {
      if (painterMeshRef.current) {
        scene.scene.remove(painterMeshRef.current.object);
        painterMeshRef.current.dispose();
        painterMeshRef.current = null;
      }
      if (globeRef.current) globeRef.current.object.visible = true;
      return;
    }

    const positions = positionsRef.current;
    const drft = draftRef.current;
    if (!positions || !drft) return;

    const divisions = drft.divisions;
    const setup = async () => {
      // Triangles — fetch once per grid.
      if (!trianglesRef.current) {
        const tris = await invoke<number[]>("get_grid_triangles", { divisions });
        trianglesRef.current = new Uint32Array(tris);
      }
      const triangles = trianglesRef.current;
      const nCells = cellCountRef.current;

      // Adjacency — build once per grid.
      if (!adjRef.current) {
        adjRef.current = buildAdjacency(triangles, nCells);
      }
      const adj = adjRef.current;

      // Painter — rebuild if cell count changed since last init.
      if (!heightPainterRef.current || heightPainterRef.current.n !== nCells) {
        heightPainterRef.current = new HeightPainter({
          positions,
          neighbours: adj,
          seed: drft.seed,
        });
        setPaintedCount(0);
        setCanUndo(false);
        setCanRedo(false);
      }
      const painter = heightPainterRef.current;

      // Build mesh + add to scene. Hide point-cloud globe while painting.
      const pmesh = buildPainterMesh({
        positions,
        triangles,
        initialElevations: painter.elevations,
      });
      painterMeshRef.current = pmesh;
      scene.scene.add(pmesh.object);
      if (globeRef.current) globeRef.current.object.visible = false;
    };

    let cancelled = false;
    setup().catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
      if (painterMeshRef.current) {
        scene.scene.remove(painterMeshRef.current.object);
        painterMeshRef.current.dispose();
        painterMeshRef.current = null;
      }
      if (globeRef.current) globeRef.current.object.visible = true;
    };
  }, [panelCategory, mode, draft?.divisions]);

  // Height-painter pointer interactions. Gated on the compose panel pre-bake
  // in wizard mode. Shift inverts raise<->lower.
  useEffect(() => {
    if (panelCategory !== "compose" || mode !== "wizard") return;
    const scene = sceneRef.current;
    if (!scene) return;
    const canvas = scene.canvas;

    const raycast = (ev: PointerEvent): { cellId: number; point: [number, number, number] } | null => {
      const tree = kdTreeRef.current;
      if (!tree) return null;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((ev.clientX - rect.left) / rect.width) * 2 - 1,
        -(((ev.clientY - rect.top) / rect.height) * 2 - 1),
      );
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, scene.camera);
      const meshObj = painterMeshRef.current?.object ?? scene.raycastTarget;
      const hits = ray.intersectObject(meshObj, true);
      if (hits.length === 0) return null;
      const p = hits[0].point.clone().normalize();
      const cell = nearestCell(tree, p.x, p.y, p.z);
      return { cellId: cell, point: [p.x, p.y, p.z] };
    };

    const onPointerDown = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      const painter = heightPainterRef.current;
      if (!painter) return;
      const hit = raycast(ev);
      if (!hit) return;
      const effectiveBrush = ev.shiftKey ? invertBrushMode(paintBrush) : paintBrush;
      painter.beginStroke(effectiveBrush);
      painter.tickStroke({ seedCellId: hit.cellId, hit: hit.point });
      painterMeshRef.current?.syncFromPainter(painter);
    };
    const onPointerMove = (ev: PointerEvent) => {
      const painter = heightPainterRef.current;
      const pmesh = painterMeshRef.current;
      if (!painter || !pmesh) return;
      const hit = raycast(ev);
      pmesh.setCursor(hit?.point ?? null, paintBrush.radiusRad, (ev.buttons & 1) === 1);
      if ((ev.buttons & 1) === 1 && hit) {
        painter.tickStroke({ seedCellId: hit.cellId, hit: hit.point });
        pmesh.syncFromPainter(painter);
      }
    };
    const onPointerUp = () => {
      const painter = heightPainterRef.current;
      if (!painter) return;
      painter.endStroke();
      setCanUndo(painter.undoCount() > 0);
      setCanRedo(false);
      setPaintedCount(painter.countTouched());
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
    };
  }, [panelCategory, mode, paintBrush]);

  // Live-apply boundary assignments — Rust rewrites plate omegas on the
  // running model so the change is visible immediately. No re-bake.
  const applyBoundaryTypesLive = useCallback(async (types: Record<string, BoundaryType>) => {
    try {
      const snap = await invoke<PlanetSnapshot>("apply_boundary_types", { boundaryTypes: types });
      setSnapshot(snap);
      const bm = BoundaryModel.fromSnapshot(snap);
      boundaryModelRef.current = bm;
      globeRef.current?.recolorFromSnapshot(snap, PLATE_PALETTE, { model: bm, assignments: types });
      globeMeshRef.current?.updateFromSnapshot(snap);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const handleSetBoundary = useCallback((type: BoundaryType) => {
    if (!boundaryPopover || !draft) return;
    const key = pairKey(boundaryPopover.plateA, boundaryPopover.plateB);
    const nextTypes = setBoundary(draft.boundary_types, key, type);
    const next: WizardDraft = { ...draft, boundary_types: nextTypes };
    setDraft(next); draftRef.current = next;
    setBoundaryPopover(null);
    applyBoundaryTypesLive(nextTypes);
  }, [boundaryPopover, draft, applyBoundaryTypesLive]);

  const handleClearBoundary = useCallback(() => {
    if (!boundaryPopover || !draft) return;
    const key = pairKey(boundaryPopover.plateA, boundaryPopover.plateB);
    const nextTypes = clearBoundary(draft.boundary_types, key);
    const next: WizardDraft = { ...draft, boundary_types: nextTypes };
    setDraft(next); draftRef.current = next;
    setBoundaryPopover(null);
    applyBoundaryTypesLive(nextTypes);
  }, [boundaryPopover, draft, applyBoundaryTypesLive]);

  // Escape dismisses the popover
  useEffect(() => {
    if (!boundaryPopover) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBoundaryPopover(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [boundaryPopover]);

  const handleChangeDivisions = useCallback((divisions: number) => {
    const d = draftRef.current;
    if (!d || divisions === d.divisions) return;
    const paintedCells = heightPainterRef.current?.countTouched() ?? 0;
    if (d.continental_cells.length > 0 || paintedCells > 0) {
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
      const paintedFields = heightPainterRef.current
        ? heightPainterRef.current.toDraftFields()
        : { painted_elevations: [], painted_mask: [] };
      const finalDraft: WizardDraft = { ...draft, ...paintedFields };
      const snap = await invoke<PlanetSnapshot>("bake_from_wizard", { draft: finalDraft });
      setSnapshot(snap);
      // After bake → land on the Boundaries phase (the next step in the
      // wizard sequence). User clicks Next/Start to advance to densities
      // and finally simulating.
      setMode("boundaries");
      const bm = BoundaryModel.fromSnapshot(snap);
      boundaryModelRef.current = bm;

      // Swap point-cloud globe for triangulated mesh with SatMap shading.
      // Wrapped in its own try so a mesh-build failure doesn't undo the
      // successful bake (user can still proceed with the old point-cloud
      // renderer if the new mesh path errors out).
      try {
        const tris = await invoke<number[]>("get_grid_triangles", { divisions: snap.divisions });
        if (globeMeshRef.current) globeMeshRef.current.dispose();
        const mesh = buildGlobeMesh(snap, new Uint32Array(tris));
        mesh.setSatMap(satMap);
        mesh.setExaggeration(exaggeration);
        mesh.setShowPlateOutlines(showPlateOutlines);
        mesh.setShowBoundaryGlow(showBoundaryGlow);
        sceneRef.current?.setGlobe(mesh.object);
        globeMeshRef.current = mesh;
        console.log(`[mesh] ✓ built triangulated planet — ${snap.n_cells} cells, ${tris.length / 3} triangles, satmap='${satMap}'`);
      } catch (meshErr) {
        console.warn("[mesh] could not build triangulated mesh — falling back to point cloud:", meshErr);
      }
    } catch (e) {
      setError(String(e));
      setMode("wizard");
    }
  }, [draft]);

  const handleEditWizard = useCallback(() => {
    previewRef.current = [];
    invoke("reset_sim").catch(() => {});
    setMode("wizard");
    setPlaying(false);
    if (draft) globeRef.current?.recolorFromDraft(draft, cellCountRef.current);
  }, [draft]);

  // Density rank — populated when entering the densities phase, then live-
  // applied to the running model on each reorder.
  const [densityOrder, setDensityOrder] = useState<number[]>([]);

  const handleAdvanceToDensities = useCallback(() => {
    if (!snapshot) return;
    // Seed the order from the current plate ids (ascending). The user can
    // reorder before clicking Start.
    const ids = Array.from(new Set(snapshot.cell_plate_ids.filter((p) => p >= 0))).sort((a, b) => a - b);
    setDensityOrder(ids);
    setMode("densities");
  }, [snapshot]);

  const handleBackToBoundaries = useCallback(() => {
    setMode("boundaries");
  }, []);

  // Pre-start confirmation. The transition compose → boundaries → densities →
  // simulating is one-way: once the user presses Start, plate motion takes
  // over and the configuration becomes immutable. We surface that explicitly
  // so they have a chance to save first.
  const [showStartConfirm, setShowStartConfirm] = useState(false);

  const handleStartSimulation = useCallback(() => {
    setShowStartConfirm(true);
  }, []);

  const handleConfirmStartSimulation = useCallback(() => {
    setShowStartConfirm(false);
    setMode("simulating");
  }, []);

  const handleSaveConfiguration = useCallback(async () => {
    // Stub for now — once we have a Tauri save_planet command we'll invoke it.
    // For v1 we just toast that saving isn't wired yet but let the user proceed.
    console.log("[save] save_planet command not yet wired — placeholder for future Tauri command");
    // Optionally persist a JSON snapshot of the draft to localStorage as a
    // forward-compatible fallback so the user's work isn't lost.
    if (draft) {
      const blob = JSON.stringify({ draft, savedAt: new Date().toISOString() }, null, 2);
      try { localStorage.setItem("hayba.lastConfig", blob); } catch {}
    }
  }, [draft]);

  const handleDensityChange = useCallback((order: number[], snap: PlanetSnapshot) => {
    setDensityOrder(order);
    setSnapshot(snap);
    const bm = BoundaryModel.fromSnapshot(snap);
    boundaryModelRef.current = bm;
    const drft = draftRef.current;
    if (drft) {
      globeRef.current?.recolorFromSnapshot(snap, PLATE_PALETTE, {
        model: bm, assignments: drft.boundary_types,
      });
    }
    globeMeshRef.current?.updateFromSnapshot(snap);
  }, []);

  const showWizard = mode === "wizard";
  const getScene = useCallback(() => sceneRef.current, []);

  // Category gating
  const categoryEnabled: Record<PanelCategory, boolean> = {
    compose:    true,
    boundaries: mode === "boundaries" || mode === "densities" || mode === "simulating",
    densities:  mode === "densities" || mode === "simulating",
    simulate:   mode === "simulating",
    settings:   true,
  };
  const categoryDisabledReason: Partial<Record<PanelCategory, string>> = {
    boundaries: "Bake the planet to edit boundaries",
    densities:  "Complete boundaries to rank densities",
    simulate:   "Start the simulation from the Densities panel",
  };

  // Auto-promote panel category when mode changes
  useEffect(() => {
    if (mode === "boundaries")  setPanelCategory("boundaries");
    if (mode === "densities")   setPanelCategory("densities");
    if (mode === "simulating")  setPanelCategory("simulate");
    if (mode === "wizard")      setPanelCategory("compose");
  }, [mode]);

  // Overlay update effect
  useEffect(() => {
    const snap = snapshot;
    const labels = plateLabelsRef.current;
    const arrows = forceArrowsRef.current;
    const poles  = poleLabelsRef.current;
    if (!snap || !labels || !arrows) return;
    const show = mode === "simulating";
    labels.setVisible(show && showPlateLabels);
    arrows.setVisible(show && showForceArrows);
    // Pole labels are visible whenever we have a baked planet, regardless
    // of simulating/boundaries phase — they're geographic landmarks.
    if (poles) {
      poles.setVisible(mode !== "wizard" && mode !== "baking");
      poles.update(snap);
    }
    if (show) {
      labels.update(snap);
      // Per-plate omegas not yet in PlanetSnapshot. Empty map → no arrows
      // until that lands; scaffolding is in place.
      arrows.update(snap, new Map());
    }
  }, [snapshot, mode, showPlateLabels, showForceArrows]);

  return (
    <div style={{
      position: "fixed",
      inset: 0,
      display: "grid",
      gridTemplateRows: "34px 1fr 36px",
      gridTemplateColumns: "1fr 340px",
      background: "#22262e",
    }}>
      <div style={{ gridColumn: "1 / span 2" }}>
        <TopBar divisions={draft?.divisions ?? INITIAL_DIVISIONS} documentTitle="untitled.planet" />
      </div>

      <div style={{ position: "relative", minWidth: 0, minHeight: 0 }}>
        <Viewport onReady={handleSceneReady} />

        {showWizard && draft && (
          <DockToolbar
            active={activeTool}
            onChange={setActiveTool}
            brushRadius={draft.brush_radius_rad}
            onChangeBrushRadius={handleChangeBrushRadius}
          />
        )}

        <RecenterButton getScene={getScene} />
      </div>

      <RightPanel
        active={panelCategory}
        enabled={categoryEnabled}
        disabledReason={categoryDisabledReason}
        onPick={setPanelCategory}
      >
        {panelCategory === "compose" && draft && (
          <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
            <div style={{ flex: "0 0 auto" }}>
              <ComposePanel
                draft={draft}
                busy={mode === "baking"}
                onChangeDivisions={handleChangeDivisions}
                onChangePreset={handleChangePreset}
                onReroll={handleReroll}
                onBake={handleBake}
              />
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
              <HeightPaintPanel
                brush={paintBrush}
                paintedCount={paintedCount}
                canUndo={canUndo}
                canRedo={canRedo}
                onChangeBrush={setPaintBrush}
                onUndo={() => {
                  const p = heightPainterRef.current;
                  if (p?.undo()) {
                    painterMeshRef.current?.syncFromPainter(p);
                    setCanUndo(p.undoCount() > 0);
                    setCanRedo(true);
                    setPaintedCount(p.countTouched());
                  }
                }}
                onRedo={() => {
                  const p = heightPainterRef.current;
                  if (p?.redo()) {
                    painterMeshRef.current?.syncFromPainter(p);
                    setCanUndo(true);
                    setCanRedo(p.redoCount() > 0);
                    setPaintedCount(p.countTouched());
                  }
                }}
                onReset={() => {
                  if (!window.confirm("Reset all painted heights?")) return;
                  const p = heightPainterRef.current;
                  if (p) {
                    p.reset();
                    painterMeshRef.current?.syncFromPainter(p);
                  }
                  setCanUndo(false);
                  setCanRedo(false);
                  setPaintedCount(0);
                }}
                onBack={() => { /* no-op — paint heights lives inside compose now */ }}
                onNext={() => { /* no-op — paint heights lives inside compose now */ }}
              />
            </div>
          </div>
        )}

        {panelCategory === "boundaries" && snapshot && draft && (
          <BoundariesPanel
            totalSeams={boundaryModelRef.current?.pairs.length ?? 0}
            assignedCount={Object.keys(draft.boundary_types ?? {}).length}
            onAdvance={handleAdvanceToDensities}
          />
        )}

        {panelCategory === "densities" && snapshot && (
          <DensitiesPanelDocked
            snapshot={snapshot}
            order={densityOrder}
            onChange={handleDensityChange}
            onBack={handleBackToBoundaries}
            onStart={handleStartSimulation}
          />
        )}

        {panelCategory === "simulate" && snapshot && (
          <SimulatePanel
            era={eraForMa(snapshot.sim_time_ma)}
            simTimeMa={snapshot.sim_time_ma}
            steps={0}
            selectedCell={selectedCell}
            snapshot={snapshot}
          />
        )}

        {panelCategory === "settings" && (
          <SettingsPanel
            showPlateLabels={showPlateLabels}
            showForceArrows={showForceArrows}
            onToggleLabels={setShowPlateLabels}
            onToggleArrows={setShowForceArrows}
          />
        )}
      </RightPanel>

      <div style={{ gridColumn: "1 / span 2" }}>
        <StatusBar
          mode={statusMode(mode)}
          chips={statusChips(mode, draft, snapshot, cellCountRef.current)}
          hint={statusHint(mode)}
          rightSlot={mode === "simulating" && snapshot ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                aria-label={playing ? "Pause" : "Play"}
                title={playing ? "Pause" : "Play"}
                style={{
                  width: 28, height: 28,
                  background: "transparent",
                  border: "1px solid #DED4C3",
                  borderRadius: 2,
                  color: "#DED4C3",
                  cursor: "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                }}
              >
                {playing ? <IconPause size={12} /> : <IconPlay size={12} />}
              </button>
              {/* Speed multiplier — cycles 1 → 2 → 4 → 8 → 1 */}
              <button
                type="button"
                onClick={() => setSpeedMult((s) => (s === 1 ? 2 : s === 2 ? 4 : s === 4 ? 8 : 1))}
                aria-label={`Speed ${speedMult}x — click to change`}
                title="Cycle simulation speed"
                style={{
                  height: 28,
                  padding: "0 8px",
                  background: "transparent",
                  border: "1px solid #3d434e",
                  borderRadius: 2,
                  color: "#a8aeb8",
                  fontFamily: "Consolas, monospace",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {speedMult}×
              </button>
              <button
                type="button"
                onClick={() => {
                  invoke("reset_sim").catch(() => {});
                  setPlaying(false);
                  setSelectedCell(null);
                }}
                aria-label="Reset simulation"
                title="Reset simulation"
                style={{
                  width: 28, height: 28,
                  background: "transparent",
                  border: "1px solid #3d434e",
                  borderRadius: 2,
                  color: "#a8aeb8",
                  cursor: "pointer",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <IconReset size={12} />
              </button>
            </span>
          ) : null}
        />
      </div>

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

      {showStartConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed", inset: 0, zIndex: 200,
            background: "rgba(15, 17, 22, 0.62)",
            display: "flex", alignItems: "center", justifyContent: "center",
            backdropFilter: "blur(6px)",
            fontFamily: '"Segoe UI", "Noto Sans", system-ui, sans-serif',
          }}
          onClick={() => setShowStartConfirm(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 460,
              background: "#22262e",
              border: "1px solid #2f343d",
              borderLeft: "2px solid #B56A1D",
              borderRadius: 3,
              padding: "20px 22px 18px",
              color: "#e5e8eb",
            }}
          >
            <div style={{ fontSize: 11, color: "#B56A1D", marginBottom: 8 }}>
              One-way step
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>
              Start simulation?
            </div>
            <div style={{ fontSize: 13, color: "#a8aeb8", lineHeight: 1.55, marginBottom: 22 }}>
              Once the sim starts, plate motion takes over and you{"’"}ll no longer be able to
              edit boundaries, density rank, or the wizard. Save your configuration first
              if you want to revisit this setup later.
              {paintedCount > 0 && (
                <div style={{ marginTop: 10, color: "#DED4C3", fontSize: 12 }}>
                  {paintedCount} cells painted.
                </div>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => setShowStartConfirm(false)}
                style={{
                  background: "transparent",
                  border: "1px solid #3d434e",
                  color: "#a8aeb8",
                  padding: "8px 14px", borderRadius: 3, fontSize: 12,
                  fontFamily: '"Segoe UI", "Noto Sans", system-ui, sans-serif',
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmStartSimulation}
                style={{
                  background: "transparent",
                  border: "1px solid #3d434e",
                  color: "#a8aeb8",
                  padding: "8px 14px", borderRadius: 3, fontSize: 12,
                  fontFamily: '"Segoe UI", "Noto Sans", system-ui, sans-serif',
                  cursor: "pointer",
                }}
              >
                Start without saving
              </button>
              <button
                type="button"
                onClick={async () => { await handleSaveConfiguration(); handleConfirmStartSimulation(); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(222,212,195,0.08)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                style={{
                  background: "transparent",
                  border: "1px solid #DED4C3",
                  color: "#DED4C3",
                  padding: "8px 14px", borderRadius: 3, fontSize: 12,
                  fontWeight: 500,
                  fontFamily: '"Segoe UI", "Noto Sans", system-ui, sans-serif',
                  cursor: "pointer",
                  transition: "background 120ms",
                }}
              >
                Save &amp; start
              </button>
            </div>
          </div>
        </div>
      )}

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
    </div>
  );
}
