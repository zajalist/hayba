import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";
import type { PlanetSnapshot } from "../../App";

export interface SimulatePanelProps {
  era: string;
  simTimeMa: number;
  steps: number;
  /** Currently inspected cell id (null if user hasn't clicked anything). */
  selectedCell: number | null;
  snapshot: PlanetSnapshot | null;
}

/** Educational/inspector panel — TE-style cell readout + a small glossary.
 *  Playback controls (play/pause/reset/speed) live in the status bar, not
 *  here, because they're chrome that should remain accessible at all times. */
export default function SimulatePanel(p: SimulatePanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 12 }}>

        <PropertySection heading="Timeline">
          <PropertyRow label="Era"   value={p.era} />
          <PropertyRow label="Time"  value={`${p.simTimeMa.toFixed(1)} Ma`} />
          <PropertyRow label="Steps" noSeparator value={p.steps} />
        </PropertySection>

        <PropertySection heading="Cell inspector">
          {p.selectedCell !== null && p.snapshot ? (
            <CellReadout snap={p.snapshot} cell={p.selectedCell} />
          ) : (
            <div style={{
              padding: "8px 16px 12px",
              color: colors.textSecondary,
              fontSize: 12,
              lineHeight: 1.55,
              fontFamily: fonts.sans,
            }}>
              Click any cell on the planet to inspect its current state — plate,
              elevation, crust age, collision kind, and volcanic activity.
            </div>
          )}
        </PropertySection>

        <PropertySection heading="Glossary">
          <Glossary items={[
            ["Convergent", "Plates push together. Denser plate subducts; mountain or arc rises."],
            ["Divergent",  "Plates pull apart. New crust spawns at mid-ocean ridges."],
            ["Subduction", "Older oceanic crust dives into the mantle. Volcanic arc above."],
            ["Orogeny",    "Continent-continent collision. Crust thickens; mountains build."],
            ["MOR age",    "Steps since this cell formed at a divergent boundary."],
            ["Crust age",  "Time since this cell first solidified, in Ma."],
          ]}/>
        </PropertySection>

      </div>
    </div>
  );
}


function CellReadout({ snap, cell }: { snap: PlanetSnapshot; cell: number }) {
  if (cell < 0 || cell >= snap.n_cells) {
    return (
      <div style={{ padding: "8px 16px 12px", color: colors.textMuted, fontSize: 11 }}>
        Cell {cell} out of range.
      </div>
    );
  }
  const plateId   = snap.cell_plate_ids[cell];
  const elev      = snap.cell_elevation[cell];
  const cont      = snap.cell_continental[cell] === 1;
  const isBdy     = snap.cell_is_boundary[cell] === 1;
  const slope     = snap.cell_slope[cell];
  const age       = snap.cell_age_ma[cell];
  const thick     = snap.cell_crust_thickness_km[cell];
  const collision = snap.cell_collision_kind[cell];
  const subProg   = snap.cell_subduction_progress[cell];
  const uplift    = snap.cell_orogenic_uplift[cell];
  const volc      = snap.cell_volcanic_intensity[cell];
  const morAge    = snap.cell_mor_age_steps[cell];

  const collisionLabel = ["None", "Subduction", "Orogeny", "Buffer kill", "Drag"][collision] ?? "Unknown";

  return (
    <>
      <PropertyRow label="Cell id"      value={`#${cell.toLocaleString()}`} />
      <PropertyRow label="Plate"        value={plateId >= 0 ? `${plateId}` : "—"} />
      <PropertyRow label="Crust type"   value={cont ? "Continental" : "Oceanic"} />
      <PropertyRow label="Elevation"    value={`${elev.toFixed(3)}`} />
      <PropertyRow label="Slope"        value={slope.toFixed(2)} />
      <PropertyRow label="Crust age"    value={`${age.toFixed(1)} Ma`} />
      <PropertyRow label="Thickness"    value={`${thick.toFixed(1)} km`} />
      <PropertyRow label="At boundary"  value={isBdy ? "Yes" : "No"} />
      <PropertyRow label="Collision"    value={collisionLabel} />
      {subProg > 0.01 && <PropertyRow label="Subduction" value={`${(subProg * 100).toFixed(0)}%`} />}
      {uplift  > 0.01 && <PropertyRow label="Orogenic uplift" value={`${(uplift * 100).toFixed(0)}%`} />}
      {volc    > 0.01 && <PropertyRow label="Volcanic" value={`${(volc * 100).toFixed(0)}%`} />}
      <PropertyRow label="MOR age" noSeparator value={`${morAge} steps`} />
    </>
  );
}


function Glossary({ items }: { items: [string, string][] }) {
  return (
    <div style={{ padding: "4px 16px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map(([term, def]) => (
        <div key={term} style={{ fontSize: 12, lineHeight: 1.5, fontFamily: fonts.sans }}>
          <span style={{ color: colors.beige, fontWeight: 600 }}>{term}.</span>{" "}
          <span style={{ color: colors.textSecondary }}>{def}</span>
        </div>
      ))}
    </div>
  );
}
