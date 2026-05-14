import React, { useCallback, useEffect, useRef, useState } from "react";
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
const MAX_SIZE      = 72;
const SLOT_GAP      = 16;   // breathing room between icons
const SLOT_WIDTH    = BASE_SIZE + SLOT_GAP;
const INFLUENCE     = 75;   // px — tight so only the hovered icon + immediate neighbour grow
const ROW_PAD       = 8;
const DOCK_BOTTOM   = 64;   // lift the dock above the status bar
const POPOVER_GAP   = 16;   // visible space between icon top and popover bottom
const BRIDGE_PAD    = 24;   // invisible forgiveness band the cursor can cross

const MIN_RAD = 0.015;
const MAX_RAD = 0.25;

export default function DockToolbar({ active, onChange, brushRadius, onChangeBrushRadius }: DockToolbarProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [cursorX, setCursorX] = useState<number | null>(null);
  const [hoveredTool, setHoveredTool] = useState<ToolName | null>(null);
  // Forgiveness window — the popover stays open for a beat after the cursor
  // leaves the slot, so brief crossings of dead space don't dismiss it.
  const hideTimerRef = useRef<number | null>(null);

  const requestHover = useCallback((tool: ToolName) => {
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setHoveredTool(tool);
  }, []);

  const requestUnhover = useCallback((tool: ToolName) => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      setHoveredTool((h) => (h === tool ? null : h));
      hideTimerRef.current = null;
    }, 240);
  }, []);

  useEffect(() => () => {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect) return;
    setCursorX(e.clientX - rect.left);
  }, []);

  const onMouseLeave = useCallback(() => {
    setCursorX(null);
  }, []);

  // Per-slot centers — every slot is SLOT_WIDTH wide.
  const centers = TOOLS.map((_, i) => ROW_PAD + (i + 0.5) * SLOT_WIDTH);

  return (
    <div
      style={{
        position: "fixed",
        bottom: DOCK_BOTTOM,
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
          padding: ROW_PAD,
          background: "rgba(34, 38, 46, 0.78)",
          border: `1px solid ${colors.borderMid}`,
          borderRadius: 16,
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
          backdropFilter: "blur(14px)",
          WebkitBackdropFilter: "blur(14px)",
        }}
      >
        {TOOLS.map((t, i) => {
          const dist = cursorX == null ? Infinity : Math.abs(cursorX - centers[i]);
          const closeness = Math.max(0, 1 - dist / INFLUENCE);
          const eased = closeness * closeness * (3 - 2 * closeness);
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
              onHover={() => requestHover(t.name)}
              onUnhover={() => requestUnhover(t.name)}
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
  const iconLift = (size - BASE_SIZE) * 0.35;
  // Anchor (in CSS bottom-from-slot terms) where the popover floats.
  const popAnchor = size + iconLift + POPOVER_GAP;
  return (
    <div
      onMouseEnter={onHover}
      onMouseLeave={onUnhover}
      style={{
        position: "relative",
        width: SLOT_WIDTH,
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
          transform: `translateY(${-iconLift}px)`,
          transition: "transform 70ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <Icon size={Math.round(size * 0.82)} />
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

      {/* Tooltip label — only when there's no popover open above the icon */}
      {!showPopover && (
        <div
          style={{
            position: "absolute",
            bottom: size + iconLift + 10,
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
            boxShadow: "none",
          }}
        >
          {tool.label}
          <span style={{ marginLeft: 10, color: colors.accent, fontFamily: fonts.mono }}>
            {tool.shortcut}
          </span>
        </div>
      )}

      {/* Hover bridge — invisible band that bridges the icon top to the
          popover bottom plus a forgiveness pad on each side so the cursor
          can wander a bit without losing the hover state. */}
      {showPopover && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            bottom: size + iconLift - 4,
            left: -BRIDGE_PAD,
            right: -BRIDGE_PAD,
            height: POPOVER_GAP + 8 + BRIDGE_PAD,
            pointerEvents: "auto",
          }}
        />
      )}

      {showPopover && (
        <BrushSizePopover
          destructive={tool.name === "erase"}
          value={brushRadius}
          onChange={onChangeBrushRadius}
          anchorBottom={popAnchor}
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
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
        backdropFilter: "blur(8px)",
        padding: "14px 16px 12px",
        width: 240,
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
