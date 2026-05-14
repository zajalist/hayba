import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";

export interface BoundariesPanelProps {
  totalSeams: number;
  assignedCount: number;
  onAdvance: () => void;
}

/**
 * Geological reference + progress readout. Boundary editing itself happens
 * via the click-on-planet popover; this panel is the onboarding surface.
 */
export default function BoundariesPanel(p: BoundariesPanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 12 }}>

        <PropertySection heading="Progress">
          <PropertyRow label="Assigned" value={`${p.assignedCount} / ${p.totalSeams}`} noSeparator />
        </PropertySection>

        <PropertySection heading="How to assign">
          <div style={{
            padding: "4px 16px 12px",
            color: colors.textSecondary,
            fontFamily: fonts.sans,
            fontSize: 12,
            lineHeight: 1.55,
          }}>
            Click any pink seam on the planet. A small popover appears with the
            two plates and lets you pick the relative motion.
          </div>
        </PropertySection>

        <PropertySection heading="Convergent">
          <div style={{
            padding: "4px 16px 12px",
            color: colors.textSecondary,
            fontFamily: fonts.sans,
            fontSize: 12,
            lineHeight: 1.55,
          }}>
            Plates push into each other. The denser plate dives under the lighter one,
            building mountain ranges (continent–continent) or volcanic arcs and trenches
            (ocean–continent). On Earth: Himalayas, Andes, Cascadia.
          </div>
        </PropertySection>

        <PropertySection heading="Divergent">
          <div style={{
            padding: "4px 16px 12px",
            color: colors.textSecondary,
            fontFamily: fonts.sans,
            fontSize: 12,
            lineHeight: 1.55,
          }}>
            Plates pull apart. New crust upwells along the seam — mid-ocean ridges
            (most divergent boundaries) or continental rift valleys. On Earth: Mid-Atlantic
            Ridge, East African Rift.
          </div>
        </PropertySection>

      </div>

      <div style={bottomActionStripStyle}>
        <button type="button" onClick={p.onAdvance} style={primaryActionButtonStyle}>
          Next: Densities
        </button>
      </div>
    </div>
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
  fontFamily: "inherit",
  fontSize: 12,
  cursor: "pointer",
};
