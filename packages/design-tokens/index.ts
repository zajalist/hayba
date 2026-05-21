// Hayba design tokens — pulled directly from hayba.vercel.app via DevTools
// inspection so the Explorer chrome matches the marketing site exactly.
//
// Editorial discipline (generous whitespace, tight headlines, accent-only
// emphasis) comes from the Gaea reference; the actual palette + typography
// stack are the marketing site's verbatim.

export const colors = {
  bgDeep:         "#1b1e24",
  bgBase:         "#22262e",
  bgPanel:        "#2a2e36",
  bgRaised:       "#303540",
  bgElevated:     "#353a45",
  bgPanelHeader:  "#1d2129",
  /** Row hover background — barely-perceptible lighten. */
  bgRowHover:     "#303540",
  /** Section-band background — the thin header strip with chevron + label. */
  bgSectionBand:  "#1d2129",
  /** Hayba accent — matches the logo exactly (#B56A1D). */
  accent:         "#B56A1D",
  accentHover:    "#d27a25",
  accentText:     "#B56A1D",
  accentDim:      "#B56A1D22",
  accentGlow:     "#B56A1D55",
  textPrimary:    "#e5e8eb",
  textSecondary:  "#a8aeb8",
  textMuted:      "#6b7280",
  borderMid:      "#2f343d",
  borderSoft:     "#3d434e",
  /** Subtle 1px separator — barely visible. */
  borderSubtle:   "#2a2e36",
  /** Top-bar background — one notch darker than bgDeep. */
  bgTopBar:       "#16191f",
  /** Status-bar background — same family as bgPanelHeader. */
  bgStatusBar:    "#1d2129",
  /** Right-panel category strip background. */
  bgCategoryStrip:"#1d2129",
  /** Primary beige foreground (action labels, mode names). */
  beige:          "#DED4C3",
  /** Muted beige — property-row labels. */
  beigeMuted:     "#a8aeb8",
  /** 1px property-row separator (lighter than borderMid). */
  rule:           "#2a2e36",
  // Optional reserved second tone — used only on a few legacy paths.
  secondary:      "#6a9fdc",
  secondaryHover: "#8ab5e6",
  // Semantic aliases (re-export by intent).
  /** Row hover background. */
  rowHover:       "#303540",
  /** Label text color. */
  textLabel:      "#a8aeb8",
  /** Value text color. */
  textValue:      "#DED4C3",
} as const;

export const fonts = {
  /** UI stack — Segoe UI primary (matches the marketing site verbatim). */
  sans:  '"Segoe UI", "Noto Sans", system-ui, sans-serif',
  /** Reserved for IPA samples. */
  ipa:   '"Charis SIL", "Noto Sans", "Lucida Sans Unicode", sans-serif',
  /** Mono — Consolas primary (matches marketing site). */
  mono:  '"Consolas", "Noto Sans Mono", ui-monospace, monospace',
} as const;

export const radii = {
  /** Tight Gaea/UE5-style — surfaces feel docked, not floating. */
  xs: "2px",   // chips + small buttons
  sm: "3px",   // modals + small floating panels
  md: "4px",   // larger surfaces
  lg: "8px",   // pill-style affordances
} as const;

export const shadows = {
  sm: "0 1px 2px rgba(0, 0, 0, 0.35)",
  md: "0 4px 12px rgba(0, 0, 0, 0.45)",
} as const;

/** UE5-aligned spacing + sizing primitives for the Details panel. */
export const space = {
  rowHeight:    28,
  rowHeightTall:46,
  sectionBandH: 24,
  rowPadX:      8,
} as const;

/** Typography sizes tuned to UE5's compact density. */
export const fontSize = {
  label:   11,
  value:   11,
  section: 10,
} as const;

export const easings = {
  out:    "cubic-bezier(0.16, 1, 0.3, 1)",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;
