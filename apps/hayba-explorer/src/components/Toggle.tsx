import React from "react";
import { colors, easings } from "@hayba/design-tokens";

export interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Accessible label — exposed via aria-label so the control has semantic
   *  meaning even when its visible label sits in a PropertyRow. */
  ariaLabel: string;
  disabled?: boolean;
}

/**
 * UE5-style boolean checkbox: 14×14 box with 2px corners. When unchecked,
 * shows a thin border on a dark inset. When checked, the box is filled with
 * the amber accent and a small white check is drawn inside.
 *
 * Implemented as `role="switch"` for backwards compatibility with existing
 * tests that look for the aria-checked switch role.
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
        width: 14,
        height: 14,
        borderRadius: 2,
        border: `1px solid ${checked ? colors.accent : colors.borderSoft}`,
        background: checked ? colors.accent : "rgba(0,0,0,0.35)",
        padding: 0,
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: `background 140ms ${easings.out}, border-color 140ms ${easings.out}`,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked && (
        <svg
          aria-hidden
          width={10}
          height={10}
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ffffff"
          strokeWidth={3.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </button>
  );
}
