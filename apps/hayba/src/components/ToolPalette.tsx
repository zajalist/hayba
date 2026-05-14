import React from "react";
import { colors, fonts, radii } from "@hayba/design-tokens";
import { IconBrush, IconErase, IconRotate, IconZoom, IconPan } from "./icons";

export type ToolName = "brush" | "erase" | "rotate" | "zoom" | "pan";

export interface ToolPaletteProps {
  active: ToolName;
  onChange: (tool: ToolName) => void;
}

interface ToolDef {
  name: ToolName;
  label: string;
  shortcut: string;
  icon: React.ComponentType<{ size?: number }>;
}

const TOOLS: ToolDef[] = [
  { name: "brush",  label: "Brush",  shortcut: "B", icon: IconBrush },
  { name: "erase",  label: "Erase",  shortcut: "E", icon: IconErase },
  { name: "rotate", label: "Rotate", shortcut: "R", icon: IconRotate },
  { name: "zoom",   label: "Zoom",   shortcut: "Z", icon: IconZoom },
  { name: "pan",    label: "Pan",    shortcut: "P", icon: IconPan },
];

export default function ToolPalette({ active, onChange }: ToolPaletteProps) {
  return (
    <aside
      style={{
        position: "fixed",
        left: 20,
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 60,
        background: colors.bgBase,
        border: `1px solid ${colors.borderMid}`,
        borderRadius: radii.sm,
        boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* UE-style tab cap */}
      <div
        style={{
          background: colors.bgPanelHeader,
          borderBottom: `1px solid ${colors.borderMid}`,
          padding: "6px 10px",
          fontSize: 9,
          letterSpacing: "0.32em",
          textTransform: "uppercase",
          fontWeight: 500,
          color: colors.textMuted,
          textAlign: "center",
          fontFamily: fonts.sans,
        }}
      >
        Tools
      </div>

      <div style={{ display: "flex", flexDirection: "column", padding: 4, gap: 2 }}>
        {TOOLS.map((t) => (
          <ToolButton key={t.name} tool={t} active={t.name === active} onClick={() => onChange(t.name)} />
        ))}
      </div>
    </aside>
  );
}

function ToolButton({ tool, active, onClick }: { tool: ToolDef; active: boolean; onClick: () => void }) {
  const [hover, setHover] = React.useState(false);
  const Icon = tool.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${tool.label} · ${tool.shortcut}`}
      style={{
        position: "relative",
        width: 40,
        height: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active
          ? colors.bgPanel
          : hover ? "rgba(255,255,255,0.04)" : "transparent",
        border: active ? `1px solid ${colors.accent}` : `1px solid transparent`,
        borderRadius: radii.xs,
        cursor: "pointer",
        transition: "background 90ms ease, border-color 90ms ease",
      }}
    >
      <Icon size={22} />
      {hover && (
        <span
          style={{
            position: "absolute",
            left: "100%",
            marginLeft: 12,
            top: "50%",
            transform: "translateY(-50%)",
            background: colors.bgBase,
            border: `1px solid ${colors.borderMid}`,
            borderRadius: radii.xs,
            padding: "4px 10px",
            fontSize: 10,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            fontFamily: fonts.sans,
            color: colors.textPrimary,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
          }}
        >
          {tool.label}
          <span style={{ marginLeft: 8, color: colors.accentText, fontFamily: fonts.mono }}>
            {tool.shortcut}
          </span>
        </span>
      )}
    </button>
  );
}
