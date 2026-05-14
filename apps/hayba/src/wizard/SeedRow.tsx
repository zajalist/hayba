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
        gap: 10,
        padding: "10px 12px",
        background: colors.bgPanel,
        border: `1px solid ${colors.borderMid}`,
        borderLeft: `2px solid ${colors.borderSoft}`,
      }}
    >
      <span style={{ fontFamily: fonts.mono, fontSize: 12, color: colors.textPrimary, letterSpacing: "0.04em", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
        {seed.toString().padStart(20, "0")}
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={onReroll}
        title="Roll a new seed"
        style={{
          background: "transparent",
          border: `1px solid ${colors.borderSoft}`,
          color: colors.textPrimary,
          padding: "4px 10px",
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "lowercase",
          fontFamily: fonts.sans,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        reroll
      </button>
    </div>
  );
}
