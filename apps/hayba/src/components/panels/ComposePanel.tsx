import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";
import type { WizardDraft, PresetName } from "../../wizard/state";
import { PRESETS } from "../../wizard/state";
import { PRESETS as RESOLUTION_PRESETS } from "../../wizard/ResolutionChips";

export interface ComposePanelProps {
  draft: WizardDraft;
  busy: boolean;
  onChangeDivisions: (d: number) => void;
  onChangePreset: (p: PresetName) => void;
  onReroll: () => void;
  onBake: () => void;
}

export default function ComposePanel(p: ComposePanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 12 }}>
        <PropertySection heading="Detail">
          <PropertyRow
            label="Resolution"
            value={
              <select
                value={p.draft.divisions}
                onChange={(e) => p.onChangeDivisions(Number(e.target.value))}
                style={selectStyle}
              >
                {RESOLUTION_PRESETS.map((r) => (
                  <option key={r.divisions} value={r.divisions}>
                    {r.label} · {r.cellsLabel} cells
                  </option>
                ))}
              </select>
            }
          />
          <PropertyRow
            label="Preset"
            value={
              <select
                value={p.draft.preset}
                onChange={(e) => p.onChangePreset(e.target.value as PresetName)}
                style={selectStyle}
              >
                {PRESETS.map((s) => (
                  <option key={s.name} value={s.name}>{s.label}</option>
                ))}
              </select>
            }
          />
          <PropertyRow
            label="Seed"
            noSeparator
            value={
              <span>
                {p.draft.seed}
                <button onClick={p.onReroll} style={inlineActionStyle} title="Reroll seed" aria-label="Reroll seed">↻</button>
              </span>
            }
          />
        </PropertySection>

        <PropertySection heading="Continents">
          <PropertyRow label="Painted" value={`${p.draft.continental_cells.length.toLocaleString()} cells`} />
          <PropertyRow
            label="Brush radius"
            noSeparator
            value={`${(p.draft.brush_radius_rad * 180 / Math.PI).toFixed(1)}°`}
          />
        </PropertySection>
      </div>

      <div style={bottomActionStripStyle}>
        <button
          type="button"
          onClick={p.onBake}
          disabled={p.busy}
          style={{
            ...primaryActionButtonStyle,
            cursor: p.busy ? "default" : "pointer",
            opacity: p.busy ? 0.5 : 1,
            borderColor: p.busy ? colors.borderSoft : colors.beige,
            color: p.busy ? colors.textMuted : colors.beige,
          }}
        >
          {p.busy ? "Baking…" : "Bake planet"}
        </button>
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: colors.beige,
  fontFamily: fonts.mono,
  fontSize: 12,
  textAlign: "right",
  cursor: "pointer",
};

const inlineActionStyle: React.CSSProperties = {
  marginLeft: 8,
  background: "transparent",
  border: "none",
  color: colors.accent,
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
};

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
