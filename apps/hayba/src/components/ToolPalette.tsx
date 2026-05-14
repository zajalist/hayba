import React from "react";
import { colors, fonts, radii } from "@hayba/design-tokens";
import { IconBrush, IconErase, IconRotate, IconZoom, IconPan } from "./icons";

export type ToolName = "brush" | "erase" | "rotate" | "zoom" | "pan";

export interface ToolPaletteProps {
  active: ToolName;
  onChange: (tool: ToolName) => void;
  topOffset: number;
  bottomOffset: number;
  /** Brush radius in radians — shown only for brush/erase. */
  brushRadius?: number;
  onChangeBrushRadius?: (rad: number) => void;
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

const MIN_RAD = 0.015;
const MAX_RAD = 0.25;

export default function ToolPalette({
  active, onChange, topOffset, bottomOffset, brushRadius, onChangeBrushRadius,
}: ToolPaletteProps) {
  const showSize = (active === "brush" || active === "erase") && brushRadius != null && onChangeBrushRadius;
  const destructive = active === "erase";

  return (
    <aside
      style={{
        position: "fixed",
        left: 0,
        top: topOffset,
        bottom: bottomOffset,
        zIndex: 60,
        width: 48,
        background: colors.bgBase,
        borderRight: `1px solid ${colors.borderMid}`,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          background: colors.bgPanelHeader,
          borderBottom: `1px solid ${colors.borderMid}`,
          padding: "6px 0",
          fontSize: 8,
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

      <div style={{ display: "flex", flexDirection: "column", padding: "4px 0", flex: 1 }}>
        {TOOLS.map((t) => (
          <ToolButton key={t.name} tool={t} active={t.name === active} onClick={() => onChange(t.name)} />
        ))}
      </div>

      {showSize && (
        <SizeStrip
          value={brushRadius!}
          onChange={onChangeBrushRadius!}
          destructive={destructive}
        />
      )}
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
        width: 48,
        height: 44,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: active ? colors.bgPanel : hover ? "rgba(255,255,255,0.04)" : "transparent",
        border: "none",
        borderLeft: `2px solid ${active ? colors.accent : "transparent"}`,
        cursor: "pointer",
        transition: "background 90ms ease",
      }}
    >
      <Icon size={20} />
      {hover && (
        <span
          style={{
            position: "absolute",
            left: "100%",
            marginLeft: 8,
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
          <span style={{ marginLeft: 8, color: colors.accent, fontFamily: fonts.mono }}>
            {tool.shortcut}
          </span>
        </span>
      )}
    </button>
  );
}

function SizeStrip({ value, onChange, destructive }: {
  value: number; onChange: (r: number) => void; destructive: boolean;
}) {
  const pct = Math.min(1, Math.max(0, (value - MIN_RAD) / (MAX_RAD - MIN_RAD)));
  const degrees = (value * 180 / Math.PI).toFixed(1);
  const accent = destructive ? "#C04848" : colors.accent;
  return (
    <div
      style={{
        borderTop: `1px solid ${colors.borderMid}`,
        background: colors.bgPanelHeader,
        padding: "10px 0 12px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span style={{
        fontSize: 8,
        letterSpacing: "0.32em",
        textTransform: "uppercase",
        color: colors.textMuted,
        fontFamily: "Inter, sans-serif",
      }}>
        Size
      </span>
      <span style={{
        fontFamily: "JetBrains Mono, Consolas, monospace",
        fontSize: 10,
        color: accent,
      }}>
        {degrees}°
      </span>
      <div style={{ position: "relative", width: 20, height: 80 }}>
        <div style={{
          position: "absolute", left: 9, top: 0, bottom: 0, width: 2,
          background: colors.borderSoft,
        }} />
        <div style={{
          position: "absolute", left: 9, bottom: 0, width: 2,
          height: `${pct * 100}%`, background: accent,
        }} />
        <div style={{
          position: "absolute", left: 6, bottom: `calc(${pct * 100}% - 4px)`,
          width: 8, height: 8, background: accent, pointerEvents: "none",
          boxShadow: `0 0 0 2px ${colors.bgPanelHeader}`,
        }} />
        <input
          type="range" min={MIN_RAD} max={MAX_RAD} step={0.005} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          style={{
            position: "absolute", left: -32, top: 30, width: 80, height: 24,
            transform: "rotate(-90deg)", transformOrigin: "52px 12px",
            background: "transparent", opacity: 0, cursor: "pointer",
          }}
        />
      </div>
    </div>
  );
}
