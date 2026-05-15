import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import {
  SATMAP_NAMES,
  SATMAP_FAMILIES,
  BIOME_SLOTS,
  satMapUrl,
  type SatMapName,
} from "../../viewport/satmap-loader";

export interface TexturingPanelProps {
  assignments: Record<number, SatMapName>;
  remap: Record<number, { min: number; max: number; bias: number }>;
  onAssign: (biomeIndex: number, name: SatMapName) => void;
  onRemap: (biomeIndex: number, r: { min: number; max: number; bias: number }) => void;
  brightness: number;
  onBrightness: (v: number) => void;
  smooth: number;
  onSmooth: (v: number) => void;
}

const DEFAULT_REMAP = { min: 0, max: 1, bias: 0.5 };

/** Gaea-style per-biome SatMap library: pick the biome to edit, choose a
 *  Library category, click a thumbnail to assign it, then remap its ramp
 *  with min/max range + Bias sliders. */
export default function TexturingPanel(p: TexturingPanelProps): React.ReactElement {
  const [active, setActive] = React.useState(0);
  const [cat, setCat] = React.useState<string>("All");

  const slot = BIOME_SLOTS[active];
  const current = p.assignments[active] ?? slot.defaultName;
  const r = p.remap[active] ?? DEFAULT_REMAP;

  const categories = React.useMemo(() => Object.keys(SATMAP_FAMILIES).sort(), []);
  const names = cat === "All" ? SATMAP_NAMES : SATMAP_FAMILIES[cat] ?? [];

  const emit = (next: { min: number; max: number; bias: number }) => {
    let { min, max, bias } = next;
    // Enforce min ≤ max.
    if (min > max) {
      if (next.min !== r.min) max = min;
      else min = max;
    }
    p.onRemap(active, { min, max, bias });
  };

  const labelStyle: React.CSSProperties = {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: fonts.sans,
    marginBottom: 3,
  };
  const sliderStyle: React.CSSProperties = { width: "100%", accentColor: colors.accent };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Global surface controls (not per-biome) */}
      <div style={{ padding: "10px 12px", borderBottom: `1px solid ${colors.borderMid}` }}>
        <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 8 }}>
          Surface
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={labelStyle}>
            <span>Surface brightness</span>
            <span style={{ color: colors.beige, fontFamily: fonts.mono }}>
              {p.brightness.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0.6}
            max={2.4}
            step={0.01}
            value={p.brightness}
            onChange={(e) => p.onBrightness(Number(e.target.value))}
            style={sliderStyle}
          />
        </div>

        <div>
          <div style={labelStyle}>
            <span>Smoothing</span>
            <span style={{ color: colors.beige, fontFamily: fonts.mono }}>
              {p.smooth.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={p.smooth}
            onChange={(e) => p.onSmooth(Number(e.target.value))}
            style={sliderStyle}
          />
        </div>
      </div>

      {/* Biome selector chips */}
      <div style={{ padding: "10px 12px 6px", borderBottom: `1px solid ${colors.borderMid}` }}>
        <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 6 }}>
          Editing biome
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {BIOME_SLOTS.map((b) => {
            const on = b.index === active;
            return (
              <button
                key={b.index}
                onClick={() => setActive(b.index)}
                title={b.label}
                style={{
                  padding: "4px 8px",
                  fontSize: 11,
                  fontFamily: fonts.sans,
                  borderRadius: 3,
                  cursor: "pointer",
                  background: on ? "rgba(181,106,29,0.20)" : "transparent",
                  border: `1px solid ${on ? colors.accent : colors.borderMid}`,
                  color: on ? colors.accentText : colors.beige,
                }}
              >
                {b.label}
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: colors.beige }}>
          {slot.label} → <span style={{ color: colors.accentText }}>{current}</span>
        </div>
      </div>

      {/* Library category dropdown */}
      <div style={{ padding: "8px 12px 6px", borderBottom: `1px solid ${colors.borderMid}` }}>
        <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 4 }}>Library</div>
        <select
          value={cat}
          onChange={(e) => setCat(e.target.value)}
          style={{
            width: "100%",
            padding: "4px 6px",
            fontSize: 11,
            fontFamily: fonts.sans,
            background: colors.bgBase,
            color: colors.beige,
            border: `1px solid ${colors.borderMid}`,
            borderRadius: 3,
            cursor: "pointer",
          }}
        >
          <option value="All">All ({SATMAP_NAMES.length})</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c} ({SATMAP_FAMILIES[c].length})
            </option>
          ))}
        </select>
      </div>

      {/* Scrollable SatMap gradient-row library (Gaea-style: one strip per row) */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "6px 8px",
          display: "flex",
          flexDirection: "column",
          gap: 3,
          alignContent: "start",
        }}
      >
        {names.map((name) => {
          const selected = name === current;
          const url = satMapUrl(name);
          return (
            <button
              key={name}
              onClick={() => p.onAssign(active, name)}
              title={name}
              style={{
                position: "relative",
                width: "100%",
                height: 22,
                flex: "0 0 auto",
                padding: 0,
                border: `1px solid ${selected ? colors.accent : colors.borderMid}`,
                borderRadius: 3,
                cursor: "pointer",
                overflow: "hidden",
                display: "block",
              }}
            >
              <img
                src={url}
                alt={name}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  display: "block",
                }}
              />
              <span
                style={{
                  position: "absolute",
                  left: 6,
                  top: "50%",
                  transform: "translateY(-50%)",
                  fontSize: 10,
                  lineHeight: "12px",
                  color: "#fff",
                  fontFamily: fonts.mono,
                  textShadow: "0 1px 2px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,0.9)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: "calc(100% - 12px)",
                  pointerEvents: "none",
                }}
              >
                {name}
              </span>
            </button>
          );
        })}
      </div>

      {/* Ramp remap sliders (fixed, bottom) */}
      <div style={{ padding: "10px 12px 12px", borderTop: `1px solid ${colors.borderMid}` }}>
        <div style={{ fontSize: 11, color: colors.textMuted, marginBottom: 8 }}>
          Ramp remap — {slot.label}
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={labelStyle}>
            <span>Range min</span>
            <span style={{ color: colors.beige, fontFamily: fonts.mono }}>{r.min.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={r.min}
            onChange={(e) => emit({ ...r, min: Number(e.target.value) })}
            style={sliderStyle}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          <div style={labelStyle}>
            <span>Range max</span>
            <span style={{ color: colors.beige, fontFamily: fonts.mono }}>{r.max.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={r.max}
            onChange={(e) => emit({ ...r, max: Number(e.target.value) })}
            style={sliderStyle}
          />
        </div>

        <div>
          <div style={labelStyle}>
            <span>Bias {r.bias.toFixed(2)}</span>
            <span style={{ color: colors.beige, fontFamily: fonts.mono }}>
              {r.bias === 0.5 ? "neutral" : r.bias < 0.5 ? "dark" : "bright"}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={r.bias}
            onChange={(e) => emit({ ...r, bias: Number(e.target.value) })}
            style={sliderStyle}
          />
        </div>
      </div>
    </div>
  );
}
