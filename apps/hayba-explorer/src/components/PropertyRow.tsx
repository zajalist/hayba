import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

export interface PropertyRowProps {
  label: string;
  /** Right-side value. Strings render as Consolas beige; ReactNode lets callers pass controls. */
  value: React.ReactNode;
  /** If true, no bottom separator is drawn (last row in a section). */
  noSeparator?: boolean;
}

/** 32px label-left value-right row with optional 1px bottom separator. */
export default function PropertyRow({ label, value, noSeparator }: PropertyRowProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 32,
        padding: "0 16px",
        borderBottom: noSeparator ? "none" : `1px solid ${colors.rule}`,
        fontFamily: fonts.sans,
        fontSize: 12,
      }}
    >
      <span style={{ color: colors.beigeMuted }}>{label}</span>
      <span style={{ color: colors.beige, fontFamily: fonts.mono }}>{value}</span>
    </div>
  );
}
