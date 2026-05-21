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
 * Pill-style switch with a travelling knob. 26×14 with 7px radius; the knob
 * slides from left (unchecked) to right (checked) and the track flips from
 * dark inset to amber accent with a soft glow.
 *
 * Keeps role="switch" for backward compatibility with existing tests.
 */
export default function Toggle({ checked, onChange, ariaLabel, disabled }: ToggleProps) {
  const [hover, setHover] = React.useState(false);
  const trackW = 26;
  const trackH = 14;
  const knob = 10;
  const inset = 2;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: trackW,
        height: trackH,
        borderRadius: trackH / 2,
        border: "none",
        background: checked
          ? colors.accent
          : "rgba(0, 0, 0, 0.45)",
        boxShadow: checked
          ? `0 0 0 1px ${colors.accent}, 0 0 8px rgba(181, 106, 29, 0.45), inset 0 1px 1px rgba(0, 0, 0, 0.25)`
          : `inset 0 1px 2px rgba(0, 0, 0, 0.55), 0 0 0 1px ${hover ? colors.borderSoft : colors.borderMid}`,
        padding: 0,
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        transition: `background 160ms ${easings.out}, box-shadow 160ms ${easings.out}`,
        display: "inline-block",
        verticalAlign: "middle",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          top: inset,
          left: checked ? trackW - knob - inset : inset,
          width: knob,
          height: knob,
          borderRadius: "50%",
          background: checked ? "#FFFFFF" : colors.beige,
          boxShadow: checked
            ? "0 1px 2px rgba(0, 0, 0, 0.5)"
            : "0 1px 2px rgba(0, 0, 0, 0.6)",
          transition: `left 180ms ${easings.spring}, background 160ms ${easings.out}`,
        }}
      />
    </button>
  );
}
