// Hayba design tokens — single source of truth for color + typography
// across the marketing site (hayba.com) and the Hayba Explorer desktop app.
//
// Keep values in sync with packages/hayba/src/tokens.css (marketing site).

export const colors = {
  bgDeep:         "#1b1e24",
  bgBase:         "#22262e",
  bgPanel:        "#2a2e36",
  accent:         "#B56A1D",
  accentHover:    "#d77f24",
  secondary:      "#6a9fdc",
  secondaryHover: "#8ab5e6",
  textPrimary:    "#e5e8eb",
  textSecondary:  "#a8aeb8",
  textMuted:      "#6b7280",
  borderMid:      "#2f343d",
  borderSoft:     "#3d434e",
} as const;

export const fonts = {
  sans:  '"Noto Sans", system-ui, sans-serif',
  serif: '"Charis SIL", Georgia, serif',
  mono:  '"Noto Sans Mono", ui-monospace, monospace',
} as const;

export const radii = {
  sm: "4px",
  md: "8px",
  lg: "12px",
} as const;

export const shadows = {
  sm: "0 1px 2px rgba(0, 0, 0, 0.35)",
  md: "0 4px 12px rgba(0, 0, 0, 0.45)",
} as const;
