// SP-B: the single source of truth for the bottom-left map-mode bar on
// the eroded equirect planet AND for App's applyDebugChannel. Pure +
// headless so the bar↔material contract is unit-tested without GL.
//
// Only the 6 modes that have real equirect data now (user decision:
// "only modes with real data + grow later"). TERR/HYDRO and the other
// ex-cell modes are added when Phase-2 P2.3 / P2.2-oro fill the stack.
//
// `kind`:
//   "relief" → debugMaterial uStackMode 0 (hypsometric + hillshade)
//   "normal" → debugMaterial uStackMode 3 (RGB normal map; SP-B)
//   "clim"   → stack channel `channel` ramped by `ramp`, drawn draped
//              (uStackMode 1) or flat (uStackMode 2) per the F toggle
// `channel`/`ramp` are ignored for relief/normal.

export type EquirectModeKind =
  | "relief"
  | "normal"
  | "clim"
  | "wind"
  | "dist"
  | "pressure"
  | "climate"
  | "hydro";

export interface EquirectMapMode {
  label: string;
  kind: EquirectModeKind;
  channel: number; // CLIM RGBA lane (0..3); ignored for relief/normal
  ramp: number; // debugMaterial ramp id; ignored for relief/normal
}

export const EQUIRECT_MAP_MODES: EquirectMapMode[] = [
  { label: "Relief", kind: "relief", channel: 0, ramp: 0 },
  { label: "Normal", kind: "normal", channel: 0, ramp: 0 },
  { label: "Temperature", kind: "clim", channel: 0, ramp: 1 },
  // COOKBOOK-CLIMATE T4: Precipitation now reads CLASS.g (cookbook
  // precip per Köppen-Geiger class), NOT CLIM.g (zonal). Monsoon
  // coasts get wet, deserts get dry, etc. — the cookbook table.
  { label: "Precipitation", kind: "climate", channel: 1, ramp: 2 },
  { label: "Wind", kind: "wind", channel: 2, ramp: 3 },
  { label: "Glaciation", kind: "clim", channel: 3, ramp: 4 },
  // COOKBOOK-CLIMATE T3/T4 geographic-debug modes.
  // Ramps: 0=grey (distKm), 5=continentality (Conrad green→red),
  // 6=meteorological diverging (pressure),
  // 7=Köppen-Geiger discrete (climate class id).
  { label: "Distance", kind: "dist", channel: 0, ramp: 0 },
  { label: "Continentality", kind: "dist", channel: 1, ramp: 5 },
  { label: "Pressure", kind: "pressure", channel: 0, ramp: 6 },
  { label: "Climate", kind: "climate", channel: 0, ramp: 7 },
  // HYDRO RT (already baked): .r = flow discharge (rivers), .b =
  // endorheic flag (lake basins). Both rendered with ramp 8 (river-blue
  // threshold gradient — bright cyan above threshold, tan below).
  { label: "Rivers", kind: "hydro", channel: 0, ramp: 8 },
  { label: "Lakes", kind: "hydro", channel: 2, ramp: 8 },
];

/** Resolved selection for `setDebugStack`. `mode` is the debugMaterial
 *  `uStackMode`: relief→0, clim draped→1, clim flat→2, normal→3,
 *  wind-anim draped→4, wind-anim flat→5. The caller resolves the actual
 *  stack texture (clim RT) for clim/wind modes. */
export interface EquirectStackSel {
  kind: EquirectModeKind;
  channel: number;
  ramp: number;
  mode: number;
}

export function resolveEquirectMode(
  idx: number,
  draped: boolean,
): EquirectStackSel {
  const e = EQUIRECT_MAP_MODES[idx] ?? EQUIRECT_MAP_MODES[0];
  if (e.kind === "relief") {
    return { kind: "relief", channel: 0, ramp: 0, mode: 0 };
  }
  if (e.kind === "normal") {
    return { kind: "normal", channel: 0, ramp: 0, mode: 3 };
  }
  if (e.kind === "wind") {
    // NX-3: animated wind-streak shader (uStackMode 4 draped / 5 flat).
    return { kind: "wind", channel: e.channel, ramp: e.ramp, mode: draped ? 4 : 5 };
  }
  // COOKBOOK-CLIMATE T3/T4: dist/pressure/climate all use the SAME
  // uStackMode as clim (1 draped / 2 flat) because debugMaterial just
  // samples uStackTex and applies the indexed ramp. Only the source RT
  // differs (App.tsx routes DIST/MSLP/CLASS into uStackTex per kind).
  if (
    e.kind === "dist" ||
    e.kind === "pressure" ||
    e.kind === "climate" ||
    e.kind === "hydro"
  ) {
    return { kind: e.kind, channel: e.channel, ramp: e.ramp, mode: draped ? 1 : 2 };
  }
  return {
    kind: "clim",
    channel: e.channel,
    ramp: e.ramp,
    mode: draped ? 1 : 2,
  };
}
