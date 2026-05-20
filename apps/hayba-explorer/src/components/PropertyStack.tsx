import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

export interface PropertyStackProps {
  label: string;
  /** Optional readout shown right-aligned on the label row (e.g. the current
   *  slider value). Strings render in Consolas beige. Pass `null` to hide. */
  value?: React.ReactNode;
  /** Full-width control rendered below the label row — typically a slider. */
  children: React.ReactNode;
  /** If true, no bottom separator is drawn (last row in a section). */
  noSeparator?: boolean;
}

/**
 * Stacked-layout counterpart to PropertyRow: a label (+ optional readout)
 * sits on its own line, with the actual control rendered full-width
 * underneath. Used for sliders and other controls that need horizontal
 * room — putting them in PropertyRow's tiny value cell crushes the track.
 *
 *   LABEL                                value
 *   █▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ← full-width control here
 *
 * Spacing, separator rule, and typography match PropertyRow so the
 * sections read as a single column.
 */
export default function PropertyStack({ label, value, children, noSeparator }: PropertyStackProps) {
  return (
    <div
      style={{
        padding: "6px 16px 8px",
        borderBottom: noSeparator ? "none" : `1px solid ${colors.rule}`,
        fontFamily: fonts.sans,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 4,
        }}
      >
        <span style={{ color: colors.beigeMuted }}>{label}</span>
        {value != null && (
          <span style={{ color: colors.beige, fontFamily: fonts.mono }}>{value}</span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center" }}>
        {children}
      </div>
    </div>
  );
}
