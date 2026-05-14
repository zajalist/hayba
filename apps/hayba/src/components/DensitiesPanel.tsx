import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { colors, fonts, radii } from "@hayba/design-tokens";
import type { PlanetSnapshot } from "../App";
import { PLATE_PALETTE } from "../viewport/globe";

const BEIGE = "#DED4C3";

export interface DensitiesPanelProps {
  snapshot: PlanetSnapshot;
  topOffset: number;
  /** Current ordering — plate ids lightest → densest. */
  order: number[];
  /** Caller updates the order + receives the new snapshot from apply_density_rank. */
  onChange: (order: number[], snap: PlanetSnapshot) => void;
  onBack: () => void;
  onStart: () => void;
}

/**
 * "Densities" wizard step — TE's drag-to-rank simplified to a vertical list
 * with up/down arrows. Top of list = lightest (floats on top); bottom =
 * densest (subducts). Each reorder live-applies via apply_density_rank so
 * the running sim's plate densities change in place.
 */
export default function DensitiesPanel({
  snapshot, topOffset, order, onChange, onBack, onStart,
}: DensitiesPanelProps) {
  const move = async (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[idx], next[target]] = [next[target], next[idx]];
    try {
      const snap = await invoke<PlanetSnapshot>("apply_density_rank", { order: next });
      onChange(next, snap);
    } catch {
      onChange(next, snapshot);
    }
  };

  return (
    <aside
      style={{
        position: "fixed",
        right: 22,
        top: topOffset + 22,
        zIndex: 60,
        width: 320,
        background: "rgba(34, 38, 46, 0.92)",
        border: `1px solid ${colors.borderMid}`,
        borderRadius: radii.sm,
        backdropFilter: "blur(14px)",
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        overflow: "hidden",
      }}
    >
      <header style={{
        background: colors.bgPanelHeader,
        borderBottom: `1px solid ${colors.borderMid}`,
        borderLeft: `2px solid ${colors.accent}`,
        padding: "14px 16px",
      }}>
        <div style={{ fontSize: 15, color: BEIGE, fontWeight: 600, letterSpacing: "0.01em" }}>
          Densities
        </div>
        <div style={{ fontSize: 12, color: colors.textMuted, marginTop: 4, lineHeight: 1.5 }}>
          Drag plates to rank them lightest (top) to densest (bottom). Lighter plates float above denser ones at convergent boundaries.
        </div>
      </header>

      <div style={{ padding: "10px 14px", maxHeight: 360, overflowY: "auto" }}>
        {order.map((plateId, idx) => {
          const tint = PLATE_PALETTE[(plateId - 1) % PLATE_PALETTE.length];
          const swatch = `rgb(${Math.round(tint[0]*255)}, ${Math.round(tint[1]*255)}, ${Math.round(tint[2]*255)})`;
          const densityT = order.length <= 1 ? 0.5 : idx / (order.length - 1);
          const density = (0.30 + densityT * (1.20 - 0.30)).toFixed(2);
          return (
            <div
              key={plateId}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 8px",
                borderBottom: `1px solid ${colors.borderMid}`,
              }}
            >
              <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, width: 18 }}>
                {String(idx + 1).padStart(2, "0")}
              </span>
              <span style={{
                width: 14, height: 14,
                background: swatch,
                border: `1px solid ${colors.borderSoft}`,
                borderRadius: 3,
              }} />
              <span style={{ flex: 1, fontSize: 13, color: BEIGE }}>
                Plate <span style={{ fontFamily: fonts.mono, color: swatch }}>{plateId}</span>
              </span>
              <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted }}>
                {density}
              </span>
              <div style={{ display: "flex", gap: 4 }}>
                <ArrowBtn dir="up"   disabled={idx === 0}                onClick={() => move(idx, -1)} />
                <ArrowBtn dir="down" disabled={idx === order.length - 1} onClick={() => move(idx, +1)} />
              </div>
            </div>
          );
        })}
      </div>

      <footer style={{
        padding: "14px 16px",
        borderTop: `1px solid ${colors.borderMid}`,
        background: colors.bgPanelHeader,
        display: "flex",
        gap: 8,
      }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            background: "transparent",
            border: `1px solid ${colors.borderSoft}`,
            borderRadius: radii.xs,
            color: colors.textSecondary,
            padding: "10px 14px",
            fontSize: 13,
            cursor: "pointer",
            fontFamily: fonts.sans,
          }}
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onStart}
          style={{
            flex: 1,
            background: "transparent",
            border: `1px solid ${BEIGE}`,
            borderRadius: radii.xs,
            color: BEIGE,
            padding: "10px 14px",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
            fontFamily: fonts.sans,
            transition: "background 140ms",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(222,212,195,0.06)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          Start simulation →
        </button>
      </footer>
    </aside>
  );
}

function ArrowBtn({ dir, disabled, onClick }: { dir: "up" | "down"; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 22,
        height: 22,
        padding: 0,
        background: "transparent",
        border: `1px solid ${disabled ? "transparent" : colors.borderSoft}`,
        borderRadius: 3,
        color: disabled ? colors.borderSoft : colors.textSecondary,
        fontFamily: fonts.sans,
        fontSize: 12,
        cursor: disabled ? "default" : "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {dir === "up" ? "↑" : "↓"}
    </button>
  );
}
