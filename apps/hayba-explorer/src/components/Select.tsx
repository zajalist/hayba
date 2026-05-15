import React, { useEffect, useRef, useState } from "react";
import { colors, fonts } from "@hayba/design-tokens";

export interface SelectOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
}

export interface SelectProps<T extends string | number> {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
}

/**
 * Tiny custom dropdown that matches the rest of the docked chrome — flat
 * panel, thin border, no shadow, Consolas value. Used where a native
 * <select> would render OS chrome that clashes with the dark theme.
 */
export default function Select<T extends string | number>({ value, options, onChange }: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = options.find((o) => o.value === value);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          background: "transparent",
          border: "none",
          color: colors.beige,
          fontFamily: fonts.mono,
          fontSize: 12,
          cursor: "pointer",
          padding: 0,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          textAlign: "right",
        }}
      >
        <span>{current?.label}</span>
        <span style={{ color: colors.textMuted, fontSize: 9 }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: 4,
            minWidth: 160,
            background: colors.bgPanelHeader,
            border: `1px solid ${colors.borderMid}`,
            borderRadius: 3,
            padding: "4px 0",
            zIndex: 100,
          }}
        >
          {options.map((opt) => {
            const isActive = opt.value === value;
            return (
              <button
                key={String(opt.value)}
                type="button"
                onClick={() => { onChange(opt.value); setOpen(false); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "6px 12px",
                  background: isActive ? colors.bgBase : "transparent",
                  border: "none",
                  borderLeft: `2px solid ${isActive ? colors.accent : "transparent"}`,
                  color: isActive ? colors.beige : colors.textSecondary,
                  fontFamily: fonts.mono,
                  fontSize: 12,
                  cursor: "pointer",
                  textAlign: "left",
                  whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "transparent"; }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
