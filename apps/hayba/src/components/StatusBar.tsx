import React from "react";
import { colors, fonts } from "@hayba/design-tokens";

export interface StatusBarProps {
  state: "idle" | "baking" | "ready" | "error";
  message: string;
  /** When the future MCP layer lands, this becomes a real stop handler. */
  onStop?: () => void;
}

export default function StatusBar({ state, message, onStop }: StatusBarProps) {
  const dotColor =
    state === "ready" ? colors.accent :
    state === "baking" ? colors.secondary :
    state === "error" ? "#d77f24" :
    colors.textMuted;

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        height: 32,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0 14px",
        background: colors.bgBase,
        borderTop: `1px solid ${colors.borderMid}`,
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        fontSize: 12,
        letterSpacing: "0.03em",
        zIndex: 100,
        userSelect: "none",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: dotColor,
          boxShadow: `0 0 6px ${dotColor}`,
        }}
      />
      <span style={{ flex: 1 }}>{message}</span>
      <button
        type="button"
        disabled={state !== "baking"}
        onClick={onStop}
        style={{
          background: "transparent",
          border: `1px solid ${colors.borderSoft}`,
          color: state === "baking" ? colors.textPrimary : colors.textMuted,
          padding: "3px 12px",
          borderRadius: 4,
          fontSize: 11,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          cursor: state === "baking" ? "pointer" : "default",
          fontFamily: fonts.sans,
        }}
      >
        Stop
      </button>
    </div>
  );
}
