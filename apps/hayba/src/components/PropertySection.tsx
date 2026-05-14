import React from "react";
import { colors } from "@hayba/design-tokens";

export interface PropertySectionProps {
  heading: string;
  children: React.ReactNode;
}

/** Small-caps tracked heading + row group. Only place letter-spacing is allowed. */
export default function PropertySection({ heading, children }: PropertySectionProps) {
  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          fontSize: 10,
          color: colors.beige,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          opacity: 0.7,
          padding: "8px 16px 6px",
        }}
      >
        {heading}
      </div>
      {children}
    </div>
  );
}
