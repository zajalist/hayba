import React from "react";
import { invoke } from "@tauri-apps/api/core";
import { colors, fonts } from "@hayba/design-tokens";
import PropertySection from "../PropertySection";
import type { PlanetSnapshot } from "../../App";
import { PLATE_PALETTE } from "../../viewport/globe";

export interface DensitiesPanelDockedProps {
  snapshot: PlanetSnapshot;
  /** Plate ids, lightest → densest. */
  order: number[];
  onChange: (order: number[], snap: PlanetSnapshot) => void;
  onBack: () => void;
  onStart: () => void;
}

export default function DensitiesPanelDocked({
  snapshot, order, onChange, onBack, onStart,
}: DensitiesPanelDockedProps) {
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ flex: 1, overflowY: "auto", paddingBottom: 12 }}>
        <PropertySection heading="Plate density rank">
          <div style={{
            padding: "4px 16px 8px",
            color: colors.textSecondary,
            fontFamily: fonts.sans,
            fontSize: 12,
            lineHeight: 1.5,
          }}>
            Lightest on top floats over the densest at the bottom.
          </div>

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
                  padding: "6px 16px",
                  borderBottom: `1px solid ${colors.rule}`,
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
                <span style={{ flex: 1, fontSize: 13, color: colors.beige }}>
                  Plate <span style={{ fontFamily: fonts.mono, color: swatch }}>{plateId}</span>
                </span>
                <span style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted }}>
                  {density}
                </span>
                <div style={{ display: "flex", gap: 4 }}>
                  <ArrowBtn dir="up"   disabled={idx === 0}                 onClick={() => move(idx, -1)} />
                  <ArrowBtn dir="down" disabled={idx === order.length - 1} onClick={() => move(idx, +1)} />
                </div>
              </div>
            );
          })}
        </PropertySection>
      </div>

      <div style={{
        padding: "10px 14px",
        borderTop: `1px solid ${colors.borderMid}`,
        background: colors.bgPanelHeader,
        display: "flex",
        gap: 8,
      }}>
        <button type="button" onClick={onBack} style={secondaryBtn} aria-label="Back to boundaries">Back</button>
        <button type="button" onClick={onStart} style={primaryBtn}>Start simulation</button>
      </div>
    </div>
  );
}

function ArrowBtn({ dir, disabled, onClick }: { dir: "up" | "down"; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === "up" ? "Move up" : "Move down"}
      style={{
        width: 22,
        height: 22,
        padding: 0,
        background: "transparent",
        border: `1px solid ${disabled ? "transparent" : colors.borderSoft}`,
        borderRadius: 3,
        color: disabled ? colors.borderSoft : colors.textSecondary,
        fontFamily: "inherit",
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

const baseBtn: React.CSSProperties = {
  padding: "9px 12px",
  background: "transparent",
  borderRadius: 3,
  fontFamily: "inherit",
  fontSize: 12,
  cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  ...baseBtn,
  border: `1px solid ${colors.borderSoft}`,
  color: colors.textSecondary,
};
const primaryBtn: React.CSSProperties = {
  ...baseBtn,
  flex: 1,
  border: `1px solid ${colors.beige}`,
  color: colors.beige,
};
