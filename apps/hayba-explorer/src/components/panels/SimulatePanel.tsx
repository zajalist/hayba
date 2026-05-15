import React from "react";
import { colors } from "@hayba/design-tokens";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";
import { IconPlay, IconPause, IconReset } from "../icons";

export interface SimulatePanelProps {
  era: string;
  simTimeMa: number;
  steps: number;
  playing: boolean;
  onTogglePlay: () => void;
  onReset: () => void;
}

export default function SimulatePanel(p: SimulatePanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 12 }}>
        <PropertySection heading="Timeline">
          <PropertyRow label="Era"   value={p.era} />
          <PropertyRow label="Time"  value={`${p.simTimeMa.toFixed(1)} Ma`} />
          <PropertyRow label="Steps" noSeparator value={p.steps} />
        </PropertySection>
      </div>

      <div style={{
        padding: "10px 14px",
        borderTop: `1px solid ${colors.borderMid}`,
        background: colors.bgPanelHeader,
        display: "flex",
        gap: 8,
      }}>
        <button type="button" onClick={p.onTogglePlay} style={primaryBtn} aria-label={p.playing ? "Pause" : "Play"}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {p.playing ? <IconPause size={14} /> : <IconPlay size={14} />}
            {p.playing ? "Pause" : "Play"}
          </span>
        </button>
        <button type="button" onClick={p.onReset} style={secondaryBtn} aria-label="Reset">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <IconReset size={14} />
            Reset
          </span>
        </button>
      </div>
    </div>
  );
}

const baseBtn: React.CSSProperties = {
  flex: 1, padding: "9px 12px", background: "transparent",
  borderRadius: 3, fontFamily: "inherit", fontSize: 12, cursor: "pointer",
};
const primaryBtn:   React.CSSProperties = { ...baseBtn, border: `1px solid ${colors.beige}`,     color: colors.beige };
const secondaryBtn: React.CSSProperties = { ...baseBtn, border: `1px solid ${colors.borderSoft}`, color: colors.textSecondary };
