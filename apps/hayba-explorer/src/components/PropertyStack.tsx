import React from "react";
import { colors, fonts, space, fontSize } from "@hayba/design-tokens";
import { rowMatches, usePropertySearch, useSectionVisibility } from "./propertySearch";

export interface PropertyStackProps {
  label: string;
  /** Optional readout shown right-aligned on the label row (e.g. the current
   *  slider value). Strings render in white value-style. Pass `null` to hide. */
  value?: React.ReactNode;
  /** Full-width control rendered below the label row — typically a slider. */
  children: React.ReactNode;
  /** If true, no bottom separator is drawn (last row in a section). */
  noSeparator?: boolean;
}

/**
 * UE5-style stacked row: 18px label row + ~24-28px control row, 8px hpad,
 * row-hover background, same separator rule as PropertyRow.
 *
 *   LABEL                                value
 *   █▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  ← full-width control here
 */
export default function PropertyStack({ label, value, children, noSeparator }: PropertyStackProps) {
  const [hover, setHover] = React.useState(false);
  const { query } = usePropertySearch();
  const section = useSectionVisibility();
  const matched = rowMatches(label, query);
  const id = React.useId();
  React.useEffect(() => { section?.register(id, matched); }, [section, id, matched]);
  React.useEffect(() => () => { section?.register(id, false); }, [section, id]);
  if (!matched) return null;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: `2px ${space.rowPadX}px 4px`,
        background: hover ? colors.bgRowHover : "transparent",
        borderBottom: noSeparator ? "none" : `1px solid ${colors.borderSubtle}`,
        fontFamily: fonts.sans,
        fontSize: fontSize.label,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 18,
        }}
      >
        <span style={{ color: colors.textLabel }}>{label}</span>
        {value != null && (
          <span style={{ color: colors.textValue, fontFamily: fonts.mono, fontSize: fontSize.value }}>{value}</span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", height: 24 }}>
        {children}
      </div>
    </div>
  );
}
