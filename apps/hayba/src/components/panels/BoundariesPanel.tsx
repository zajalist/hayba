import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";
import type { BoundaryType } from "../../wizard/state";

export interface BoundariesPanelProps {
  totalSeams: number;
  assignedCount: number;
  /** Currently selected pair_key (e.g. "0-2"), or null if no seam selected. */
  selectedKey: string | null;
  /** Numeric plate ids — for showing "Plate 0 ↔ Plate 2" caption. */
  selectedMembers: [number, number] | null;
  /** Current type for the selected seam (Convergent / Divergent / undefined). */
  selectedType: BoundaryType | undefined;
  onPickType: (t: BoundaryType) => void;
  onClearType: () => void;
  onAdvance: () => void;
}

export default function BoundariesPanel(p: BoundariesPanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 12 }}>

        <PropertySection heading="Progress">
          <PropertyRow label="Assigned" value={`${p.assignedCount} / ${p.totalSeams}`} noSeparator />
        </PropertySection>

        {p.selectedKey && p.selectedMembers ? (
          <PropertySection heading="Selected seam">
            <PropertyRow label="Pair" value={`Plate ${p.selectedMembers[0]} ↔ Plate ${p.selectedMembers[1]}`} />
            <PropertyRow
              label="Type"
              noSeparator
              value={
                <span style={{ display: "inline-flex", gap: 6 }}>
                  <SegButton label="Convergent" active={p.selectedType === "convergent"} onClick={() => p.onPickType("convergent")} />
                  <SegButton label="Divergent"  active={p.selectedType === "divergent"}  onClick={() => p.onPickType("divergent")}  />
                  <SegButton label="Clear"      active={false}                            onClick={p.onClearType} />
                </span>
              }
            />
          </PropertySection>
        ) : (
          <div style={{
            padding: "12px 16px",
            color: colors.textSecondary,
            fontFamily: fonts.sans,
            fontSize: 12,
            lineHeight: 1.5,
          }}>
            Click a pink seam on the planet to assign convergent or divergent.
          </div>
        )}

      </div>

      <div style={bottomActionStripStyle}>
        <button type="button" onClick={p.onAdvance} style={primaryActionButtonStyle}>
          Next: Densities
        </button>
      </div>
    </div>
  );
}

function SegButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "4px 10px",
        fontSize: 11,
        background: active ? colors.bgBase : "transparent",
        border: `1px solid ${active ? colors.beige : colors.borderMid}`,
        borderRadius: 3,
        color: active ? colors.beige : colors.textSecondary,
        cursor: "pointer",
        fontFamily: fonts.sans,
      }}
    >
      {label}
    </button>
  );
}

const bottomActionStripStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderTop: `1px solid ${colors.borderMid}`,
  background: colors.bgPanelHeader,
};

const primaryActionButtonStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  background: "transparent",
  border: `1px solid ${colors.beige}`,
  borderRadius: 3,
  color: colors.beige,
  fontFamily: fonts.sans,
  fontSize: 12,
  cursor: "pointer",
};
