import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";
import Select from "../Select";
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
  /** Extra sections rendered in the scroll area, below Continents and above
   *  the Bake action strip. Used to host the height-painter controls. */
  children?: React.ReactNode;
}

export default function ComposePanel(p: ComposePanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 12 }}>
        <PropertySection heading="Detail">
          <PropertyRow
            label="Resolution"
            value={
              <Select<number>
                value={p.draft.divisions}
                onChange={p.onChangeDivisions}
                options={RESOLUTION_PRESETS.map((r) => ({
                  value: r.divisions,
                  label: `${r.label} · ${r.cellsLabel} cells`,
                }))}
              />
            }
          />
          <PropertyRow
            label="Preset"
            value={
              <Select<PresetName>
                value={p.draft.preset}
                onChange={p.onChangePreset}
                options={PRESETS.map((s) => ({
                  value: s.name,
                  label: s.note ? `${s.label} (${s.note})` : s.label,
                }))}
              />
            }
          />
          <PropertyRow
            label="Seed"
            noSeparator
            value={
              <button
                onClick={p.onReroll}
                title="Click to reroll the seed"
                aria-label="Reroll seed"
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.05)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "3px 8px",
                  background: "transparent",
                  border: `1px solid ${colors.borderMid}`,
                  borderRadius: 3,
                  color: colors.beige,
                  fontFamily: "Consolas, monospace",
                  fontSize: 12,
                  cursor: "pointer",
                  transition: "background 120ms, border-color 120ms",
                }}
              >
                <span>{String(p.draft.seed).slice(-8)}</span>
                <span style={{ color: colors.accent }}>↻</span>
              </button>
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

        {p.children}
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
