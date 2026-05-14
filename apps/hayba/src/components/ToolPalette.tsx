import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
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
        display: "flex",
        flexDirection: "column",
        gap: 2,
        background: colors.bgBase,
        border: `1px solid ${colors.borderMid}`,
        padding: 6,
        backdropFilter: "blur(8px)",
      }}
    >
      {TOOLS.map((t) => {
        const isActive = t.name === active;
        return <ToolButton key={t.name} tool={t} active={isActive} onClick={() => onChange(t.name)} />;
      })}
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
        width: 44,
        height: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? colors.bgPanel : hover ? colors.bgPanel : "transparent",
        border: "none",
        cursor: "pointer",
        transition: "background 90ms ease",
      }}
    >
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: 6,
          bottom: 6,
          width: 2,
          background: active ? colors.accent : "transparent",
          transition: "background 120ms ease",
        }}
      />
      <Icon size={22} />
      {/* Floating label appears on hover, off to the right */}
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
            padding: "4px 10px",
            fontSize: 10,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            fontFamily: fonts.sans,
            color: colors.textPrimary,
            whiteSpace: "nowrap",
            pointerEvents: "none",
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
