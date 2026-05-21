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
import SettingsPanel, { MAP_MODES } from "./components/panels/SettingsPanel";
import TexturingPanel from "./components/panels/TexturingPanel";
import ClimateLabPanel, { DEFAULT_CLIMATE_PARAMS, type ClimateParams } from "./components/panels/ClimateLabPanel";
import DockToolbar, { type ToolName } from "./components/DockToolbar";
import RecenterButton from "./components/RecenterButton";
import PerfHud from "./components/PerfHud";
import ConfirmDialog from "./components/ConfirmDialog";
import BoundaryPopover from "./components/BoundaryPopover";
import { IconPlay, IconPause, IconReset } from "./components/icons";
import { buildPlateLabels, type PlateLabelsHandle } from "./viewport/overlays/plateLabels";
import { buildForceArrows, type ForceArrowsHandle } from "./viewport/overlays/forceArrows";
import { buildBoundaryLines, type BoundaryLinesHandle } from "./viewport/overlays/boundaryLines";
import { buildPoleLabels,  type PoleLabelsHandle  } from "./viewport/overlays/poleLabels";
import { createDefaultDraft, pairKey, type WizardDraft, type PresetName, type BoundaryType } from "./wizard/state";
import { BoundaryModel, setBoundary, clearBoundary } from "./wizard/boundary-model";
import { buildCellKdTree, cellsWithinRadius, nearestCell, type KdTree } from "./wizard/kdtree";
import { HeightPainter, type BrushConfig } from "./wizard/paint/HeightPainter";
import { earthElevations, earthElevationsFromImage } from "./wizard/earth-template";
import HeightPaintPanel from "./components/panels/HeightPaintPanel";
import { buildPainterMesh, type PainterMeshHandle } from "./viewport/painterMesh";
// Hydraulic equirect bake pipeline (erosion rework). Purely additive — the
// existing wizard / bake_from_wizard flow is untouched; this is a
// debug/validation surface gated behind its own button.
import { uploadEquirect } from "./viewport/bake/equirectInput";
import { runHydraulicBake, DEFAULT_HYDRAULIC } from "./viewport/bake/hydraulic";
import { DEFAULT_BAKE_RES, BAKE_RES_TIERS } from "./viewport/bake/bakeResolution";
import {
  loadFidelity,
  saveFidelity,
  fidelityToTier,
  type Fidelity,
} from "./viewport/bake/fidelity";
import {
  makeDebugReliefMaterial,
  setDebugTexture,
  setDebugMapMode,
  setDebugStack,
} from "./viewport/bake/debugMaterial";
import { nextInteract, type InteractState } from "./viewport/interact";
import {
  EQUIRECT_MAP_MODES,
  resolveEquirectMode,
} from "./viewport/equirectMapModes";

/** `EquirectInputs` as serialized by the Rust `bake_inputs_equirect`
 *  command (`Vec<f32>` arrives over Tauri as a JSON `number[]`). */
interface EquirectInputs {
  w: number;
  h: number;
  height: number[];
  precip: number[];
  /** Metre-denominated world scale (Rust `WorldScale`, serde snake_case).
   *  Planet macro default; S3 overrides per zoom-tile. */
  scale: { terrain_scale: number; verticality: number; feature_scale: number };
}

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
  cell_temperature: number[];
  cell_precip: number[];
  cell_biome: number[];
  cell_biome2: number[];
  cell_biome_blend: number[];
  cell_biome_weights: number[];
  cell_coast_sdf: number[];
  cell_seed: number[];
  climate_debug: {
    insolation: number[];
    base_temp: number[];
    dist_to_ocean: number[];
    wind: number[];
    current_dt: number[];
    orographic: number[];
    continental_dry: number[];
  };
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

// In-app debug stack map-mode registry. Static + future-proof: TERR/HYDRO
// entries are present now and simply render flat (channels read 0) until
// Phase-2 P2.3 fills those RTs. `ramp` ids match debugMaterial.ts ramp().
type DebugStackKind = "relief" | "clim" | "terr" | "hydro";
interface DebugChannelEntry {
  label: string;
  kind: DebugStackKind;
  channel: number; // RGBA lane (ignored for relief)
  ramp: number; // 0 grey | 1 temp | 2 precip | 3 hue | 4 grey-elev
}
const DEBUG_CHANNELS: DebugChannelEntry[] = [
  { label: "Relief", kind: "relief", channel: 0, ramp: 0 },
  { label: "Temp", kind: "clim", channel: 0, ramp: 1 },
  { label: "Precip", kind: "clim", channel: 1, ramp: 2 },
  { label: "Wind", kind: "clim", channel: 2, ramp: 3 },
  { label: "Glaciation", kind: "clim", channel: 3, ramp: 4 },
  { label: "Slope", kind: "terr", channel: 0, ramp: 0 },
  { label: "Aspect", kind: "terr", channel: 1, ramp: 3 },
  { label: "Curvature", kind: "terr", channel: 2, ramp: 0 },
  { label: "Flow", kind: "hydro", channel: 0, ramp: 0 },
  { label: "Elevation", kind: "hydro", channel: 1, ramp: 4 },
  { label: "Endorheic", kind: "hydro", channel: 2, ramp: 0 },
];

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
  const boundaryLinesRef = useRef<BoundaryLinesHandle | null>(null);

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
  const [biomeAssignments, setBiomeAssignments] = useState<Record<number, string>>({});
  const handleAssignBiome = useCallback((bi: number, name: string) => {
    setBiomeAssignments((m) => ({ ...m, [bi]: name }));
    globeMeshRef.current?.setBiomeSatMap(bi, name);
  }, []);
  const [biomeRemap, setBiomeRemap] = useState<Record<number, { min: number; max: number; bias: number }>>({});
  const handleRemapBiome = useCallback((bi: number, r: { min: number; max: number; bias: number }) => {
    setBiomeRemap((m) => ({ ...m, [bi]: r }));
    globeMeshRef.current?.setBiomeRemap(bi, r.min, r.max, r.bias);
  }, []);
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
  const [surfaceBrightness, setSurfaceBrightness] = useState(1.4);
  const [textureSmooth, setTextureSmooth] = useState(0.4);
  const [surfaceSaturation, setSurfaceSaturation] = useState(1.0);
  const [showPlateOutlines, setShowPlateOutlines] = useState(true);
  const [showBoundaryGlow, setShowBoundaryGlow] = useState(true);
  const [mapMode, setMapMode] = useState(0);
  const mapModeRef = useRef(0);
  useEffect(() => { mapModeRef.current = mapMode; }, [mapMode]);

  // Live-tunable climate constants. Defaults are byte-identical to the Rust
  // ClimateParams::default(), so behaviour is unchanged until a slider moves.
  const [climateParams, setClimateParams] = useState<ClimateParams>(DEFAULT_CLIMATE_PARAMS);
  const climateParamsRef = useRef<ClimateParams>(DEFAULT_CLIMATE_PARAMS);
  useEffect(() => { climateParamsRef.current = climateParams; }, [climateParams]);

  useEffect(() => { globeMeshRef.current?.setSatMap(satMap); }, [satMap]);
  // In boundaries mode, flatten the planet (no vertex extrusion) so plate
  // boundary lines aren't occluded by mountain ranges. Exaggeration restores
  // on exit from the boundaries phase.
  useEffect(() => {
    const eff = mode === "boundaries" ? 0 : exaggeration;
    globeMeshRef.current?.setExaggeration(eff);
  }, [exaggeration, mode]);
  useEffect(() => { globeMeshRef.current?.setSurfaceBrightness(surfaceBrightness); }, [surfaceBrightness]);
  useEffect(() => { globeMeshRef.current?.setTextureSmooth(textureSmooth); }, [textureSmooth]);
  useEffect(() => { globeMeshRef.current?.setSurfaceSaturation(surfaceSaturation); }, [surfaceSaturation]);
  useEffect(() => { globeMeshRef.current?.setShowPlateOutlines(showPlateOutlines); }, [showPlateOutlines]);
  useEffect(() => { globeMeshRef.current?.setShowBoundaryGlow(showBoundaryGlow); }, [showBoundaryGlow]);
  useEffect(() => { globeMeshRef.current?.setMapMode(mapMode); }, [mapMode]);

  // Click-on-planet boundary popover (replaces selected-seam editor in the side panel)
  const [boundaryPopover, setBoundaryPopover] = useState<{
    screenX: number; screenY: number; plateA: number; plateB: number;
  } | null>(null);

  // Cell inspector — simulating mode only. Click a cell to read its sim state.
  const [selectedCell, setSelectedCell] = useState<number | null>(null);

  // Hydraulic equirect bake path (debug/validation). Separate from the
  // wizard `bake_from_wizard` flow above — flipping this on swaps the
  // displayed globe for a relief-shaded debug sphere driven by the GPU
  // hydraulic erosion bake. State is independent so the existing app is
  // unaffected.
  const debugMatRef = useRef<THREE.ShaderMaterial | null>(null);
  // Ownership-transfer refs: runHydraulicBake hands back the owning eroded
  // equirect WebGLRenderTarget (its .dispose() frees BOTH the GL
  // framebuffer AND .texture — a bare texture.dispose() would leak the
  // FBO); uploadEquirect hands back the static Base/Precip DataTextures
  // (runHydraulicBake does NOT dispose its inputs). None of these are
  // disposed by the pipeline, so we track the previous bake's resources
  // and dispose them before allocating new ones to prevent VRAM leaks on
  // repeated bake clicks. (`prevDebugBaseRef` is the no-erosion toggle
  // texture for the CURRENT globe, so it is only freed when SUPERSEDED.)
  const prevDebugHFinalRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const prevDebugBaseRef = useRef<THREE.DataTexture | null>(null);
  const prevDebugPrecipRef = useRef<THREE.DataTexture | null>(null);
  // Stack RTs from the latest bake (caller-owned per HydraulicBakeResult).
  // Disposed on the NEXT bake exactly like prevDebugHFinalRef — mirrors
  // the existing eroded-RT discipline (no unmount cleanup is added; that
  // matches how the eroded RT is already handled).
  const prevDebugClimRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const prevDebugTerrRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const prevDebugHydroRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const prevDebugWindRef = useRef<THREE.WebGLRenderTarget | null>(null);
  // COOKBOOK-CLIMATE T2: distance-to-ocean + continentality RT (JFA).
  const prevDebugDistRef = useRef<THREE.WebGLRenderTarget | null>(null);
  // COOKBOOK-CLIMATE T3: mean-sea-level pressure RT (MSLP_FRAG output).
  const prevDebugPressureRef = useRef<THREE.WebGLRenderTarget | null>(null);
  // COOKBOOK-CLIMATE T4: Köppen-Geiger climate class + cookbook precip RT.
  const prevDebugClimateRef = useRef<THREE.WebGLRenderTarget | null>(null);
  // Live stack handles for the mounted material's selector.
  const debugStackRef = useRef<{
    clim: THREE.WebGLRenderTarget;
    terr: THREE.WebGLRenderTarget;
    hydro: THREE.WebGLRenderTarget;
  } | null>(null);
  const [debugBaking, setDebugBaking] = useState(false);
  const [debugBakeProgress, setDebugBakeProgress] = useState<string | null>(null);
  const [debugBakeReady, setDebugBakeReady] = useState(false);
  const [initializingGrid, setInitializingGrid] = useState(false);
  // SP-A: the single authority for globe interactivity. `compose` =
  // paint strokes editable; `explore` = orbit + stack view only. A ref
  // mirror so pointer/effect closures read the live value with no
  // stale-closure risk. Replaces the painter-visibility hack.
  const [interact, setInteract] = useState<InteractState>("compose");
  const interactRef = useRef<InteractState>("compose");
  useEffect(() => {
    interactRef.current = interact;
  }, [interact]);
  const [debugMapMode, setDebugMapModeState] = useState(0);
  const [debugChannelIdx, setDebugChannelIdx] = useState(0); // 0 = Relief
  const [perfHudOn, setPerfHudOn] = useState(false);
  // NX-1: user-selectable bake resolution tier (0=1024² default).
  const [bakeTier, setBakeTier] = useState(() => fidelityToTier(loadFidelity()));
  const [fidelity, setFidelity] = useState<Fidelity>(() => loadFidelity());
  const [debugDraped, setDebugDraped] = useState(true); // draped vs flat
  const handleChangeFidelity = useCallback((f: Fidelity) => {
    setFidelity(f);
    setBakeTier(fidelityToTier(f));
    saveFidelity(f);
  }, []);
  // T4-TUNE-15: user-tunable sea level (applied at next bake). Persists
  // across reloads via localStorage so the user's chosen shoreline
  // sticks. Default matches DEFAULT_HYDRAULIC.seaLevel.
  const [seaLevel, setSeaLevel] = useState<number>(() => {
    try {
      const v = parseFloat(localStorage.getItem("hayba.seaLevel") ?? "");
      return Number.isFinite(v) ? v : DEFAULT_HYDRAULIC.seaLevel;
    } catch {
      return DEFAULT_HYDRAULIC.seaLevel;
    }
  });
  const handleChangeSeaLevel = useCallback((v: number) => {
    setSeaLevel(v);
    try { localStorage.setItem("hayba.seaLevel", String(v)); } catch {}
  }, []);

  // Playback speed (steps per rAF tick). 1× is the wizard's dt_ma per frame.
  const [speedMult, setSpeedMult] = useState<1 | 2 | 4 | 8>(1);
  const speedRef = useRef<1 | 2 | 4 | 8>(1);
  useEffect(() => { speedRef.current = speedMult; }, [speedMult]);

  // SP-B: push the selected equirect map-mode onto the live material.
  // No re-bake — instant. Relief→uStackMode 0, Normal→3 (no tex),
  // clim→stack channel + ramp, draped(1)/flat(2) per the F toggle.
  const applyDebugChannel = useCallback(
    (idx: number, draped: boolean) => {
      const mat = debugMatRef.current;
      if (!mat) return;
      const sel = resolveEquirectMode(idx, draped);
      const stack = debugStackRef.current;
      if (sel.kind === "relief" || sel.kind === "normal" || !stack) {
        // Height-derived modes need no stack texture; if the stack
        // isn't ready yet, relief is the safe fallback.
        setDebugStack(mat, {
          tex: null,
          channel: 0,
          mode: sel.kind === "normal" ? 3 : 0,
          ramp: 0,
        });
        sceneRef.current?.setWindSource(
          sel.kind === "wind" ? (prevDebugWindRef.current ?? null) : null,
          sel.kind === "wind" ? (stack?.clim ?? null) : null,
        );
        sceneRef.current?.setWindAnim(sel.kind === "wind" && debugBakeReady);
        sceneRef.current?.markDirty();
        return;
      }
      // COOKBOOK-CLIMATE T3: route DIST/PRESSURE modes to their dedicated
      // RTs (App-owned refs, set by handleBake). Falls back to clim if
      // the dedicated RT isn't ready yet.
      let stackTex: THREE.Texture = stack.clim.texture;
      if (sel.kind === "dist") {
        const rt = prevDebugDistRef.current;
        if (rt) stackTex = rt.texture;
      } else if (sel.kind === "pressure") {
        const rt = prevDebugPressureRef.current;
        if (rt) stackTex = rt.texture;
      } else if (sel.kind === "climate") {
        const rt = prevDebugClimateRef.current;
        if (rt) stackTex = rt.texture;
      } else if (sel.kind === "hydro") {
        // Rivers / Lakes map modes sample the HYDRO RT directly.
        stackTex = stack.hydro.texture;
      }
      setDebugStack(mat, {
        tex: stackTex,
        channel: sel.channel,
        mode: sel.mode,
        ramp: sel.ramp,
      });
      sceneRef.current?.setWindSource(
        sel.kind === "wind" ? (prevDebugWindRef.current ?? null) : null,
        sel.kind === "wind" ? stack.clim : null,
      );
      sceneRef.current?.setWindAnim(sel.kind === "wind" && debugBakeReady);
      sceneRef.current?.markDirty();
    },
    [debugBakeReady],
  );

  // `F` flips draped<->flat for the active non-relief stack channel.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "f" && ev.key !== "F") return;
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!debugBakeReady) return;
      setDebugDraped((d) => {
        const next = !d;
        applyDebugChannel(debugChannelIdx, next);
        return next;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [debugBakeReady, debugChannelIdx, applyDebugChannel]);

  // NX-1: `P` toggles the perf HUD (ignored while typing in a field).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "p" && ev.key !== "P") return;
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      setPerfHudOn((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    let init!: WizardInit;
    setInitializingGrid(true);
    try {
      init = await invoke<WizardInit>("start_wizard", { divisions });
    } finally {
      setInitializingGrid(false);
    }
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

  // Live climate re-snapshot. When the user moves a Climate Lab slider and a
  // baked planet exists (and we're NOT actively playing — the rAF tick loop
  // already feeds the latest params each frame), re-run the climate model on
  // the persisted sim WITHOUT advancing it: step_planet with nSteps:0 runs the
  // `for _ in 0..n_steps` loop zero times, so the tectonic state is untouched
  // and only the climate fields are recomputed with the new params. Skipped
  // pre-bake (no persisted model) and while playing (would double-step).
  useEffect(() => {
    if (mode === "wizard" || mode === "baking") return;
    if (!snapshotRef.current || playing) return;
    let cancelled = false;
    invoke<PlanetSnapshot>("step_planet", {
      nSteps: 0,
      wantClimateDebug: true,
      climateParams,
    })
      .then((snap) => {
        if (cancelled) return;
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
      })
      .catch((e) => setError(String(e)));
    return () => { cancelled = true; };
    // Intentionally keyed only on climateParams: this is the param-change
    // refresh, not a general snapshot/mode reaction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [climateParams]);

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
      invoke<PlanetSnapshot>("step_planet", {
        nSteps: speedRef.current,
        wantClimateDebug: true,
        climateParams: climateParamsRef.current,
      })
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
      // Proximity pick — at high cell counts boundary cells are a thin
      // strip and direct hits are unreliable. We snap to the closest
      // boundary cell within a small angular radius around the cursor.
      // Chord 0.015 ≈ 0.86° on the unit sphere (~5 cells at 1.5M).
      const PROX_CHORD = 0.015;
      const candidates = cellsWithinRadius(tree, p.x, p.y, p.z, PROX_CHORD);
      let bestCell = -1;
      let bestKey: string | null = null;
      let bestD2 = Infinity;
      const pos = tree.positions;
      for (const c of candidates) {
        const k = bm.pairKeyForCell(c);
        if (!k) continue;
        const ix = c * 3;
        const dx = pos[ix] - p.x;
        const dy = pos[ix + 1] - p.y;
        const dz = pos[ix + 2] - p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; bestCell = c; bestKey = k; }
      }
      // Fallback: direct hit cell (in case the cell itself IS a boundary
      // but is somehow outside the candidate radius — defensive).
      if (!bestKey) {
        const directCell = nearestCell(tree, p.x, p.y, p.z);
        const directKey = bm.pairKeyForCell(directCell);
        if (directKey) { bestCell = directCell; bestKey = directKey; }
      }
      console.log(`[boundary-click] cell=${bestCell} pairKey=${bestKey ?? "(none-near)"}`);
      if (!bestKey) {
        setBoundaryPopover(null);
        return;
      }
      const members = bm.membersFor(bestKey);
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
    const active =
      panelCategory === "compose" && mode === "wizard" && interact === "compose";

    if (!active) {
      if (painterMeshRef.current) {
        scene.scene.remove(painterMeshRef.current.object);
        painterMeshRef.current.dispose();
        painterMeshRef.current = null;
      }
      if (globeRef.current) {
        // Only un-hide the point-cloud globe when going back to a
        // paint-editable state. In `explore` the eroded equirect sphere
        // is the globe (via setGlobe) and the point cloud must stay
        // hidden or it double-renders over it.
        globeRef.current.object.visible = interactRef.current === "compose";
      }
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
          defaultElevation: -1, // compose starts as uniform extreme deep ocean
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
      // Rebuilding the paint view supersedes any hydraulic debug-relief
      // globe from a prior bake: drop it (setGlobe(null) disposes its
      // geometry+material) and clear the ready flag so a fresh, visible
      // painter mesh is the only thing on screen — never the relief sphere
      // overlaying it. The bound RT/Base textures are owned by the
      // prevDebug*Ref disposal chain, not by the material, so this does not
      // double-free them.
      scene.setGlobe(null);
      setDebugBakeReady(false);

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
      if (globeRef.current) {
        // Only un-hide the point-cloud globe when going back to a
        // paint-editable state. In `explore` the eroded equirect sphere
        // is the globe (via setGlobe) and the point cloud must stay
        // hidden or it double-renders over it.
        globeRef.current.object.visible = interactRef.current === "compose";
      }
    };
  }, [panelCategory, mode, draft?.divisions, interact]);

  // Height-painter pointer interactions. Gated on the compose panel pre-bake
  // in wizard mode. Shift inverts raise<->lower.
  useEffect(() => {
    if (panelCategory !== "compose" || mode !== "wizard") return;
    if (interactRef.current !== "compose") return;
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
      // Pick against the invisible unit sphere (same as the boundary picker
      // and cell inspector). The painter mesh is GPU-displaced so CPU
      // raycasting it gives the same undisplaced result anyway, and its
      // group also contains the cursor-ring Line which the raycaster would
      // otherwise intercept (Lines have a huge default pick threshold).
      const hits = ray.intersectObject(scene.raycastTarget, false);
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
  }, [panelCategory, mode, paintBrush, interact]);

  // Live-apply boundary assignments — Rust rewrites plate omegas on the
  // running model. No snapshot returned: cells/biomes haven't moved, only
  // future-step omegas changed. The boundary-lines overlay re-tints from
  // the draft.boundary_types change, and the GPU mesh state is unchanged.
  const applyBoundaryTypesLive = useCallback(async (types: Record<string, BoundaryType>) => {
    try {
      await invoke<void>("apply_boundary_types", { boundaryTypes: types });
      // Recolor plate outlines using the EXISTING snapshot — assignment
      // types changed but cell→plate mapping is identical.
      const snap = snapshotRef.current;
      if (snap) {
        const bm = boundaryModelRef.current ?? BoundaryModel.fromSnapshot(snap);
        boundaryModelRef.current = bm;
        globeRef.current?.recolorFromSnapshot(snap, PLATE_PALETTE, { model: bm, assignments: types });
      }
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
    const scene = sceneRef.current;
    if (!draft || !scene || debugBaking) return;
    setDebugBaking(true);
    setMode("baking");
    setDebugBakeProgress("Rasterising inputs…");
    let __pollId: number | undefined;
    try {
      const paintedFields = heightPainterRef.current
        ? heightPainterRef.current.toDraftFields()
        : { painted_elevations: [], painted_mask: [] };
      const finalDraft: WizardDraft = { ...draft, ...paintedFields };
      // NB: poll the Rust bake phase so the (now non-blocking) bake
      // shows progress instead of a frozen UI.
      __pollId = window.setInterval(() => {
        void (async () => {
          try {
            const ph = await invoke<number>("poll_bake_progress");
            setDebugBakeProgress(
              [
                "Preparing…",
                "Tectonic + erosion bake…",
                "Building snapshot…",
                "Finalising…",
              ][ph] ?? null,
            );
          } catch {
            /* poll best-effort; ignore */
          }
        })();
      }, 250);
      const __tStart = performance.now();
      const __tW0 = performance.now();

      // SP-A: Bake runs BOTH. (1) Rust bake_from_wizard → PlanetSnapshot
      // (kept for later-stage migration; the boundaries/densities/
      // simulating code is byte-untouched but not entered from Bake in
      // SP-A). (2) The GPU equirect erosion pipeline, whose eroded
      // relief sphere is the displayed post-bake planet.
      const snap = await invoke<PlanetSnapshot>("bake_from_wizard", {
        draft: finalDraft,
        wantClimateDebug: true,
        climateParams: climateParamsRef.current,
      });
      setSnapshot(snap);
      const __wizardMs = performance.now() - __tW0;
      const __tE0 = performance.now();

      // ONE (w,h) drives the Rust raster invoke AND both uploadEquirect
      // calls AND runHydraulicBake — they must match exactly.
      const w = DEBUG_BAKE_W;
      const h = DEBUG_BAKE_H;
      const inp = await invoke<EquirectInputs>("bake_inputs_equirect", {
        draft: finalDraft,
        w,
        h,
      });
      const __equirectMs = performance.now() - __tE0;

      // Dispose the PREVIOUS bake's GPU resources before allocating new
      // ones (the only escape from runHydraulicBake is the 4 RTs; the
      // Base/Precip DataTextures are caller-owned). On first bake the
      // refs are null — ?. no-ops.
      prevDebugBaseRef.current?.dispose();
      prevDebugPrecipRef.current?.dispose();
      prevDebugHFinalRef.current?.dispose();
      prevDebugClimRef.current?.dispose();
      prevDebugTerrRef.current?.dispose();
      prevDebugHydroRef.current?.dispose();
      prevDebugWindRef.current?.dispose();
      prevDebugDistRef.current?.dispose();
      prevDebugPressureRef.current?.dispose();
      prevDebugClimateRef.current?.dispose();

      const __tU0 = performance.now();
      const base = uploadEquirect(new Float32Array(inp.height), w, h);
      const precip = uploadEquirect(new Float32Array(inp.precip), w, h);
      const __uploadMs = performance.now() - __tU0;
      const __tG0 = performance.now();

      let rt!: THREE.WebGLRenderTarget;
      let climRT!: THREE.WebGLRenderTarget;
      let terrRT!: THREE.WebGLRenderTarget;
      let hydroRT!: THREE.WebGLRenderTarget;
      let windRT!: THREE.WebGLRenderTarget;
      let distRT!: THREE.WebGLRenderTarget;
      let pressureRT!: THREE.WebGLRenderTarget;
      let climateRT!: THREE.WebGLRenderTarget;
      await scene.runBake(async (renderer) => {
        const out = await runHydraulicBake(
          renderer,
          base,
          precip,
          w,
          h,
          {
            ...DEFAULT_HYDRAULIC,
            seaLevel,
            // Rust serde snake_case -> HydraulicConfig camelCase.
            scale: {
              terrainScale: inp.scale.terrain_scale,
              verticality: inp.scale.verticality,
              featureScale: inp.scale.feature_scale,
            },
          },
          (done, total) => {
            setDebugBakeProgress(`Eroding — step ${done}/${total}`);
          },
        );
        rt = out.eroded;
        climRT = out.clim;
        terrRT = out.terr;
        hydroRT = out.hydro;
        windRT = out.wind;
        distRT = out.dist;
        pressureRT = out.pressure;
        climateRT = out.climate;
      });
      const __gpuMs = performance.now() - __tG0;
      sceneRef.current?.setBakeSplit({
        wizard: __wizardMs,
        equirect: __equirectMs,
        upload: __uploadMs,
        gpuSim: __gpuMs,
        total: performance.now() - __tStart,
      });

      prevDebugHFinalRef.current = rt;
      prevDebugBaseRef.current = base;
      prevDebugPrecipRef.current = precip;
      prevDebugClimRef.current = climRT;
      prevDebugTerrRef.current = terrRT;
      prevDebugHydroRef.current = hydroRT;
      prevDebugWindRef.current = windRT;
      prevDebugDistRef.current = distRT;
      prevDebugPressureRef.current = pressureRT;
      prevDebugClimateRef.current = climateRT;
      debugStackRef.current = { clim: climRT, terr: terrRT, hydro: hydroRT };

      const mat = makeDebugReliefMaterial();
      setDebugTexture(mat, rt.texture, base);
      setDebugMapMode(mat, debugMapMode);
      debugMatRef.current = mat;
      applyDebugChannel(debugChannelIdx, debugDraped);

      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), mat);
      mesh.name = "hayba-eroded-planet";
      scene.setGlobe(mesh);

      // SP-A: explicit state — no painter-visibility games. The painter-
      // lifecycle effect is now gated on interact==="compose"; flipping
      // to "explore" deactivates it (its cleanup removes+disposes the
      // painter mesh) so the eroded sphere is the only globe.
      //
      // Post-bake → boundaries: user picks plate boundary types (click
      // any pink seam → convergent / divergent) before advancing to
      // densities and Play. Replaces the old "stay in wizard after bake"
      // SP-A decision — the bake → boundaries → densities → simulate
      // pipeline mirrors the TectonicsExplorer flow the user wants.
      setMode("boundaries");
      setInteract(nextInteract(interactRef.current, "bake"));

      setDebugBakeReady(true);
      setDebugBakeProgress(null);
      console.log(`[bake] ✓ unified equirect bake — ${w}×${h}`);
    } catch (e) {
      setError(String(e));
      setDebugBakeProgress(null);
      setMode("wizard");
    } finally {
      if (__pollId !== undefined) window.clearInterval(__pollId);
      setDebugBaking(false);
    }
  }, [
    draft,
    debugBaking,
    debugMapMode,
    applyDebugChannel,
    debugChannelIdx,
    debugDraped,
  ]);

  // Phase-2 P2.1: resolution comes from the tier module (default
  // 2048x1024 ≈ 2.1M; ceiling tier ≈ 3.3M). A UI chip to choose the
  // tier is P2.5; selecting here keeps the ceiling/guard shipping now.
  // NX-1: the selector drives the next bake's resolution; default tier
  // 0 (1024×512) = DEFAULT_BAKE_RES. clampBakeRes already guards range.
  const tier = BAKE_RES_TIERS[bakeTier] ?? DEFAULT_BAKE_RES;
  const DEBUG_BAKE_W = tier.w;
  const DEBUG_BAKE_H = tier.h;


  const handleEditWizard = useCallback(() => {
    previewRef.current = [];
    invoke("reset_sim").catch(() => {});
    // SP-A: the ONLY path explore → compose. Tear down the eroded globe
    // + its 4 caller-owned stack RTs (setGlobe(null) disposes the sphere
    // geometry+material; the RTs are NOT owned by the material so are
    // freed explicitly here, mirroring the pre-bake dispose discipline),
    // then re-enter compose — the painter-lifecycle effect (gated on
    // interact==="compose") rebuilds the paint view.
    const scene = sceneRef.current;
    if (scene) scene.setGlobe(null);
    sceneRef.current?.setWindAnim(false);
    prevDebugHFinalRef.current?.dispose();
    prevDebugClimRef.current?.dispose();
    prevDebugTerrRef.current?.dispose();
    prevDebugHydroRef.current?.dispose();
    prevDebugDistRef.current?.dispose();
    prevDebugPressureRef.current?.dispose();
    prevDebugClimateRef.current?.dispose();
    prevDebugBaseRef.current?.dispose();
    prevDebugPrecipRef.current?.dispose();
    prevDebugHFinalRef.current = null;
    prevDebugClimRef.current = null;
    prevDebugTerrRef.current = null;
    prevDebugHydroRef.current = null;
    prevDebugDistRef.current = null;
    prevDebugPressureRef.current = null;
    prevDebugClimateRef.current = null;
    prevDebugBaseRef.current = null;
    prevDebugPrecipRef.current = null;
    debugStackRef.current = null;
    debugMatRef.current = null;
    setDebugBakeReady(false);
    // Tear down the pink-seam overlay — its geometry is built from the
    // current snapshot and would point at stale cells after Edit.
    if (boundaryLinesRef.current) {
      scene?.scene.remove(boundaryLinesRef.current.object);
      boundaryLinesRef.current.dispose();
      boundaryLinesRef.current = null;
    }
    setInteract(nextInteract(interactRef.current, "edit"));
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
    texturing:  mode === "boundaries" || mode === "densities" || mode === "simulating",
    climate:    mode === "boundaries" || mode === "densities" || mode === "simulating",
    boundaries: mode === "boundaries" || mode === "densities" || mode === "simulating",
    densities:  mode === "densities" || mode === "simulating",
    simulate:   mode === "simulating",
    settings:   true,
  };
  const categoryDisabledReason: Partial<Record<PanelCategory, string>> = {
    texturing:  "Bake the planet first",
    climate:    "Bake the planet first",
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

  // Pink-seam overlay (BoundaryLines). Lazily built on first snapshot
  // (needs adjacency, which itself is lazily built inside the painter
  // lifecycle effect — we trigger it here by reading trianglesRef and
  // building adj if missing). Visible whenever the user is on the
  // boundaries / densities / simulating stage so the seams stay readable
  // throughout the post-bake flow; coloured by the user's per-pair
  // assignments (red = convergent, blue = divergent, pink = unset).
  useEffect(() => {
    const scene = sceneRef.current;
    const snap = snapshot;
    if (!scene || !snap || !draft) return;

    // Triangles + adjacency might not have been built yet (e.g. the user
    // never opened the compose panel before baking). Build them on demand
    // so the overlay always has the adjacency map it needs.
    let cancelled = false;
    void (async () => {
      if (!trianglesRef.current) {
        try {
          const tris = await invoke<number[]>("get_grid_triangles", { divisions: draft.divisions });
          if (cancelled) return;
          trianglesRef.current = new Uint32Array(tris);
        } catch (e) {
          setError(String(e));
          return;
        }
      }
      if (!adjRef.current && trianglesRef.current) {
        adjRef.current = buildAdjacency(trianglesRef.current, snap.n_cells);
      }
      const adj = adjRef.current;
      if (!adj) return;

      if (!boundaryLinesRef.current) {
        const handle = buildBoundaryLines(adj);
        boundaryLinesRef.current = handle;
        scene.scene.add(handle.object);
      }
      const lines = boundaryLinesRef.current;
      lines.update(snap, draft.boundary_types);
      const show = mode === "boundaries" || mode === "densities" || mode === "simulating";
      lines.setVisible(show);
      scene.markDirty();
    })();

    return () => { cancelled = true; };
  }, [snapshot, draft, mode]);

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
        <PerfHud
          visible={perfHudOn}
          getSnapshot={() => sceneRef.current?.perfSnapshot()}
        />

        {/* SP-B: equirect map-mode bar (bottom-left). Drives the live
            eroded-planet material via applyDebugChannel — no re-bake.
            Shown only once a bake is ready (where the SP-A View panel
            was). The cell MAP_MODES/setMapMode path is untouched. */}
        {draft && debugBakeReady && (
        <div
          style={{
            position: "absolute",
            bottom: 12,
            left: 12,
            maxWidth: 540,
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 3,
            padding: "5px 7px",
            background: "rgba(20, 22, 28, 0.82)",
            border: `1px solid ${debugChannelIdx !== 0 ? "#B56A1D" : "#2f343d"}`,
            borderRadius: 5,
            backdropFilter: "blur(4px)",
            zIndex: 50,
            pointerEvents: "auto",
          }}
        >
          <span
            style={{
              fontSize: 10,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              color: "#9aa0aa",
              fontFamily: '"Segoe UI", system-ui, sans-serif',
              marginRight: 4,
            }}
          >
            Map
          </span>
          <select
            title="Bake resolution tier"
            value={bakeTier}
            onChange={(ev) => setBakeTier(Number(ev.target.value))}
            style={{
              fontSize: 10,
              marginRight: 4,
              background: "transparent",
              color: "#a8aeb8",
              border: "1px solid #3d434e",
              borderRadius: 3,
            }}
          >
            {BAKE_RES_TIERS.map((t, i) => (
              <option key={`${t.w}x${t.h}`} value={i}>
                {t.w}×{t.h}
              </option>
            ))}
          </select>
          {EQUIRECT_MAP_MODES.map((m, i) => {
            const on = i === debugChannelIdx;
            return (
              <button
                key={m.label}
                onClick={() => {
                  setDebugChannelIdx(i);
                  applyDebugChannel(i, debugDraped);
                }}
                title={m.label}
                style={{
                  padding: "3px 7px",
                  fontSize: 11,
                  fontFamily: '"Segoe UI", system-ui, sans-serif',
                  borderRadius: 3,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  background: on ? "rgba(181,106,29,0.22)" : "transparent",
                  border: `1px solid ${on ? "#B56A1D" : "#3d434e"}`,
                  color: on ? "#DED4C3" : "#a8aeb8",
                }}
              >
                {m.label}
              </button>
            );
          })}
          <span
            style={{
              fontSize: 10,
              opacity: 0.6,
              marginLeft: 4,
              fontFamily: '"Segoe UI", system-ui, sans-serif',
              color: "#9aa0aa",
            }}
          >
            {debugChannelIdx <= 1
              ? ""
              : debugDraped
                ? "F = flat"
                : "F = draped"}
          </span>
        </div>
        )}

      </div>

      <RightPanel
        active={panelCategory}
        enabled={categoryEnabled}
        disabledReason={categoryDisabledReason}
        onPick={setPanelCategory}
      >
        {panelCategory === "compose" && draft && (
          <ComposePanel
            draft={draft}
            busy={mode === "baking" || initializingGrid}
            onChangeDivisions={handleChangeDivisions}
            onChangePreset={handleChangePreset}
            onReroll={handleReroll}
            onBake={handleBake}
          >
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
              onLoadEarth={() => {
                const p = heightPainterRef.current;
                const positions = positionsRef.current;
                if (!p || !positions) return;
                void (async () => {
                  let field: Float32Array;
                  try {
                    field = await earthElevationsFromImage(positions, p.n);
                  } catch (err) {
                    console.warn("[earth] heightmap load failed, using analytic fallback:", err);
                    field = earthElevations(positions, p.n);
                  }
                  p.loadField(field);
                  painterMeshRef.current?.syncFromPainter(p);
                  setPaintedCount(p.n);
                  setCanUndo(true);
                  setCanRedo(false);
                })();
              }}
            />
          </ComposePanel>
        )}

        {panelCategory === "texturing" && snapshot && (
          <TexturingPanel assignments={biomeAssignments} remap={biomeRemap} onAssign={handleAssignBiome} onRemap={handleRemapBiome} brightness={surfaceBrightness} onBrightness={setSurfaceBrightness} smooth={textureSmooth} onSmooth={setTextureSmooth} saturation={surfaceSaturation} onSaturation={setSurfaceSaturation} />
        )}

        {panelCategory === "climate" && snapshot && (
          <ClimateLabPanel
            params={climateParams}
            onChange={setClimateParams}
            onFocusGroup={(m) => setMapMode(m)}
          />
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
            mapMode={mapMode}
            onChangeMapMode={setMapMode}
            fidelity={fidelity}
            onChangeFidelity={handleChangeFidelity}
            seaLevel={seaLevel}
            onChangeSeaLevel={handleChangeSeaLevel}
          />
        )}
      </RightPanel>

      <div style={{ gridColumn: "1 / span 2" }}>
        <StatusBar
          mode={statusMode(mode)}
          chips={statusChips(mode, draft, snapshot, cellCountRef.current)}
          hint={statusHint(mode)}
          busy={initializingGrid ? "Building grid…" : mode === "baking" ? "Baking…" : undefined}
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
