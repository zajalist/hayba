import React, { useCallback, useRef, useState } from "react";
import { colors, fonts, radii } from "@hayba/design-tokens";
import { IconBrush, IconErase, IconRotate, IconZoom, IconPan } from "./icons";

export type ToolName = "brush" | "erase" | "rotate" | "zoom" | "pan";

export interface DockToolbarProps {
  active: ToolName;
  onChange: (tool: ToolName) => void;
  brushRadius: number;
  onChangeBrushRadius: (rad: number) => void;
}

interface ToolDef {
  name: ToolName;
  label: string;
  shortcut: string;
  Icon: React.ComponentType<{ size?: number }>;
}

const TOOLS: ToolDef[] = [
  { name: "brush",  label: "Brush",  shortcut: "B", Icon: IconBrush },
  { name: "erase",  label: "Erase",  shortcut: "E", Icon: IconErase },
  { name: "rotate", label: "Rotate", shortcut: "R", Icon: IconRotate },
  { name: "zoom",   label: "Zoom",   shortcut: "Z", Icon: IconZoom },
  { name: "pan",    label: "Pan",    shortcut: "P", Icon: IconPan },
];

const BASE_SIZE     = 44;
const MAX_SIZE      = 68;
const INFLUENCE     = 110; // px from cursor where icons start growing
const SLOT_PAD      = 4;

const MIN_RAD = 0.015;
const MAX_RAD = 0.25;

export default function DockToolbar({ active, onChange, brushRadius, onChangeBrushRadius }: DockToolbarProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [cursorX, setCursorX] = useState<number | null>(null);
  const [hoveredTool, setHoveredTool] = useState<ToolName | null>(null);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCursorX(e.clientX - rect.left);
  }, []);

  const onMouseLeave = useCallback(() => {
    setCursorX(null);
  }, []);

  // Compute per-icon center positions so the magnetic effect can read them.
  // Centers depend only on BASE_SIZE since all icons start at the same size.
  const centers = TOOLS.map((_, i) => SLOT_PAD + (i + 0.5) * BASE_SIZE);

  return (
    <div
      style={{
        position: "fixed",
        bottom: 22,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 60,
        pointerEvents: "auto",
      }}
    >
      <div
        ref={rowRef}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 0,
          padding: SLOT_PAD,
          background: "rgba(34, 38, 46, 0.78)",
          border: `1px solid ${colors.borderMid}`,
          borderRadius: 14,
          boxShadow: "0 20px 50px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.04)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
        }}
      >
        {TOOLS.map((t, i) => {
          const dist = cursorX == null ? Infinity : Math.abs(cursorX - centers[i]);
          // smooth falloff: 1 at center, 0 beyond INFLUENCE.
          const closeness = Math.max(0, 1 - dist / INFLUENCE);
          const eased = closeness * closeness * (3 - 2 * closeness); // smoothstep
          const size = BASE_SIZE + (MAX_SIZE - BASE_SIZE) * eased;
          const isActive = t.name === active;
          const isHovered = hoveredTool === t.name;
          return (
            <DockSlot
              key={t.name}
              tool={t}
              isActive={isActive}
              isHovered={isHovered}
              size={size}
              onHover={() => setHoveredTool(t.name)}
              onUnhover={() => setHoveredTool((h) => (h === t.name ? null : h))}
              onClick={() => onChange(t.name)}
              brushRadius={brushRadius}
              onChangeBrushRadius={onChangeBrushRadius}
            />
          );
        })}
      </div>
    </div>
  );
}

function DockSlot({
  tool, isActive, isHovered, size, onHover, onUnhover, onClick,
  brushRadius, onChangeBrushRadius,
}: {
  tool: ToolDef;
  isActive: boolean;
  isHovered: boolean;
  size: number;
  onHover: () => void;
  onUnhover: () => void;
  onClick: () => void;
  brushRadius: number;
  onChangeBrushRadius: (r: number) => void;
}) {
  const showPopover = isHovered && (tool.name === "brush" || tool.name === "erase");
  const { Icon } = tool;
  return (
    <div
      onMouseEnter={onHover}
      onMouseLeave={onUnhover}
      style={{
        position: "relative",
        width: BASE_SIZE,
        height: BASE_SIZE,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <button
        type="button"
        onClick={onClick}
        title={`${tool.label} · ${tool.shortcut}`}
        style={{
          width: size,
          height: size,
          padding: 0,
          background: "transparent",
          border: "none",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-end",
          cursor: "pointer",
          transform: `translateY(${(size - BASE_SIZE) * -0.35}px)`,
          transition: "transform 90ms ease",
        }}
      >
        <Icon size={Math.round(size * 0.78)} />
        {/* Active dot — small accent indicator beneath the icon, apple-dock style */}
        <span
          aria-hidden
          style={{
            width: isActive ? 4 : 0,
            height: isActive ? 4 : 0,
            marginTop: 2,
            background: colors.accent,
            borderRadius: "50%",
            boxShadow: isActive ? `0 0 6px ${colors.accent}` : "none",
            transition: "width 120ms ease, height 120ms ease",
          }}
        />
      </button>

      {/* Tooltip label — sits above the icon, fades in with hover */}
      <div
        style={{
          position: "absolute",
          bottom: size + (size - BASE_SIZE) * 0.35 + 12,
          left: "50%",
          transform: "translateX(-50%)",
          opacity: isHovered ? 1 : 0,
          pointerEvents: "none",
          transition: "opacity 120ms ease",
          background: colors.bgBase,
          border: `1px solid ${colors.borderMid}`,
          borderRadius: radii.xs,
          padding: "5px 12px",
          fontSize: 10,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          fontFamily: fonts.sans,
          color: colors.textPrimary,
          whiteSpace: "nowrap",
          boxShadow: "0 6px 20px rgba(0,0,0,0.45)",
        }}
      >
        {tool.label}
        <span style={{ marginLeft: 10, color: colors.accent, fontFamily: fonts.mono }}>
          {tool.shortcut}
        </span>
      </div>

      {/* Premium brush-size popover — only on brush/erase hover */}
      {showPopover && (
        <BrushSizePopover
          destructive={tool.name === "erase"}
          value={brushRadius}
          onChange={onChangeBrushRadius}
          anchorBottom={size + (size - BASE_SIZE) * 0.35 + 44}
        />
      )}
    </div>
  );
}

function BrushSizePopover({
  value, onChange, anchorBottom, destructive,
}: {
  value: number; onChange: (r: number) => void; anchorBottom: number; destructive: boolean;
}) {
  const pct = Math.min(1, Math.max(0, (value - MIN_RAD) / (MAX_RAD - MIN_RAD)));
  const degrees = (value * 180 / Math.PI).toFixed(1);
  const accent = destructive ? "#C04848" : colors.accent;
  // Preview disc — diameter scales smoothly with radius.
  const previewDiameter = 18 + pct * 46;
  return (
    <div
      style={{
        position: "absolute",
        bottom: anchorBottom,
        left: "50%",
        transform: "translateX(-50%)",
        background: colors.bgBase,
        border: `1px solid ${colors.borderMid}`,
        borderRadius: 12,
        boxShadow: "0 16px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)",
        backdropFilter: "blur(8px)",
        padding: "14px 16px 12px",
        width: 220,
        fontFamily: fonts.sans,
        pointerEvents: "auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 9, color: colors.textMuted, letterSpacing: "0.32em", textTransform: "uppercase", fontWeight: 600 }}>
          Brush size
        </span>
        <span style={{ fontFamily: fonts.mono, fontSize: 11, color: accent }}>
          {degrees}°
        </span>
      </div>

      {/* Preview disc + horizontal track */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}>
        <div style={{
          width: 64, height: 64,
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <div style={{
            width: previewDiameter,
            height: previewDiameter,
            borderRadius: "50%",
            background: `radial-gradient(circle at 50% 50%, ${accent}66 0%, ${accent}22 60%, transparent 100%)`,
            border: `1px solid ${accent}`,
            transition: "width 90ms ease, height 90ms ease",
          }} />
        </div>
        <div style={{ flex: 1, position: "relative", height: 24, display: "flex", alignItems: "center" }}>
          <div style={{
            position: "absolute", left: 0, right: 0, height: 2,
            background: colors.borderSoft, borderRadius: 1,
          }} />
          <div style={{
            position: "absolute", left: 0, width: `${pct * 100}%`, height: 2,
            background: accent, borderRadius: 1,
          }} />
          <div style={{
            position: "absolute",
            left: `calc(${pct * 100}% - 6px)`,
            width: 12, height: 12,
            background: accent,
            borderRadius: "50%",
            border: `2px solid ${colors.bgBase}`,
            boxShadow: `0 0 0 1px ${accent}, 0 2px 6px ${accent}55`,
            pointerEvents: "none",
          }} />
          <input
            type="range"
            min={MIN_RAD} max={MAX_RAD} step={0.005}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            style={{
              position: "absolute", inset: 0,
              width: "100%", height: 24,
              background: "transparent", opacity: 0, cursor: "pointer",
            }}
          />
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: colors.textMuted, letterSpacing: "0.12em", fontFamily: fonts.mono }}>
        <span>0.9°</span>
        <span>14.3°</span>
      </div>
    </div>
  );
}
