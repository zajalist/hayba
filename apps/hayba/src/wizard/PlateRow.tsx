import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import type { WizardPlate } from "./state";

export interface PlateRowProps {
  plate: WizardPlate;
  active: boolean;
  paintedCount: number;
  onActivate: () => void;
  onToggleContinental: () => void;
}

export default function PlateRow({ plate, active, paintedCount, onActivate, onToggleContinental }: PlateRowProps) {
  const swatch = `rgb(${plate.color_rgb[0]}, ${plate.color_rgb[1]}, ${plate.color_rgb[2]})`;
  const selectable = plate.continental;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 12px",
        background: active ? colors.bgPanel : "transparent",
        border: `1px solid ${active ? colors.accent : "transparent"}`,
        borderLeft: `2px solid ${active ? colors.accent : "transparent"}`,
        cursor: selectable ? "pointer" : "default",
        transition: "border-color 120ms, background 120ms",
      }}
      onClick={selectable ? onActivate : undefined}
    >
      <span
        style={{
          width: 14,
          height: 14,
          background: swatch,
          border: `1px solid ${colors.borderMid}`,
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1, fontFamily: fonts.sans, fontSize: 12, color: active ? colors.textPrimary : colors.textSecondary, letterSpacing: "0.03em" }}>
        Plate <span style={{ fontFamily: fonts.mono, color: colors.textMuted }}>#{plate.id}</span>
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleContinental(); }}
        style={{
          background: "transparent",
          border: "none",
          color: plate.continental ? colors.accent : colors.textMuted,
          fontSize: 10,
          letterSpacing: "0.16em",
          textTransform: "lowercase",
          fontFamily: fonts.sans,
          cursor: "pointer",
          padding: "2px 6px",
        }}
        title={plate.continental ? "Toggle to oceanic" : "Toggle to continental"}
      >
        {plate.continental ? "continent" : "ocean"}
      </button>
      <span style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.textMuted, width: 36, textAlign: "right" }}>
        {plate.continental ? `${paintedCount}` : "—"}
      </span>
    </div>
  );
}
