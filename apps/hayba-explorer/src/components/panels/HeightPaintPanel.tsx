import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import PropertyRow from "../PropertyRow";
import PropertyStack from "../PropertyStack";
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
  onLoadEarth: () => void;
}

const MODE_LABELS: Record<BrushMode, string> = {
  raise: "Raise",
  lower: "Lower",
  smooth: "Smooth",
  flatten: "Flatten",
  noise: "Noise",
};

/** Section-only — hosted inside ComposePanel's scroll area (no outer
 *  full-height wrapper, no nav footer; Compose owns the Bake action). */
export default function HeightPaintPanel(p: HeightPaintPanelProps): React.ReactElement {
  const set = <K extends keyof BrushConfig>(k: K, v: BrushConfig[K]): void =>
    p.onChangeBrush({ ...p.brush, [k]: v });

  return (
    <>
      <PropertySection heading="Height painter">
        {/* Mode buttons live in a full-width block, NOT a label/value row —
            five wrapping buttons overflow a PropertyRow's value cell. */}
        <div style={{ padding: "8px 14px 4px" }}>
          <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 6 }}>Mode</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
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
        </div>
        <PropertyStack
          label="Radius"
          value={p.brush.radiusRad.toFixed(3)}
        >
          <input
            type="range"
            min={0.02}
            max={0.30}
            step={0.005}
            value={p.brush.radiusRad}
            onChange={(e) => set("radiusRad", Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </PropertyStack>
        <PropertyStack
          label="Strength"
          value={p.brush.strength.toFixed(2)}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={p.brush.strength}
            onChange={(e) => set("strength", Number(e.target.value))}
            style={{ width: "100%" }}
          />
        </PropertyStack>
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
          noSeparator={p.brush.mode !== "flatten"}
          value={
            <Select<MaskName>
              value={p.brush.mask}
              onChange={(v) => set("mask", v)}
              options={MASK_NAMES.map((n) => ({ value: n, label: n }))}
            />
          }
        />
        {p.brush.mode === "flatten" && (
          <PropertyStack
            label="Target"
            value={p.brush.flattenTarget.toFixed(2)}
            noSeparator
          >
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={p.brush.flattenTarget}
              onChange={(e) => set("flattenTarget", Number(e.target.value))}
              style={{ width: "100%" }}
            />
          </PropertyStack>
        )}
      </PropertySection>

      <PropertySection heading="Templates">
        <div style={{ padding: "8px 14px" }}>
          <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 8 }}>
            Populate every cell with an analytic, latitude-correct Earth-like
            world for validating the debug map modes. Bake to apply.
          </div>
          <button onClick={p.onLoadEarth} style={historyButtonStyle(true)}>
            Load Earth
          </button>
        </div>
      </PropertySection>

      <PropertySection heading="History">
        <div style={{ padding: "8px 14px" }}>
          <div style={{ fontSize: 12, color: colors.beige, marginBottom: 8 }}>
            {p.paintedCount.toLocaleString()} cells painted
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={p.onUndo} disabled={!p.canUndo} style={historyButtonStyle(p.canUndo)}>↶ Undo</button>
            <button onClick={p.onRedo} disabled={!p.canRedo} style={historyButtonStyle(p.canRedo)}>↷ Redo</button>
            <button onClick={p.onReset} style={historyButtonStyle(true)}>Reset</button>
          </div>
        </div>
      </PropertySection>
    </>
  );
}

function modeButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: "5px 0",
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
    flex: 1,
    padding: "5px 10px",
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
