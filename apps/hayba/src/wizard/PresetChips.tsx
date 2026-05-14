import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import { PRESETS, type PresetName } from "./state";

export interface PresetChipsProps {
  value: PresetName;
  onChange: (preset: PresetName) => void;
  disabled?: boolean;
}

export default function PresetChips({ value, onChange, disabled }: PresetChipsProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {PRESETS.map((p) => {
        const active = p.name === value;
        return (
          <button
            key={p.name}
            type="button"
            disabled={disabled}
            onClick={() => onChange(p.name)}
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 10,
              padding: "8px 12px",
              background: active ? "transparent" : colors.bgPanel,
              border: `1px solid ${active ? colors.accent : colors.borderMid}`,
              borderLeft: `2px solid ${active ? colors.accent : "transparent"}`,
              color: active ? colors.textPrimary : colors.textSecondary,
              fontFamily: fonts.sans,
              fontSize: 13,
              letterSpacing: "0.02em",
              cursor: disabled ? "default" : "pointer",
              textAlign: "left",
            }}
          >
            <span style={{ flex: 1 }}>
              {p.label}
              {p.note && (
                <span style={{ display: "block", fontSize: 10, color: colors.textMuted, marginTop: 2, letterSpacing: "0.06em", textTransform: "lowercase" }}>
                  {p.note}
                </span>
              )}
            </span>
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: active ? colors.accentText : colors.textMuted }}>
              {p.plates}
            </span>
          </button>
        );
      })}
    </div>
  );
}
