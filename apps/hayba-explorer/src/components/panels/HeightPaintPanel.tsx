import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import PropertyRow from "../PropertyRow";
import PropertySection from "../PropertySection";
import Select from "../Select";
import type { BrushConfig } from "../../wizard/paint/HeightPainter";
import type { BrushMode } from "../../wizard/paint/brushes";
import type { FalloffKind } from "../../wizard/paint/falloff";
import type { MaskName } from "../../wizard/paint/brushMasks";
import { MASK_NAMES } from "../../wizard/paint/brushMasks";

export interface HeightPaintPanelProps {
  brush: BrushConfig;
  paintedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onChangeBrush: (next: BrushConfig) => void;
  onUndo: () => void;
  onRedo: () => void;
  onReset: () => void;
  onBack: () => void;
  onNext: () => void;
}

const MODE_LABELS: Record<BrushMode, string> = {
  raise: "Raise",
  lower: "Lower",
  smooth: "Smooth",
  flatten: "Flatten",
  noise: "Noise",
};

export default function HeightPaintPanel(p: HeightPaintPanelProps): React.ReactElement {
  const set = <K extends keyof BrushConfig>(k: K, v: BrushConfig[K]): void =>
    p.onChangeBrush({ ...p.brush, [k]: v });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 12 }}>
        <PropertySection heading="Height painter">
          <PropertyRow
            label="Mode"
            value={
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {(Object.keys(MODE_LABELS) as BrushMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => set("mode", m)}
                    style={modeButtonStyle(m === p.brush.mode)}
                  >
                    {MODE_LABELS[m]}
                  </button>
                ))}
              </div>
            }
          />
          <PropertyRow
            label="Radius"
            value={
              <input
                type="range"
                min={0.02}
                max={0.30}
                step={0.005}
                value={p.brush.radiusRad}
                onChange={(e) => set("radiusRad", Number(e.target.value))}
                style={{ width: "100%" }}
              />
            }
          />
          <PropertyRow
            label="Strength"
            value={
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={p.brush.strength}
                onChange={(e) => set("strength", Number(e.target.value))}
                style={{ width: "100%" }}
              />
            }
          />
          <PropertyRow
            label="Falloff"
            value={
              <Select<FalloffKind>
                value={p.brush.falloff}
                onChange={(v) => set("falloff", v)}
                options={[
                  { value: "smooth", label: "Smooth" },
                  { value: "linear", label: "Linear" },
                  { value: "hard",   label: "Hard" },
                ]}
              />
            }
          />
          <PropertyRow
            label="Mask"
            value={
              <Select<MaskName>
                value={p.brush.mask}
                onChange={(v) => set("mask", v)}
                options={MASK_NAMES.map((n) => ({ value: n, label: n }))}
              />
            }
          />
          {p.brush.mode === "flatten" && (
            <PropertyRow
              label="Target"
              value={
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={p.brush.flattenTarget}
                  onChange={(e) => set("flattenTarget", Number(e.target.value))}
                  style={{ width: "100%" }}
                />
              }
            />
          )}
        </PropertySection>

        <PropertySection heading="History">
          <PropertyRow
            label={`${p.paintedCount} cells painted`}
            noSeparator
            value={
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={p.onUndo} disabled={!p.canUndo} style={historyButtonStyle(p.canUndo)}>↶ Undo</button>
                <button onClick={p.onRedo} disabled={!p.canRedo} style={historyButtonStyle(p.canRedo)}>↷ Redo</button>
                <button onClick={p.onReset} style={historyButtonStyle(true)}>Reset</button>
              </div>
            }
          />
        </PropertySection>
      </div>

      <div style={{ display: "flex", gap: 6, padding: "8px 0", borderTop: `1px solid ${colors.borderMid}` }}>
        <button onClick={p.onBack} style={navButtonStyle(false)}>← Continents</button>
        <button onClick={p.onNext} style={navButtonStyle(true)}>Boundaries →</button>
      </div>
    </div>
  );
}

function modeButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 9px",
    background: active ? "rgba(181,106,29,0.18)" : "transparent",
    border: `1px solid ${active ? colors.accent : colors.borderMid}`,
    borderRadius: 3,
    color: active ? colors.accentText : colors.beige,
    fontFamily: fonts.sans,
    fontSize: 12,
    cursor: "pointer",
    transition: "background 120ms, border-color 120ms",
  };
}

function historyButtonStyle(enabled: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    background: "transparent",
    border: `1px solid ${colors.borderMid}`,
    borderRadius: 3,
    color: enabled ? colors.beige : colors.textMuted,
    fontFamily: fonts.sans,
    fontSize: 12,
    cursor: enabled ? "pointer" : "not-allowed",
    opacity: enabled ? 1 : 0.5,
  };
}

function navButtonStyle(primary: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: "8px 12px",
    background: primary ? "rgba(181,106,29,0.18)" : "transparent",
    border: `1px solid ${primary ? colors.accent : colors.borderMid}`,
    borderRadius: 3,
    color: primary ? colors.accentText : colors.beige,
    fontFamily: fonts.sans,
    fontSize: 13,
    cursor: "pointer",
  };
}
