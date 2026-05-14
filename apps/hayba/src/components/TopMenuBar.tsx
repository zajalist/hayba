import React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { colors, fonts } from "@hayba/design-tokens";

const MENU_ITEMS = ["File", "Edit", "View", "Tools", "Help"];

export interface TopMenuBarProps {
  documentTitle?: string;
}

export default function TopMenuBar({ documentTitle = "Untitled" }: TopMenuBarProps) {
  return (
    <header
      data-tauri-drag-region
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        background: colors.bgBase,
        borderBottom: `1px solid ${colors.borderMid}`,
        color: colors.textSecondary,
        fontFamily: fonts.sans,
        display: "flex",
        flexDirection: "column",
        userSelect: "none",
      }}
    >
      {/* Menu strip — entire row is draggable except interactive children */}
      <div
        data-tauri-drag-region
        style={{ display: "flex", alignItems: "stretch", height: 32 }}
      >
        <div
          data-tauri-drag-region
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 14px 0 16px",
            borderRight: `1px solid ${colors.borderMid}`,
            pointerEvents: "none",
          }}
        >
          <svg width="14" height="17" viewBox="0 0 166 201" fill="none" style={{ pointerEvents: "none" }}>
            <path d="M139.816 56L142.492 61.8262C148.517 74.9439 153.452 94.8289 156.582 102.254C159.859 110.024 161.945 116.804 161.882 124.527C161.821 131.993 159.746 139.456 156.613 148.542C153.556 157.405 148.7 169.92 142.827 186.371L140.456 193.009H98.6381L104.123 179.295C109.128 166.783 113.266 155.9 115.863 146.185C118.465 136.45 119.297 128.661 118.294 122.227C116.597 111.336 108.943 100.707 82.9418 91.4414C56.9412 100.707 49.2868 111.336 47.5893 122.227C46.5863 128.661 47.4197 136.45 50.0219 146.185C52.619 155.9 56.7553 166.783 61.7602 179.295L67.2455 193.009H25.4272L23.058 186.371C17.1851 169.92 12.3284 157.405 9.27189 148.542C6.13864 139.456 4.06224 131.993 4.00139 124.527C3.93844 116.804 6.02502 110.024 9.30119 102.254C12.4319 94.8288 17.3679 74.944 23.393 61.8262L26.0688 56H139.816Z" fill="#DED4C3"/>
            <path d="M19 23.9102V48.4551H83.5H148V23.9102C113.042 48.4551 53.958 48.4551 19 23.9102Z" fill={colors.accent}/>
            <path d="M19 73C69.2485 83.4432 97.0527 83.2572 148 73V48.4551H83.5H148V73Z" fill={colors.accent}/>
            <path d="M19 23.9102C53.958 48.4551 113.042 48.4551 148 23.9102C116.295 -4.10732 49.1347 -3.83245 19 23.9102Z" fill={colors.accent}/>
          </svg>
          <span style={{
            fontSize: 11,
            color: colors.textPrimary,
            letterSpacing: "0.32em",
            textTransform: "uppercase",
            fontWeight: 500,
          }}>
            Hayba
          </span>
        </div>
        {MENU_ITEMS.map((item) => (
          <button
            key={item}
            type="button"
            style={{
              background: "transparent",
              border: "none",
              padding: "0 14px",
              color: colors.textSecondary,
              fontFamily: fonts.sans,
              fontSize: 12,
              cursor: "pointer",
              letterSpacing: "0.02em",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {item}
          </button>
        ))}
        <div data-tauri-drag-region style={{ flex: 1 }} />

        <div
          data-tauri-drag-region
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0 16px",
            fontSize: 10,
            color: colors.textMuted,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            borderLeft: `1px solid ${colors.borderMid}`,
            pointerEvents: "none",
          }}
        >
          Explorer v0.2
        </div>

        <WindowControls />
      </div>

      <div
        data-tauri-drag-region
        style={{
          display: "flex",
          alignItems: "stretch",
          height: 28,
          background: colors.bgDeep,
          borderBottom: `1px solid ${colors.borderMid}`,
        }}
      >
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "0 18px",
          background: colors.bgBase,
          borderRight: `1px solid ${colors.borderMid}`,
          borderTop: `2px solid ${colors.accent}`,
          marginTop: -1,
          fontSize: 11,
          color: colors.textPrimary,
          letterSpacing: "0.04em",
          pointerEvents: "none",
        }}>
          <span style={{ width: 6, height: 6, background: colors.accent, borderRadius: 1 }} />
          {documentTitle}
        </div>
      </div>
    </header>
  );
}

function WindowControls() {
  const onMin = () => getCurrentWindow().minimize().catch(() => {});
  const onMax = () => getCurrentWindow().toggleMaximize().catch(() => {});
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

function WinCtrlButton({
  children, onClick, ariaLabel, closeStyle,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  closeStyle?: boolean;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 44,
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: hover
          ? (closeStyle ? "#c0392b" : "rgba(255,255,255,0.06)")
          : "transparent",
        border: "none",
        cursor: "pointer",
        color: hover && closeStyle ? "#fff" : colors.textSecondary,
        transition: "background 90ms ease, color 90ms ease",
      }}
    >
      {children}
    </button>
  );
}
