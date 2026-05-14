import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

export interface BrushSliderProps {
  /** Brush angular radius in radians. */
  value: number;
  onChange: (radius: number) => void;
  disabled?: boolean;
}

const MIN_RAD = 0.015;  // ≈ 0.9° great-circle — fine line
const MAX_RAD = 0.25;   // ≈ 14.3° — chunky region brush

export default function BrushSlider({ value, onChange, disabled }: BrushSliderProps) {
  const t = (value - MIN_RAD) / (MAX_RAD - MIN_RAD);
  const pct = Math.min(1, Math.max(0, t));
  const degrees = (value * 180 / Math.PI).toFixed(1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, color: colors.textSecondary, letterSpacing: "0.04em" }}>brush size</span>
        <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.accentText }}>
          {degrees}°
        </span>
      </div>
      <div style={{ position: "relative", height: 24, display: "flex", alignItems: "center" }}>
        <div style={{ position: "absolute", left: 0, right: 0, height: 2, background: colors.borderSoft }} />
        <div style={{ position: "absolute", left: 0, width: `${pct * 100}%`, height: 2, background: colors.accent }} />
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
            left: 0,
            right: 0,
            width: "100%",
            background: "transparent",
            opacity: 0,
            cursor: disabled ? "default" : "pointer",
            height: 24,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: `calc(${pct * 100}% - 6px)`,
            width: 12,
            height: 12,
            background: colors.accent,
            border: `2px solid ${colors.bgBase}`,
            borderRadius: 0,
            pointerEvents: "none",
          }}
        />
      </div>
    </div>
  );
}
