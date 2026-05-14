import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

export interface StatusBarProps {
  state: "idle" | "baking" | "ready" | "error";
  /** Short state word ("ready", "baking", etc.) rendered in the leading slot. */
  label: string;
  /** Main message — supports `<mono>123</mono>`-style spans via children. */
  children: React.ReactNode;
  /** When the future MCP layer lands, this becomes a real stop handler. */
  onStop?: () => void;
}

const ACCENT_FOR: Record<StatusBarProps["state"], string> = {
  idle:   colors.textMuted,
  baking: colors.secondary,
  ready:  colors.accent,
  error:  colors.accentHover,
};

export default function StatusBar({ state, label, children, onStop }: StatusBarProps) {
  const accent = ACCENT_FOR[state];
  const canStop = state === "baking";

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        height: 28,
        display: "flex",
        alignItems: "stretch",
        background: colors.bgBase,
        borderTop: `1px solid ${colors.borderMid}`,
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        fontSize: 12,
        zIndex: 100,
        userSelect: "none",
      }}
    >
      {/* Left accent rail — 2px vertical bar; the only color affordance for state. */}
      <div
        style={{
          width: 2,
          background: accent,
          opacity: state === "idle" ? 0.35 : 1,
        }}
      />

      {/* State label slot — small caps, tracked, deliberately understated. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 14px 0 16px",
          fontSize: 9,
          letterSpacing: "0.32em",
          textTransform: "uppercase",
          color: accent,
          fontWeight: 500,
        }}
      >
        {label}
      </div>

      {/* Vertical divider */}
      <div style={{ alignSelf: "center", width: 1, height: 14, background: colors.borderSoft }} />

      {/* Message body — mono numerics ride on top of the sans-serif copy via <Mono />. */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          letterSpacing: "0.02em",
          color: colors.textSecondary,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </div>

      <button
        type="button"
        disabled={!canStop}
        onClick={onStop}
        style={{
          alignSelf: "center",
          marginRight: 10,
          background: "transparent",
          border: "none",
          color: canStop ? colors.textPrimary : colors.textMuted,
          padding: "4px 10px",
          fontSize: 10,
          letterSpacing: "0.22em",
          textTransform: "lowercase",
          cursor: canStop ? "pointer" : "default",
          fontFamily: fonts.sans,
          borderBottom: `1px solid ${canStop ? colors.accent : "transparent"}`,
        }}
      >
        stop
      </button>
    </div>
  );
}

/** Inline mono span for numeric values inside the status message. */
export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontFamily: fonts.mono, color: colors.textPrimary, padding: "0 1px" }}>
      {children}
    </span>
  );
}
