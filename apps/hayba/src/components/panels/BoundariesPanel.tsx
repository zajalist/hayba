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
          <div style={{ padding: "4px 16px 6px" }}>
            <ConvergentDiagram />
          </div>
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
          <div style={{ padding: "4px 16px 6px" }}>
            <DivergentDiagram />
          </div>
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

/**
 * Side-view diagram of a convergent boundary: two plate slabs pushing into
 * each other, with a small mountain ridge rising at the contact and one slab
 * subducting (curving down) under the other.
 */
function ConvergentDiagram() {
  const crust = "#3d434e";
  const crustEdge = colors.beigeMuted;
  const mantle = "#22262e";
  const arrow = colors.beige;
  return (
    <svg viewBox="0 0 280 90" width="100%" height={86} style={{ display: "block" }}>
      <rect x="0" y="56" width="280" height="34" fill={mantle} />
      {/* Mountain ridge at the collision point */}
      <path d="M124 56 L140 36 L156 56 Z" fill={crust} stroke={crustEdge} strokeWidth="1.2" strokeLinejoin="round" />
      {/* Left plate — flat slab pushing right */}
      <path d="M0 56 L0 64 L140 64 L140 56 Z" fill={crust} stroke={crustEdge} strokeWidth="1.2" />
      {/* Right plate — subducts under the left, curving down */}
      <path d="M280 56 L280 64 L172 64 Q150 64 138 74 L130 84 L138 84 Q156 76 178 72 L280 72 Z" fill={crust} stroke={crustEdge} strokeWidth="1.2" />
      {/* Arrows showing motion toward the boundary */}
      <g stroke={arrow} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <line x1="30" y1="22" x2="86" y2="22" />
        <polyline points="78 17 86 22 78 27" />
        <line x1="250" y1="22" x2="194" y2="22" />
        <polyline points="202 17 194 22 202 27" />
      </g>
    </svg>
  );
}

/**
 * Side-view diagram of a divergent boundary: two plate slabs pulling apart,
 * a gap between them, mantle upwelling rising in the middle.
 */
function DivergentDiagram() {
  const crust = "#3d434e";
  const crustEdge = colors.beigeMuted;
  const mantle = "#22262e";
  const upwell = colors.accent;
  const arrow = colors.beige;
  return (
    <svg viewBox="0 0 280 90" width="100%" height={86} style={{ display: "block" }}>
      <rect x="0" y="56" width="280" height="34" fill={mantle} />
      {/* Upwelling plume in the middle */}
      <path d="M132 90 L140 50 L148 90 Z" fill={upwell} opacity="0.7" />
      {/* Two plates with a gap between */}
      <path d="M0 56 L0 64 L124 64 L124 56 Z" fill={crust} stroke={crustEdge} strokeWidth="1.2" />
      <path d="M280 56 L280 64 L156 64 L156 56 Z" fill={crust} stroke={crustEdge} strokeWidth="1.2" />
      {/* Arrows pulling outward from the seam */}
      <g stroke={arrow} strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <line x1="86" y1="22" x2="30" y2="22" />
        <polyline points="38 17 30 22 38 27" />
        <line x1="194" y1="22" x2="250" y2="22" />
        <polyline points="242 17 250 22 242 27" />
      </g>
    </svg>
  );
}
