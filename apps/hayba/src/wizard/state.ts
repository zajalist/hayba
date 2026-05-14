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

export interface WizardDraft {
  divisions: number;
  seed: number;
  preset: PresetName;
  /** Brush angular radius in radians on the unit sphere. */
  brush_radius_rad: number;
  /** Set of cell ids painted as continental crust. Duplicates tolerated. */
  continental_cells: number[];
  run_length_steps: number;
  dt_ma: number;
}

export function createDefaultDraft(divisions: number, seed: number): WizardDraft {
  return {
    divisions,
    seed,
    preset: "plates4",
    brush_radius_rad: 0.06, // ≈ 3.4° great-circle radius — comfortable default brush
    continental_cells: [],
    run_length_steps: 5,
    dt_ma: 0.5,
  };
}
