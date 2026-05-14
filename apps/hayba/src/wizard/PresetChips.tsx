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
    <div style={{ borderTop: `1px solid ${colors.borderMid}` }}>
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
              width: "100%",
              gap: 10,
              padding: "12px 0",
              background: "transparent",
              border: "none",
              borderBottom: `1px solid ${colors.borderMid}`,
              color: active ? colors.textPrimary : colors.textSecondary,
              fontFamily: fonts.sans,
              fontSize: 13,
              letterSpacing: "0.04em",
              cursor: disabled ? "default" : "pointer",
              textAlign: "left",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "baseline", gap: 12, flex: 1 }}>
              <span style={{ color: active ? colors.accentText : colors.textMuted, fontFamily: fonts.mono, fontSize: 11, width: 18 }}>
                {active ? "→" : ""}
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span>{p.label}</span>
                {p.note && (
                  <span style={{ fontSize: 10, color: colors.textMuted, letterSpacing: "0.06em", textTransform: "lowercase" }}>
                    {p.note}
                  </span>
                )}
              </span>
            </span>
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: active ? colors.accentText : colors.textMuted, letterSpacing: "0.06em" }}>
              {p.plates} plates
            </span>
          </button>
        );
      })}
    </div>
  );
}
