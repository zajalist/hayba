import React, { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { colors, fonts } from "@hayba/design-tokens";
import { Logo } from "./icons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopBarProps {
  divisions: number;
  documentTitle: string;
}

interface MenuItem {
  label: string;
  shortcut?: string;
  onClick: () => void;
  separator?: never;
}

interface MenuSeparator {
  separator: true;
  label?: never;
  shortcut?: never;
  onClick?: never;
}

type MenuEntry = MenuItem | MenuSeparator;

// ---------------------------------------------------------------------------
// Menu definitions
// ---------------------------------------------------------------------------

function buildMenus(closeMenu: () => void): Record<string, MenuEntry[]> {
  const close = () => closeMenu();
  return {
    File: [
      { label: "New planet…",  shortcut: "Ctrl+N",       onClick: close },
      { label: "Open…",        shortcut: "Ctrl+O",       onClick: close },
      { label: "Save",         shortcut: "Ctrl+S",       onClick: close },
      { label: "Save as…",     shortcut: "Ctrl+Shift+S", onClick: close },
      { separator: true },
      {
        label: "Exit",
        shortcut: "Alt+F4",
        onClick: () => { close(); getCurrentWindow().close().catch(() => {}); },
      },
    ],
    Edit: [
      { label: "Undo",           shortcut: "Ctrl+Z", onClick: close },
      { label: "Redo",           shortcut: "Ctrl+Y", onClick: close },
      { separator: true },
      { label: "Reset to wizard",                    onClick: close },
    ],
    View: [
      { label: "Toggle plate labels",  onClick: close },
      { label: "Toggle force arrows",  onClick: close },
      { label: "Recenter camera",      onClick: close },
      { label: "Toggle right panel",   onClick: close },
    ],
    Tools: [
      { label: "Command palette", shortcut: "Ctrl+K", onClick: close },
    ],
    Help: [
      { label: "About",     onClick: close },
      { label: "Open docs", onClick: close },
    ],
  };
}

// ---------------------------------------------------------------------------
// WinCtrlButton — 42×34 hit area
// ---------------------------------------------------------------------------

function WinCtrlButton({
  children,
  onClick,
  ariaLabel,
  closeStyle,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  closeStyle?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 42,
        height: 34,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: hover
          ? closeStyle ? "#c0392b" : "rgba(255,255,255,0.06)"
          : "transparent",
        border: "none",
        cursor: "pointer",
        color: hover && closeStyle ? "#fff" : colors.textSecondary,
        transition: "background 90ms ease, color 90ms ease",
        flexShrink: 0,
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// WindowControls — min / max / close
// ---------------------------------------------------------------------------

function WindowControls() {
  const onMin   = () => getCurrentWindow().minimize().catch(() => {});
  const onMax   = () => getCurrentWindow().toggleMaximize().catch(() => {});
  const onClose = () => getCurrentWindow().close().catch(() => {});
  return (
    <div style={{ display: "flex", alignItems: "stretch" }}>
      <WinCtrlButton onClick={onMin} ariaLabel="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </WinCtrlButton>
      <WinCtrlButton onClick={onMax} ariaLabel="Maximize">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </WinCtrlButton>
      <WinCtrlButton onClick={onClose} ariaLabel="Close" closeStyle>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.2" />
          <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </WinCtrlButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MenuDropdown
// ---------------------------------------------------------------------------

function MenuDropdown({
  entries,
}: {
  entries: MenuEntry[];
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        minWidth: 220,
        background: colors.bgPanelHeader,
        border: `1px solid ${colors.borderMid}`,
        borderTop: "none",
        zIndex: 200,
        padding: "3px 0",
      }}
    >
      {entries.map((entry, i) => {
        if ("separator" in entry && entry.separator) {
          return (
            <div
              key={i}
              style={{
                height: 1,
                background: colors.borderMid,
                margin: "3px 0",
              }}
            />
          );
        }
        const item = entry as MenuItem;
        return (
          <button
            key={i}
            type="button"
            onClick={item.onClick}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              width: "100%",
              padding: "4px 14px",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: colors.textPrimary,
              fontFamily: fonts.sans,
              fontSize: 12,
              textAlign: "left",
              gap: 24,
              whiteSpace: "nowrap",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.06)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "transparent";
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && (
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: 11,
                  color: colors.textMuted,
                  flexShrink: 0,
                }}
              >
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

const MENU_KEYS = ["File", "Edit", "View", "Tools", "Help"] as const;

export default function TopBar({ divisions, documentTitle }: TopBarProps) {
  const [openId, setOpenId] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!openId) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenId(null);
    }
    function onPointerDown(e: PointerEvent) {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenId(null);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [openId]);

  const menus = buildMenus(() => setOpenId(null));

  function toggleMenu(id: string) {
    setOpenId((prev) => (prev === id ? null : id));
  }

  return (
    <header
      ref={barRef}
      data-tauri-drag-region
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 34,
        zIndex: 100,
        background: colors.bgTopBar,
        borderBottom: `1px solid ${colors.borderMid}`,
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        display: "flex",
        alignItems: "stretch",
        userSelect: "none",
      }}
    >
      {/* ---- Logo ---- */}
      <div
        data-tauri-drag-region
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          flexShrink: 0,
          pointerEvents: "none",
        }}
      >
        <Logo size={20} />
      </div>

      {/* ---- Menu buttons ---- */}
      {MENU_KEYS.map((id) => {
        const isOpen = openId === id;
        return (
          <div
            key={id}
            style={{ position: "relative", display: "flex", alignItems: "stretch" }}
          >
            <button
              type="button"
              onClick={() => toggleMenu(id)}
              style={{
                background: isOpen ? colors.bgBase : "transparent",
                border: "none",
                borderBottomStyle: "solid",
                borderBottomWidth: 1,
                borderBottomColor: isOpen ? colors.accent : "transparent",
                padding: "0 12px",
                color: isOpen ? colors.beige : colors.textSecondary,
                fontFamily: fonts.sans,
                fontSize: 12,
                cursor: "pointer",
                letterSpacing: "0.02em",
                display: "flex",
                alignItems: "center",
                flexShrink: 0,
                transition: "background 80ms ease, color 80ms ease",
              }}
              onMouseEnter={(e) => {
                if (!isOpen) e.currentTarget.style.background = "rgba(255,255,255,0.04)";
              }}
              onMouseLeave={(e) => {
                if (!isOpen) e.currentTarget.style.background = "transparent";
              }}
              aria-haspopup="true"
              aria-expanded={isOpen}
            >
              {/* Alt-mnemonic underline on first letter */}
              <span>
                <span style={{ textDecoration: "underline" }}>{id[0]}</span>
                {id.slice(1)}
              </span>
            </button>

            {isOpen && <MenuDropdown entries={menus[id]} />}
          </div>
        );
      })}

      {/* ---- Center drag spacer + file indicator ---- */}
      <div
        data-tauri-drag-region
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        {/* Divisions badge */}
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 11,
            color: colors.textMuted,
            border: `1px solid ${colors.borderMid}`,
            borderRadius: 2,
            padding: "1px 5px",
            lineHeight: 1,
            flexShrink: 0,
          }}
        >
          {divisions}
        </span>

        {/* Italic beige filename */}
        <span
          style={{
            fontStyle: "italic",
            fontSize: 12,
            color: colors.beige,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {documentTitle}
        </span>
      </div>

      {/* ---- Version string ---- */}
      <div
        data-tauri-drag-region
        style={{
          display: "flex",
          alignItems: "center",
          padding: "0 12px 0 8px",
          flexShrink: 0,
          fontFamily: fonts.mono,
          fontSize: 11,
          color: colors.textMuted,
          pointerEvents: "none",
        }}
      >
        hayba 0.1 dev
      </div>

      {/* ---- Window controls ---- */}
      <WindowControls />
    </header>
  );
}
