// Wizard draft state shared between the panel UI and the painter. Mirrors
// the Rust `WizardDraft` exactly so it can be JSON-serialised straight into
// the `bake_from_wizard` Tauri command.

export interface WizardPlate {
  id: number;
  color_rgb: [number, number, number];
  density: number;
  continental: boolean;
  initial_omega: [number, number, number];
  /** Cells the user explicitly painted. Empty for auto-fill plates. */
  cell_ids: number[];
}

export interface WizardDraft {
  divisions: number;
  seed: number;
  plates: WizardPlate[];
  run_length_steps: number;
  dt_ma: number;
}

/** Hayba-friendly palette for plates — accent variants + earth-tone hues. */
const PLATE_PALETTE: [number, number, number][] = [
  [181, 106,  29], // accent
  [138,  74, 138], // muted plum
  [ 90,  58, 138], // muted indigo
  [ 58, 122,  90], // muted forest
  [168, 132,  58], // muted goldenrod
  [168,  58,  58], // muted red
  [ 58, 138, 138], // muted teal
  [106, 159, 220], // secondary
  [212, 159, 102], // sand
  [128, 102,  76], // taupe
  [ 91, 116,  74], // olive
  [156,  92, 108], // dusty rose
  [ 76,  98, 142], // deep slate-blue
  [188, 150,  98], // wheat
  [114,  74,  58], // brick
  [ 90, 140, 105], // sage
];

/** Roughly opposing initial omegas so plates push against each other. */
function omegaForIndex(i: number): [number, number, number] {
  const sign = i % 2 === 0 ? 1 : -1;
  const axis = i % 3;
  const v: [number, number, number] = [0, 0, 0];
  v[axis] = sign * 0.008;
  v[(axis + 1) % 3] = sign * 0.003;
  return v;
}

export function createDefaultDraft(divisions: number, seed: number, plateCount = 8): WizardDraft {
  const plates: WizardPlate[] = [];
  for (let i = 0; i < plateCount; i++) {
    const continental = i % 2 === 0; // alternate continental/oceanic by default
    plates.push({
      id: i + 1,
      color_rgb: PLATE_PALETTE[i % PLATE_PALETTE.length],
      density: continental ? 0.35 : 1.05,
      continental,
      initial_omega: omegaForIndex(i),
      cell_ids: [],
    });
  }
  return {
    divisions,
    seed,
    plates,
    run_length_steps: 5,
    dt_ma: 0.5,
  };
}

/** Cell → plate-id lookup table, sized to the current divisions. -1 = unassigned. */
export function buildPlateLookup(draft: WizardDraft, nCells: number): Int32Array {
  const out = new Int32Array(nCells);
  out.fill(-1);
  for (const plate of draft.plates) {
    for (const cellId of plate.cell_ids) {
      if (cellId >= 0 && cellId < nCells) out[cellId] = plate.id;
    }
  }
  return out;
}
