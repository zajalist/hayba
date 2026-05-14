import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

export interface ToolSizeSliderProps {
  /** Brush angular radius in radians. */
  value: number;
  onChange: (radius: number) => void;
  disabled?: boolean;
}

const MIN_RAD = 0.015;
const MAX_RAD = 0.25;

export default function ToolSizeSlider({ value, onChange, disabled }: ToolSizeSliderProps) {
  const pct = Math.min(1, Math.max(0, (value - MIN_RAD) / (MAX_RAD - MIN_RAD)));
  const degrees = (value * 180 / Math.PI).toFixed(1);

  return (
    <aside
      style={{
        position: "fixed",
        left: 20,
        bottom: 50,
        zIndex: 60,
        width: 64,
        background: colors.bgBase,
        border: `1px solid ${colors.borderMid}`,
        padding: "12px 10px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        fontFamily: fonts.sans,
      }}
      title={`Brush radius — ${degrees}°`}
    >
      <span style={{
        fontFamily: fonts.mono,
        fontSize: 10,
        color: colors.accentText,
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
        }} />
        <div style={{
          position: "absolute",
          left: 11,
          bottom: 0,
          width: 2,
          height: `${pct * 100}%`,
          background: colors.accent,
        }} />
        <div style={{
          position: "absolute",
          left: 8,
          bottom: `calc(${pct * 100}% - 4px)`,
          width: 8,
          height: 8,
          background: colors.accent,
          pointerEvents: "none",
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
      <span style={{ fontSize: 9, color: colors.textMuted, letterSpacing: "0.22em", textTransform: "uppercase" }}>
        size
      </span>
    </aside>
  );
}
