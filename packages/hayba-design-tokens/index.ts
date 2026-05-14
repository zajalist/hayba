// Hayba design tokens — single source of truth for color + typography
// across the marketing site (hayba.com), the workbench/dashboard, and the
// Hayba Explorer desktop app.
//
// Reference: the marketing-restyle brief explicitly pins the stack as
// Segoe UI / Noto Sans on slate (#1b1e24) with #B56A1D as the filled
// accent and #e8821c as the text accent for uppercase tracked labels.
// Charis SIL is reserved for IPA samples only — do not use as a heading
// serif.

export const colors = {
  // Editorial-dark: tightened toward Gaea's #1a1a1a feel while keeping a
  // subtle slate-cool cast that ties to the marketing-restyle palette.
  bgDeep:         "#141619",
  bgBase:         "#1b1f25",
  bgPanel:        "#252a32",
  /** Slightly darker tone for panel HEADERS — UE-editor tab caps. */
  bgPanelHeader:  "#1d2129",
  /** Filled accent — matches the Hayba logo exactly (#B56A1D). Used for
   * buttons, swatches, dividers, active selection, and uppercase labels. */
  accent:         "#B56A1D",
  accentHover:    "#d27a25",
  /** Same as accent — kept as a separate token so future themes can split
   * the two if needed, but in v1 they are identical. */
  accentText:     "#B56A1D",
  secondary:      "#6a9fdc",
  secondaryHover: "#8ab5e6",
  textPrimary:    "#e5e8eb",
  textSecondary:  "#a8aeb8",
  textMuted:      "#6b7280",
  borderMid:      "#2f343d",
  borderSoft:     "#3d434e",
} as const;

export const fonts = {
  /** UI stack — Inter is the editorial-dark default (matches the Gaea look);
   * falls back to system-ui then Noto Sans for the rare offline case. */
  sans:  '"Inter", "Inter Variable", system-ui, "Segoe UI", "Noto Sans", sans-serif',
  /** Reserved for IPA samples — phonology demos, conlang display. */
  ipa:   '"Charis SIL", Georgia, serif',
  /** Mono — JetBrains Mono first (matches numeric tables in pro tools). */
  mono:  '"JetBrains Mono", "Consolas", "Noto Sans Mono", ui-monospace, monospace',
} as const;

export const radii = {
  /** Buttons, tool icons, small chips. */
  xs: "2px",
  /** Panels, modals, palette containers. UE editor uses ~3px. */
  sm: "3px",
  md: "4px",
  lg: "6px",
} as const;

export const shadows = {
  sm: "0 1px 2px rgba(0, 0, 0, 0.35)",
  md: "0 4px 12px rgba(0, 0, 0, 0.45)",
} as const;
