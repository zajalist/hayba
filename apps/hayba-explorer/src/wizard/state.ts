// Wizard draft state shared between the panel UI and the painter. Mirrors
// the Rust `WizardDraft` exactly so it can be JSON-serialised straight into
// the `bake_from_wizard` Tauri command.

export type PresetName = "plates2" | "plates3" | "plates4" | "plates5" | "plates5Uneven";

export interface PresetMeta {
  name: PresetName;
  label: string;
  /** Approximate plate count; used in chip subtitle. */
  plates: number;
  /** Optional second line, e.g. "uneven distribution". */
  note?: string;
}

export const PRESETS: PresetMeta[] = [
  { name: "plates2",       label: "2 plates", plates: 2 },
  { name: "plates3",       label: "3 plates", plates: 3 },
  { name: "plates4",       label: "4 plates", plates: 4 },
  { name: "plates5",       label: "5 plates", plates: 5 },
  { name: "plates5Uneven", label: "5 plates", plates: 5, note: "uneven distribution" },
];

export type BoundaryType = "convergent" | "divergent";

export interface WizardDraft {
  divisions: number;
  seed: number;
  preset: PresetName;
  /** Brush angular radius in radians on the unit sphere. */
  brush_radius_rad: number;
  /** Set of cell ids painted as continental crust. Duplicates tolerated. */
  continental_cells: number[];
  /** Per-plate-pair boundary type — key is sorted "min-max" plate ids. */
  boundary_types: Record<string, BoundaryType>;
  run_length_steps: number;
  dt_ma: number;
  /** Per-cell elevation overrides authored by the height painter.
   *  Length must equal n_cells once known; ignored where painted_mask[i] === 0.
   *  Range: [-1, +1]. */
  painted_elevations: number[];
  /** Per-cell flag: 1 = authored by height painter, 0 = use preset/continental default. */
  painted_mask: number[];
}

export function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function createDefaultDraft(divisions: number, seed: number): WizardDraft {
  return {
    divisions,
    seed,
    preset: "plates4",
    brush_radius_rad: 0.06,
    continental_cells: [],
    boundary_types: {},
    run_length_steps: 5,
    dt_ma: 0.5,
    painted_elevations: [],
    painted_mask: [],
  };
}
