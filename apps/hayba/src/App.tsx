import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

export default function App() {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: colors.bgDeep,
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        fontSize: 14,
        letterSpacing: "0.04em",
      }}
    >
      Hayba Explorer v0.1 — booting…
    </div>
  );
}
