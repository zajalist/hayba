import React from "react";
import { colors, fonts, radii } from "@hayba/design-tokens";

export interface ToolSizeSliderProps {
  value: number;
  onChange: (radius: number) => void;
  disabled?: boolean;
  /** Whether this slider is being used in erase mode (different accent color). */
  destructive?: boolean;
}

const MIN_RAD = 0.015;
const MAX_RAD = 0.25;

export default function ToolSizeSlider({ value, onChange, disabled, destructive }: ToolSizeSliderProps) {
  const pct = Math.min(1, Math.max(0, (value - MIN_RAD) / (MAX_RAD - MIN_RAD)));
  const degrees = (value * 180 / Math.PI).toFixed(1);
  const accent = destructive ? "#C04848" : colors.accent;
  const accentText = destructive ? "#E08080" : colors.accentText;

  return (
    <aside
      style={{
        position: "fixed",
        left: 20,
        bottom: 46,
        zIndex: 60,
        width: 56,
        background: colors.bgBase,
        border: `1px solid ${colors.borderMid}`,
        borderRadius: radii.sm,
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        fontFamily: fonts.sans,
      }}
      title={`Brush radius — ${degrees}°`}
    >
      <div style={{
        background: colors.bgPanelHeader,
        borderBottom: `1px solid ${colors.borderMid}`,
        padding: "6px 0",
        fontSize: 9,
        letterSpacing: "0.32em",
        textTransform: "uppercase",
        color: colors.textMuted,
        textAlign: "center",
      }}>
        Size
      </div>

      <div style={{
        padding: "10px 0 12px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
      }}>
        <span style={{
          fontFamily: fonts.mono,
          fontSize: 10,
          color: accentText,
          letterSpacing: "0.04em",
        }}>
          {degrees}°
        </span>
        <div style={{ position: "relative", width: 24, height: 100 }}>
          <div style={{
            position: "absolute",
            left: 11,
            top: 0,
            bottom: 0,
            width: 2,
            background: colors.borderSoft,
            borderRadius: 1,
          }} />
          <div style={{
            position: "absolute",
            left: 11,
            bottom: 0,
            width: 2,
            height: `${pct * 100}%`,
            background: accent,
            borderRadius: 1,
          }} />
          <div style={{
            position: "absolute",
            left: 8,
            bottom: `calc(${pct * 100}% - 4px)`,
            width: 8,
            height: 8,
            background: accent,
            borderRadius: 1,
            pointerEvents: "none",
            boxShadow: `0 0 0 2px ${colors.bgBase}`,
          }} />
          <input
            type="range"
            min={MIN_RAD}
            max={MAX_RAD}
            step={0.005}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            style={{
              position: "absolute",
              left: -38,
              top: 38,
              width: 100,
              height: 24,
              transform: "rotate(-90deg)",
              transformOrigin: "62px 12px",
              background: "transparent",
              opacity: 0,
              cursor: disabled ? "default" : "pointer",
            }}
          />
        </div>
      </div>
    </aside>
  );
}
