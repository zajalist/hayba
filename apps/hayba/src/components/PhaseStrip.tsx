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
 * Sim-phase indicator on the right end of the status bar:
 *   `Cretaceous · 12.4 Ma · ▶`
 * Sentence case, calm mono numerics, beige tones.
 */
export default function PhaseStrip({
  simTimeMa, era, playing, disabled, onTogglePlay,
}: PhaseStripProps) {
  return (
    <div style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 12,
      paddingRight: 14,
      borderLeft: `1px solid ${colors.borderMid}`,
      paddingLeft: 16,
      height: "100%",
      fontFamily: fonts.sans,
      opacity: disabled ? 0.4 : 1,
    }}>
      <span style={{
        fontSize: 13,
        color: BEIGE,
        letterSpacing: "0.01em",
        whiteSpace: "nowrap",
      }}>
        {era}
      </span>
      <span style={{
        fontFamily: fonts.mono,
        fontSize: 12,
        color: colors.textMuted,
      }}>·</span>
      <span style={{
        fontFamily: fonts.mono,
        fontSize: 12,
        color: BEIGE,
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
          width: 28,
          height: 28,
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
        {playing ? <IconPause size={16} /> : <IconPlay size={16} />}
      </button>
    </div>
  );
}
