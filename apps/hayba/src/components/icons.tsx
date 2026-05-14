import React from "react";

// Hayba Explorer iconography — visual language ported from the UE plugin
// resources at HaybaMCPToolkit/Resources/. Reference style:
//   - 64x64 viewBox
//   - stroke-width 2.5, round caps + joins
//   - filled body (slate-blue depth OR cream highlight)
//   - Hayba accent (#B56A1D) as the primary stroke
//   - spot colors for emphasis: #88C0A0 green, #FFD060 yellow, #C880A0 rose
//
// Each icon is opinionated about its palette — they're crafted to match
// the UE plugin set, not parameterised line art.

export interface IconProps {
  size?: number;
  className?: string;
}

// Shared palette — mirrors the UE plugin icon set.
const SLATE_DEEP   = "#1F2A3D";
const SLATE_MID    = "#3F4F70";
const SLATE_LIGHT  = "#5A6F9F";
const CREAM        = "#DED4C3";
const ACCENT       = "#B56A1D";
const ACCENT_TEXT  = "#E8821C";
const SAGE         = "#88C0A0";
const SAND         = "#E0B080";
const ROSE         = "#C880A0";
const SUN          = "#FFD060";

function frame(props: IconProps, paths: React.ReactNode) {
  const { size = 18, className } = props;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      style={{ flexShrink: 0, display: "block" }}
    >
      {paths}
    </svg>
  );
}

/** Two dice — the "roll a new seed" affordance. */
export function IconReroll(props: IconProps) {
  return frame(props, (
    <>
      <rect x="6" y="26" width="28" height="28" rx="3" fill={SLATE_DEEP} stroke={ACCENT} strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx="14" cy="34" r="2.4" fill={ACCENT_TEXT} />
      <circle cx="26" cy="46" r="2.4" fill={ACCENT_TEXT} />
      <rect x="30" y="10" width="28" height="28" rx="3" fill={CREAM} stroke={ACCENT} strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx="38" cy="18" r="2.4" fill={ACCENT} />
      <circle cx="50" cy="30" r="2.4" fill={ACCENT} />
      <circle cx="44" cy="24" r="2.4" fill={ACCENT} />
    </>
  ));
}

/** Trash can with lid — clear continents. */
export function IconClear(props: IconProps) {
  return frame(props, (
    <>
      <path d="M14 22 L50 22 L46 56 L18 56 Z" fill={SLATE_DEEP} stroke={ACCENT} strokeWidth="2.5" strokeLinejoin="round" />
      <line x1="8" y1="16" x2="56" y2="16" stroke={ACCENT} strokeWidth="3" strokeLinecap="round" />
      <path d="M24 10 L24 14 L40 14 L40 10" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="26" y1="30" x2="26" y2="48" stroke={ACCENT_TEXT} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="38" y1="30" x2="38" y2="48" stroke={ACCENT_TEXT} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ));
}

/** Spark — "bake" mark. Echoes the sun-rays atop the Hayba logo vessel. */
export function IconBake(props: IconProps) {
  return frame(props, (
    <>
      <path
        d="M32 4 L37.3 25 L58 27.5 L42 41 L46.6 60 L32 49.5 L17.4 60 L22 41 L6 27.5 L26.7 25 Z"
        fill={CREAM}
        stroke={ACCENT}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <circle cx="32" cy="32" r="4" fill={ACCENT} />
    </>
  ));
}

/** Flat brush — Continents section glyph. */
export function IconBrush(props: IconProps) {
  return frame(props, (
    <>
      {/* Bristle splay */}
      <path d="M10 54 L24 36 L36 48 L22 56 Z" fill={CREAM} stroke={ACCENT} strokeWidth="2.5" strokeLinejoin="round" />
      {/* Handle */}
      <path d="M24 36 L48 12 L56 20 L36 48 Z" fill={SLATE_DEEP} stroke={ACCENT} strokeWidth="2.5" strokeLinejoin="round" />
      {/* Ferrule */}
      <line x1="28" y1="40" x2="40" y2="52" stroke={ACCENT_TEXT} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ));
}

/** Icosphere globe — Detail section glyph. */
export function IconSphere(props: IconProps) {
  return frame(props, (
    <>
      <circle cx="32" cy="32" r="24" fill={SLATE_DEEP} stroke={ACCENT} strokeWidth="2.5" />
      <ellipse cx="32" cy="32" rx="24" ry="9" fill="none" stroke={ACCENT} strokeWidth="2" />
      <line x1="32" y1="8" x2="32" y2="56" stroke={ACCENT} strokeWidth="2" />
      <circle cx="32" cy="32" r="3" fill={ACCENT_TEXT} />
    </>
  ));
}

/** Globe with a pink seam — Tectonic-preset glyph. */
export function IconPlates(props: IconProps) {
  return frame(props, (
    <>
      <circle cx="32" cy="32" r="24" fill={SLATE_DEEP} stroke={ACCENT} strokeWidth="2.5" />
      <path
        d="M9 28 Q20 38 32 28 T55 34"
        fill="none"
        stroke={ROSE}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="32" r="2" fill={ROSE} />
      <circle cx="44" cy="31" r="2" fill={ROSE} />
    </>
  ));
}

/** Hash card — Seed / Determinism glyph. */
export function IconSeed(props: IconProps) {
  return frame(props, (
    <>
      <rect x="8" y="8" width="48" height="48" rx="3" fill={CREAM} stroke={ACCENT} strokeWidth="2.5" strokeLinejoin="round" />
      <line x1="24" y1="10" x2="24" y2="54" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="40" y1="10" x2="40" y2="54" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="10" y1="24" x2="54" y2="24" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" />
      <line x1="10" y1="40" x2="54" y2="40" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" />
    </>
  ));
}

// Re-exported palette so callers (e.g. the bake button) can match the icon's
// inks when they need to flip context (dark icon on accent surface).
export const ICON_PALETTE = {
  slateDeep: SLATE_DEEP,
  slateMid:  SLATE_MID,
  slateLight: SLATE_LIGHT,
  cream:     CREAM,
  accent:    ACCENT,
  accentText: ACCENT_TEXT,
  sage:      SAGE,
  sand:      SAND,
  rose:      ROSE,
  sun:       SUN,
};
