// Hayba design tokens — pulled directly from hayba.vercel.app via DevTools
// inspection so the Explorer chrome matches the marketing site exactly.
//
// Editorial discipline (generous whitespace, tight headlines, accent-only
// emphasis) comes from the Gaea reference; the actual palette + typography
// stack are the marketing site's verbatim.

export const colors = {
  // UE5-aligned panel palette — tuned to match Unreal Engine 5.7's Details
  // panel (dark band header + flat row body, amber accent).
  bgDeep:         "#171717",
  bgBase:         "#1e1e1e",
  bgPanel:        "#1e1e1e",
  bgRaised:       "#252525",
  bgElevated:     "#2a2a2a",
  bgPanelHeader:  "#1a1a1a",
  /** Row hover background — barely-perceptible lighten. */
  bgRowHover:     "#303030",
  /** Section-band background — the thin header strip with chevron + label. */
  bgSectionBand:  "#2a2a2a",
  /** UE5 amber accent — used for selected category + primary actions only. */
  accent:         "#ff8c00",
  accentHover:    "#ffa128",
  accentText:     "#ff8c00",
  accentDim:      "#ff8c0022",
  accentGlow:     "#ff8c0055",
  textPrimary:    "#ffffff",
  textSecondary:  "#c8c8c8",
  textMuted:      "#7a7a7a",
  borderMid:      "#2a2a2a",
  borderSoft:     "#333333",
  /** Subtle 1px separator — barely visible. */
  borderSubtle:   "#2a2a2a",
  /** Top-bar background. */
  bgTopBar:       "#141414",
  /** Status-bar background. */
  bgStatusBar:    "#1a1a1a",
  /** Right-panel category strip background. */
  bgCategoryStrip:"#1a1a1a",
  /** Primary foreground — row values (white). */
  beige:          "#ffffff",
  /** Muted label color — row labels. */
  beigeMuted:     "#c8c8c8",
  /** Property-row separator. */
  rule:           "#2a2a2a",
  // Reserved second tone — used only on a few legacy paths.
  secondary:      "#6a9fdc",
  secondaryHover: "#8ab5e6",
  // Semantic UE5 aliases (re-export by intent).
  /** Row hover background. */
  rowHover:       "#303030",
  /** Label text color. */
  textLabel:      "#c8c8c8",
  /** Value text color. */
  textValue:      "#ffffff",
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
