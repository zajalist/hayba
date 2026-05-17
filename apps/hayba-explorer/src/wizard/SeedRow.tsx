import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

export interface SeedRowProps {
  seed: number;
  onReroll: () => void;
  disabled?: boolean;
}

export default function SeedRow({ seed, onReroll, disabled }: SeedRowProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 14,
        padding: "10px 0",
        borderTop: `1px solid ${colors.borderMid}`,
        borderBottom: `1px solid ${colors.borderMid}`,
      }}
    >
      <span style={{
        fontFamily: fonts.mono,
        fontSize: 12,
        color: colors.textPrimary,
        letterSpacing: "0.04em",
        flex: 1,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>
        {seed.toString()}
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={onReroll}
        title="Roll a new seed"
        style={{
          background: "transparent",
          border: "none",
          color: colors.accentText,
          padding: 0,
          fontSize: 11,
          letterSpacing: "0.24em",
          textTransform: "uppercase",
          fontFamily: fonts.sans,
          fontWeight: 500,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        Reroll →
      </button>
    </div>
  );
}
