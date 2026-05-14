import React, { useEffect } from "react";
import { colors, fonts } from "@hayba/design-tokens";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  open, title, body, confirmLabel = "confirm", cancelLabel = "cancel",
  destructive, onConfirm, onCancel,
}: ConfirmDialogProps) {
  // Escape cancels, Enter confirms — matches OS conventions.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      else if (e.key === "Enter") { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  const accent = destructive ? colors.accentHover : colors.accent;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(15, 17, 22, 0.62)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(6px)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380,
          background: colors.bgBase,
          border: `1px solid ${colors.borderMid}`,
          borderLeft: `2px solid ${accent}`,
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
          color: colors.textPrimary,
          fontFamily: fonts.sans,
          padding: "20px 22px 18px",
        }}
      >
        <div style={{ fontSize: 10, color: accent, letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 8 }}>
          {destructive ? "destructive action" : "confirm"}
        </div>
        <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "0.02em", marginBottom: 10 }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: colors.textSecondary, lineHeight: 1.55, marginBottom: 22 }}>
          {body}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: "transparent",
              border: `1px solid ${colors.borderSoft}`,
              color: colors.textSecondary,
              padding: "8px 16px",
              fontSize: 11,
              letterSpacing: "0.18em",
              textTransform: "lowercase",
              fontFamily: fonts.sans,
              cursor: "pointer",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              background: accent,
              color: colors.bgDeep,
              border: `1px solid ${accent}`,
              padding: "8px 16px",
              fontSize: 11,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              fontWeight: 600,
              fontFamily: fonts.sans,
              cursor: "pointer",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
