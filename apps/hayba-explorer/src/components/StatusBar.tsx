import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import { ICON_URLS } from "./icons";

export type StatusMode = "compose" | "boundaries" | "densities" | "simulate";

export interface TelemetryChip {
  label: string;
  value: React.ReactNode;
}

export interface StatusBarProps {
  mode: StatusMode;
  chips: TelemetryChip[];
  /** Optional hint sentence to render after the chips. */
  hint?: string;
  /** Right-aligned slot (Simulate uses this for the Play/Pause + Era cluster). */
  rightSlot?: React.ReactNode;
  /** Exclusive busy slot — spinner + label (e.g. "Building grid…", "Baking…"). */
  busy?: string;
}

const MODE_META: Record<StatusMode, { label: string; icon: string }> = {
  compose:    { label: "Compose",    icon: ICON_URLS.categoryCompose },
  boundaries: { label: "Boundaries", icon: ICON_URLS.categoryBoundaries },
  densities:  { label: "Densities",  icon: ICON_URLS.categoryDensities },
  simulate:   { label: "Simulate",   icon: ICON_URLS.categorySimulate },
};

/** Inline mono span — kept exported so callers building chip values can reuse it. */
export function Mono({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: fonts.mono, color: colors.beige }}>{children}</span>;
}

export default function StatusBar({ mode, chips, hint, rightSlot, busy }: StatusBarProps) {
  const meta = MODE_META[mode];
  return (
    <div style={{
      height: 36,
      background: colors.bgStatusBar,
      borderTop: `1px solid ${colors.borderMid}`,
      display: "flex",
      alignItems: "stretch",
      color: colors.textSecondary,
      fontFamily: fonts.sans,
      fontSize: 12,
    }}>
      <style>{`@keyframes hayba-status-spin{to{transform:rotate(360deg)}}`}</style>
      {/* Mode badge */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 18px", color: colors.beige }}>
        <img
          src={meta.icon}
          alt={meta.label}
          width={13}
          height={13}
          style={{ filter: "brightness(0) invert(1)" }}
        />
        {meta.label}
      </div>

      <Divider />

      {busy && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px", color: colors.beige }}>
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                border: `2px solid ${colors.accent}`,
                borderTopColor: "transparent",
                animation: "hayba-status-spin 0.8s linear infinite",
                display: "inline-block",
              }}
            />
            <span>{busy}</span>
          </div>
          <Divider />
        </>
      )}

      {/* Telemetry */}
      <div style={{ display: "flex", alignItems: "center", gap: 24, padding: "0 18px", flex: 1, minWidth: 0 }}>
        {chips.map((c, i) => (
          <span key={i} style={{ whiteSpace: "nowrap" }}>
            <span style={{ color: colors.textMuted }}>{c.label}</span>{" "}
            <span style={{ color: colors.beige, fontFamily: fonts.mono, marginLeft: 6 }}>{c.value}</span>
          </span>
        ))}
        {hint && <span style={{ color: colors.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</span>}
      </div>

      {rightSlot && (
        <>
          <Divider />
          <div style={{ display: "flex", alignItems: "center", padding: "0 14px" }}>{rightSlot}</div>
        </>
      )}

      <Divider />
      <div style={{
        display: "flex",
        alignItems: "center",
        padding: "0 18px",
        color: colors.textMuted,
        fontFamily: fonts.mono,
        fontSize: 11,
      }}>
        0.0 GB / 0.4 GB
      </div>
    </div>
  );
}

function Divider() {
  return <div style={{ width: 1, alignSelf: "center", height: 18, background: colors.borderMid }} />;
}
