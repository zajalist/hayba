import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

const BEIGE = "#DED4C3";

export interface StatusBarProps {
  state: "idle" | "baking" | "ready" | "error";
  /** Short state word ("ready", "baking", etc.) rendered in the leading slot. */
  label: string;
  /** Main message — supports `<mono>123</mono>`-style spans via children. */
  children: React.ReactNode;
  /** Optional element rendered between the message body and the stop button. */
  rightSlot?: React.ReactNode;
  /** Optional element rendered between the state label divider and the message body. */
  centerSlot?: React.ReactNode;
}

const RAIL_FOR: Record<StatusBarProps["state"], string> = {
  idle:   colors.borderSoft,
  baking: colors.accent,
  ready:  BEIGE,
  error:  "#C04848",
};

export default function StatusBar({ state, label, children, rightSlot, centerSlot }: StatusBarProps) {
  const rail = RAIL_FOR[state];

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        height: 38,
        display: "flex",
        alignItems: "stretch",
        background: colors.bgBase,
        borderTop: `1px solid ${colors.borderMid}`,
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        fontSize: 13,
        zIndex: 100,
        userSelect: "none",
      }}
    >
      {/* Left rail — beige in normal, muted otherwise. No orange. */}
      <div
        style={{
          width: 2,
          background: rail,
          opacity: state === "idle" ? 0.5 : 1,
        }}
      />

      {/* State label — sentence case, beige, calmer than before. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          fontSize: 12,
          color: state === "ready" || state === "baking" ? BEIGE : colors.textSecondary,
          fontWeight: 500,
          letterSpacing: "0.01em",
        }}
      >
        {capitalize(label)}
      </div>

      {/* Vertical divider */}
      <div style={{ alignSelf: "center", width: 1, height: 20, background: colors.borderMid }} />

      {centerSlot && (
        <>
          <div style={{ display: "flex", alignItems: "center", padding: "0 4px" }}>
            {centerSlot}
          </div>
          <div style={{ alignSelf: "center", width: 1, height: 20, background: colors.borderMid }} />
        </>
      )}

      {/* Message body — sentence case, calm. */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          letterSpacing: "0.01em",
          color: colors.textSecondary,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 13,
        }}
      >
        {children}
      </div>

      {rightSlot}
    </div>
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Inline mono span for numeric values inside the status message. */
export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: fonts.mono,
      color: BEIGE,
      padding: "0 2px",
      fontSize: 12,
    }}>
      {children}
    </span>
  );
}
