import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import CategoryStrip, { type PanelCategory } from "./CategoryStrip";

export interface RightPanelProps {
  active: PanelCategory;
  enabled: Record<PanelCategory, boolean>;
  disabledReason?: Partial<Record<PanelCategory, string>>;
  onPick: (cat: PanelCategory) => void;
  /** Panel body — typically one of the panels/*Panel components. */
  children: React.ReactNode;
}

const TITLES: Record<PanelCategory, { title: string; subtitle: string }> = {
  compose:    { title: "Compose",    subtitle: "Initial conditions" },
  texturing:  { title: "Texturing",  subtitle: "Per-biome SatMaps" },
  boundaries: { title: "Boundaries", subtitle: "Post-bake plate seams" },
  densities:  { title: "Densities",  subtitle: "Rank plates by density" },
  simulate:   { title: "Simulate",   subtitle: "Run the tectonic clock" },
  settings:   { title: "Settings",   subtitle: "App preferences" },
};

export default function RightPanel({ active, enabled, disabledReason, onPick, children }: RightPanelProps) {
  const meta = TITLES[active];
  return (
    <div style={{
      display: "flex",
      height: "100%",
      background: colors.bgBase,
      borderLeft: `1px solid ${colors.borderMid}`,
      color: colors.textPrimary,
      fontFamily: fonts.sans,
    }}>
      <CategoryStrip active={active} enabled={enabled} disabledReason={disabledReason} onPick={onPick} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          padding: "10px 14px",
          gap: 10,
          borderBottom: `1px solid ${colors.borderMid}`,
          background: colors.bgPanelHeader,
        }}>
          <span style={{ fontSize: 13, color: colors.beige, fontWeight: 600 }}>{meta.title}</span>
          <span style={{ fontSize: 11, color: colors.textMuted }}>{meta.subtitle}</span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
