import React from "react";
import { colors, fonts } from "@hayba/design-tokens";
import { ICON_URLS } from "./icons";

export type PanelCategory = "compose" | "texturing" | "climate" | "boundaries" | "densities" | "simulate" | "settings";

export interface CategoryStripProps {
  active: PanelCategory;
  /** Which categories are currently selectable (others render disabled). */
  enabled: Record<PanelCategory, boolean>;
  /** Optional tooltips shown on disabled categories ("Bake the planet to edit boundaries"). */
  disabledReason?: Partial<Record<PanelCategory, string>>;
  onPick: (cat: PanelCategory) => void;
}

// Distinct inline SVG icons for Compose / Texturing / Climate Lab. The
// existing asset library only ships `IconCategoryCompose.svg` (a globe),
// which all three categories used to share. To avoid creating new PNG
// assets we render mountain (Compose), brush (Texturing), and cloud+sun
// (Climate Lab) as inline 18x18 strokes that match the rest of the strip.
type InlineKind = "compose" | "texturing" | "climate";

const INLINE_SVGS: Record<InlineKind, React.ReactNode> = {
  // Mountain — Compose (terrain authoring).
  compose: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 19 L9 9 L13 14 L16 10 L21 19 Z" />
      <circle cx="16.5" cy="6.5" r="1.4" />
    </svg>
  ),
  // Brush / palette — Texturing (per-biome SatMap library).
  texturing: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17 L13 7 L17 11 L7 21 H3 Z" />
      <path d="M13 7 L17 3 L21 7 L17 11" />
      <circle cx="6.5" cy="17.5" r="0.8" fill="currentColor" />
    </svg>
  ),
  // Cloud + sun — Climate Lab (per-band climate tuning).
  climate: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 3.5 V2 M8 14 V12.5 M3.5 8 H2 M12.5 8 H14 M4.8 4.8 L3.8 3.8 M12.2 4.8 L13.2 3.8" />
      <path d="M9 17 a4 4 0 0 1 4 -4 a4.5 4.5 0 0 1 8.5 1.5 A3 3 0 0 1 20 20 H9 a3 3 0 0 1 0 -3 Z" />
    </svg>
  ),
};

interface Item {
  id: PanelCategory;
  label: string;
  /** External SVG-URL icon (existing asset library). */
  icon?: string;
  /** Inline SVG kind (used where shared-asset icons would collide). */
  inline?: InlineKind;
  bottom?: boolean;
}

const ITEMS: Item[] = [
  { id: "compose",    label: "Compose",    inline: "compose" },
  { id: "texturing",  label: "Texture",    inline: "texturing" },
  { id: "climate",    label: "Climate",    inline: "climate" },
  { id: "boundaries", label: "Bounds",     icon: ICON_URLS.categoryBoundaries },
  { id: "densities",  label: "Density",    icon: ICON_URLS.categoryDensities },
  { id: "simulate",   label: "Simulate",   icon: ICON_URLS.categorySimulate },
  { id: "settings",   label: "Settings",   icon: ICON_URLS.categorySettings, bottom: true },
];

export default function CategoryStrip({ active, enabled, disabledReason, onPick }: CategoryStripProps) {
  const top    = ITEMS.filter((i) => !i.bottom);
  const bottom = ITEMS.filter((i) =>  i.bottom);

  const renderButton = (item: Item) => {
    const isActive  = item.id === active;
    const isEnabled = enabled[item.id];
    const tooltip   = !isEnabled ? disabledReason?.[item.id] ?? "" : item.label;
    return (
      <button
        key={item.id}
        type="button"
        title={tooltip}
        disabled={!isEnabled}
        onClick={() => isEnabled && onPick(item.id)}
        onMouseEnter={(e) => { if (isEnabled && !isActive) (e.currentTarget.style.background = colors.bgRowHover); }}
        onMouseLeave={(e) => { if (!isActive) (e.currentTarget.style.background = "transparent"); }}
        style={{
          // Slightly taller to fit icon + label without crowding.
          height: 52,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 3,
          // accentDim (#B56A1D22 = ~13% alpha) was too faint — the active
          // chip read as nearly identical to inactive at typical viewing
          // distance. Bumping the active bg to #B56A1D40 (~25%) makes the
          // selection unambiguous without losing the muted-amber tone.
          background: isActive ? "rgba(181, 106, 29, 0.22)" : "transparent",
          border: "none",
          borderLeft: `3px solid ${isActive ? colors.accent : "transparent"}`,
          // Subtle inner glow on the active chip so it reads as a *pressed*
          // tab, not just a coloured rectangle.
          boxShadow: isActive ? "inset 1px 0 0 rgba(181, 106, 29, 0.45)" : "none",
          color: isActive ? colors.textValue : colors.textSecondary,
          opacity: isEnabled ? 1 : 0.4,
          cursor: isEnabled ? "pointer" : "not-allowed",
          padding: "4px 0 3px",
          fontFamily: fonts.sans,
        }}
      >
        {item.inline ? (
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              width: 18,
              height: 18,
              color: isActive ? colors.beige : colors.textSecondary,
              opacity: isActive ? 1 : 0.85,
            }}
          >
            {INLINE_SVGS[item.inline]}
          </span>
        ) : (
          <img
            src={item.icon}
            alt=""
            width={18}
            height={18}
            style={{ filter: "brightness(0) invert(1)", opacity: isActive ? 1 : 0.75 }}
          />
        )}
        <span
          style={{
            fontSize: 9,
            lineHeight: 1,
            letterSpacing: "0.02em",
            color: isActive ? colors.beige : colors.textSecondary,
            opacity: isActive ? 0.95 : 0.7,
            whiteSpace: "nowrap",
          }}
        >
          {item.label}
        </span>
      </button>
    );
  };

  return (
    <div style={{
      // Widened from 44 → 64 to fit icon + 9px label without truncation.
      width: 64,
      background: colors.bgCategoryStrip,
      borderRight: `1px solid ${colors.borderMid}`,
      display: "flex",
      flexDirection: "column",
      paddingTop: 6,
    }}>
      {top.map(renderButton)}
      <div style={{ flex: 1 }} />
      {bottom.map(renderButton)}
    </div>
  );
}
