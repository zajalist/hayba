import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import { SATMAP_NAMES, BIOME_SLOTS, satMapUrl, type SatMapName } from "../../viewport/satmap-loader";

export interface TexturingPanelProps {
  assignments: Record<number, SatMapName>;
  onAssign: (biomeIndex: number, name: SatMapName) => void;
}

/** Gaea-style per-biome SatMap library: pick the biome to edit, then
 *  click a thumbnail from the scrollable grid to assign it. */
export default function TexturingPanel(p: TexturingPanelProps): React.ReactElement {
  const [active, setActive] = React.useState(0);
  const slot = BIOME_SLOTS[active];
  const current = p.assignments[active] ?? slot.defaultName;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
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

      {/* Scrollable SatMap thumbnail grid (Gaea-style) */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 10,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(70px, 1fr))",
          gap: 8,
          alignContent: "start",
        }}
      >
        {SATMAP_NAMES.map((name) => {
          const selected = name === current;
          const url = satMapUrl(name);
          return (
            <button
              key={name}
              onClick={() => p.onAssign(active, name)}
              title={name}
              style={{
                padding: 0,
                border: `2px solid ${selected ? colors.accent : "transparent"}`,
                borderRadius: 4,
                background: colors.bgBase,
                cursor: "pointer",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <img
                src={url}
                alt={name}
                style={{ width: "100%", height: 72, objectFit: "cover", display: "block" }}
              />
              <span
                style={{
                  fontSize: 9,
                  lineHeight: "12px",
                  color: selected ? colors.accentText : colors.textMuted,
                  fontFamily: fonts.mono,
                  padding: "3px 2px",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
