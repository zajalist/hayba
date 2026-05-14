import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import { IconPlay, IconPause } from "./icons";

const BEIGE = "#DED4C3";

export interface PhaseStripProps {
  simTimeMa: number;
  era: string;
  playing: boolean;
  disabled?: boolean;
  onTogglePlay: () => void;
}

/**
 * Minimalist sim-phase indicator for the status bar's right end:
 *   `Cretaceous · 12.4 Ma · ▶`
 *
 * Era + time read in mono so the strip stays visually still while only the
 * play/pause glyph toggles. Disabled state during pre-bake.
 */
export default function PhaseStrip({
  simTimeMa, era, playing, disabled, onTogglePlay,
}: PhaseStripProps) {
  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      paddingRight: 12,
      borderLeft: `1px solid ${colors.borderMid}`,
      paddingLeft: 14,
      height: "100%",
      fontFamily: fonts.sans,
      opacity: disabled ? 0.4 : 1,
    }}>
      <span style={{
        fontSize: 11,
        color: BEIGE,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
      }}>
        {era}
      </span>
      <span style={{
        fontFamily: fonts.mono,
        fontSize: 10,
        color: colors.textMuted,
      }}>
        ·
      </span>
      <span style={{
        fontFamily: fonts.mono,
        fontSize: 11,
        color: colors.textPrimary,
        whiteSpace: "nowrap",
      }}>
        {simTimeMa.toFixed(1)} Ma
      </span>
      <button
        type="button"
        onClick={onTogglePlay}
        disabled={disabled}
        title={playing ? "Pause (Space)" : "Play (Space)"}
        style={{
          width: 22,
          height: 22,
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "transparent",
          border: "none",
          cursor: disabled ? "default" : "pointer",
          marginLeft: 4,
        }}
      >
        {playing ? <IconPause size={14} /> : <IconPlay size={14} />}
      </button>
    </div>
  );
}
