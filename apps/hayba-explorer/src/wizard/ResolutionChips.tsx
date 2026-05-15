import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

export interface Preset {
  label: string;
  divisions: number;
  cellsLabel: string;
  /** Optional muted second line beneath the label — used for bake-time hints. */
  hint?: string;
}

export const PRESETS: Preset[] = [
  { label: "Quick",         divisions: 32,  cellsLabel: "10K"  },
  { label: "Balanced",      divisions: 64,  cellsLabel: "41K"  },
  { label: "High-Fidelity", divisions: 96,  cellsLabel: "92K"  },
  { label: "Ultra",         divisions: 128, cellsLabel: "164K", hint: "~2s per bake"  },
  { label: "Extreme",       divisions: 160, cellsLabel: "256K", hint: "~5s per bake"  },
  { label: "Insane",        divisions: 192, cellsLabel: "370K", hint: "~10s per bake — painter still snappy" },
];

export interface ResolutionChipsProps {
  value: number;
  onChange: (divisions: number) => void;
  disabled?: boolean;
}

export default function ResolutionChips({ value, onChange, disabled }: ResolutionChipsProps) {
  return (
    <div style={{ borderTop: `1px solid ${colors.borderMid}` }}>
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
              transition: "color 120ms",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "baseline", gap: 12, flex: 1 }}>
              <span style={{ color: active ? colors.accentText : colors.textMuted, fontFamily: fonts.mono, fontSize: 11, width: 18 }}>
                {active ? "→" : ""}
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span>{p.label}</span>
                {p.hint && (
                  <span style={{ fontSize: 10, color: colors.textMuted, letterSpacing: "0.04em" }}>
                    {p.hint}
                  </span>
                )}
              </span>
            </span>
            <span style={{ fontFamily: fonts.mono, fontSize: 11, color: active ? colors.accentText : colors.textMuted, letterSpacing: "0.06em" }}>
              {p.cellsLabel} cells
            </span>
          </button>
        );
      })}
    </div>
  );
}
