import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

export interface Preset {
  label: string;
  divisions: number;
  cellsLabel: string;
}

export const PRESETS: Preset[] = [
  { label: "Quick",         divisions: 32, cellsLabel: "10k cells" },
  { label: "Balanced",      divisions: 64, cellsLabel: "41k cells" },
  { label: "High-Fidelity", divisions: 96, cellsLabel: "92k cells" },
];

export interface ResolutionChipsProps {
  value: number;
  onChange: (divisions: number) => void;
  disabled?: boolean;
}

export default function ResolutionChips({ value, onChange, disabled }: ResolutionChipsProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {PRESETS.map((p) => {
        const active = p.divisions === value;
        return (
          <button
            key={p.divisions}
            type="button"
            disabled={disabled}
            onClick={() => onChange(p.divisions)}
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 10,
              padding: "10px 12px",
              background: active ? "transparent" : colors.bgPanel,
              border: `1px solid ${active ? colors.accent : colors.borderMid}`,
              borderLeft: `2px solid ${active ? colors.accent : "transparent"}`,
              color: active ? colors.textPrimary : colors.textSecondary,
              fontFamily: fonts.sans,
              fontSize: 13,
              letterSpacing: "0.02em",
              cursor: disabled ? "default" : "pointer",
              textAlign: "left",
              transition: "border-color 120ms, color 120ms",
            }}
          >
            <span style={{ flex: 1 }}>{p.label}</span>
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: active ? colors.accent : colors.textMuted }}>
              {p.cellsLabel}
            </span>
          </button>
        );
      })}
    </div>
  );
}
