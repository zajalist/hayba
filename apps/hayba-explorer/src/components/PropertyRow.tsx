import React from "react";
import { colors, fonts, space, fontSize } from "@hayba/design-tokens";
import { rowMatches, usePropertySearch, useSectionVisibility } from "./propertySearch";

export interface PropertyRowProps {
  label: string;
  /** Right-side value. Strings render as label-style; ReactNode lets callers pass controls. */
  value: React.ReactNode;
  /** If true, no bottom separator is drawn (last row in a section). */
  noSeparator?: boolean;
}

/** UE5-style tight row: 28px tall, 8px padding, hover lighten, 1px subtle separator. */
export default function PropertyRow({ label, value, noSeparator }: PropertyRowProps) {
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
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: space.rowHeight,
        padding: `0 ${space.rowPadX}px`,
        background: hover ? colors.bgRowHover : "transparent",
        borderBottom: noSeparator ? "none" : `1px solid ${colors.borderSubtle}`,
        fontFamily: fonts.sans,
        fontSize: fontSize.label,
      }}
    >
      <span style={{ color: colors.textLabel }}>{label}</span>
      <span style={{ color: colors.textValue, fontFamily: fonts.mono, fontSize: fontSize.value, textAlign: "right" }}>{value}</span>
    </div>
  );
}
