import React from "react";
import { colors, easings } from "@hayba/design-tokens";

export interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Accessible label — exposed via aria-label so the iOS-style track has
   *  semantic meaning even when the visible label sits in a PropertyRow. */
  ariaLabel: string;
  disabled?: boolean;
}

/**
 * Flat, dark-theme toggle that matches the rest of the docked chrome
 * (Hayba accent + thin border, no shadow). Used where a bare
 * `<input type="checkbox">` would render OS chrome that clashes with
 * the panel palette.
 */
export default function Toggle({ checked, onChange, ariaLabel, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 30,
        height: 16,
        borderRadius: 8,
        border: `1px solid ${checked ? colors.accent : colors.borderSoft}`,
        background: checked ? colors.accentDim : "rgba(255,255,255,0.04)",
        padding: 0,
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: `background 160ms ${easings.out}, border-color 160ms ${easings.out}`,
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: 1,
          left: checked ? 15 : 1,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: checked ? colors.accent : colors.beigeMuted,
          transition: `left 160ms ${easings.out}, background 160ms ${easings.out}`,
        }}
      />
    </button>
  );
}
