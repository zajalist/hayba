import React from "react";
import { colors, fonts, radii } from "@hayba/design-tokens";
import type { BoundaryType } from "../wizard/state";

export interface BoundaryPopoverProps {
  screenX: number;
  screenY: number;
  plateA: number;
  plateB: number;
  current?: BoundaryType;
  onPick: (type: BoundaryType) => void;
  onClear: () => void;
  onDismiss: () => void;
}

const BEIGE = "#DED4C3";

export default function BoundaryPopover({
  screenX, screenY, plateA, plateB, current, onPick, onClear, onDismiss,
}: BoundaryPopoverProps) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left: screenX,
        top: screenY,
        zIndex: 70,
        transform: "translate(-50%, calc(-100% - 12px))",
        background: "rgba(34, 38, 46, 0.94)",
        border: `1px solid ${colors.borderMid}`,
        borderRadius: radii.sm,
        padding: 14,
        width: 260,
        fontFamily: fonts.sans,
        color: colors.textSecondary,
        backdropFilter: "blur(12px)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontSize: 13, color: BEIGE, fontWeight: 600 }}>
          Plate boundary
        </span>
        <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted }}>
          {plateA} ↔ {plateB}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
        <BoundaryButton
          label="Convergent"
          glyph="→ ← "
          active={current === "convergent"}
          onClick={() => onPick("convergent")}
          tint="#4DC080"
        />
        <BoundaryButton
          label="Divergent"
          glyph="← →"
          active={current === "divergent"}
          onClick={() => onPick("divergent")}
          tint="#5A99F2"
        />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <button
          type="button"
          onClick={onClear}
          disabled={!current}
          style={{
            background: "transparent",
            border: "none",
            color: current ? colors.textMuted : colors.borderSoft,
            fontSize: 11,
            fontFamily: fonts.sans,
            cursor: current ? "pointer" : "default",
            padding: 0,
          }}
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            background: "transparent",
            border: "none",
            color: BEIGE,
            fontSize: 11,
            fontFamily: fonts.sans,
            cursor: "pointer",
            padding: 0,
          }}
        >
          Close →
        </button>
      </div>
    </div>
  );
}

function BoundaryButton({ label, glyph, active, onClick, tint }: {
  label: string; glyph: string; active: boolean; onClick: () => void; tint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        padding: "10px 6px",
        background: active ? `${tint}22` : "rgba(255,255,255,0.03)",
        border: `1px solid ${active ? tint : colors.borderMid}`,
        borderRadius: radii.xs,
        color: active ? tint : colors.textSecondary,
        fontFamily: fonts.sans,
        fontSize: 12,
        cursor: "pointer",
        transition: "background 90ms, border-color 90ms, color 90ms",
      }}
    >
      <span style={{ fontFamily: fonts.mono, fontSize: 14, letterSpacing: "0.04em" }}>{glyph}</span>
      <span style={{ fontSize: 11, fontWeight: 500 }}>{label}</span>
    </button>
  );
}
