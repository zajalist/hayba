// Types for the UI validation pass.
//
// The snapshot is produced by the UE command `ui_layout_snapshot`, which does
// the one job that cannot be done here: a real Slate prepass plus font
// measurement. Everything in this directory is pure judgement over that data,
// which is why the rules are unit-testable and can be extended without
// rebuilding the plugin.

import type { RuleCategory, Strictness } from '../config.js';

/** Text facts for a widget that renders text. */
export interface UiTextInfo {
  text?: string;
  font_size?: number;
  typeface?: string;
  font_object?: string;
  /** True when the font asset is a UFontFace rather than a composite UFont.
   *  Slate renders a raw font face as its glyph-preview tiles, not as text. */
  font_is_font_face?: boolean;
  auto_wrap?: boolean;
  color?: [number, number, number, number];
  /** Exact rendered width of `text` in this font, in px. */
  measured_width?: number;
  measured_height?: number;
  /** Width the widget's laid-out box gives the text, in px. */
  available_width?: number;
  overflows?: boolean;
  /** Characters of `text` that fit, kerning included. */
  chars_that_fit?: number;
  /** Characters of typical mixed-case prose that fit in the box. */
  typical_chars_that_fit?: number;
  /** Characters that fit if every glyph were the font's widest. */
  worst_case_chars_that_fit?: number;
}

export interface UiBrushInfo {
  has_resource?: boolean;
  resource?: string;
  tint?: [number, number, number, number];
  image_size_x?: number;
  image_size_y?: number;
}

export interface UiAnchors {
  min_x: number;
  min_y: number;
  max_x: number;
  max_y: number;
}

/** One widget as reported by ui_layout_snapshot. */
export interface UiWidget {
  name: string;
  class: string;
  parent: string;
  slot_class: string;
  is_panel: boolean;
  is_variable: boolean;
  visibility: string;
  render_opacity: number;
  is_enabled: boolean;
  is_interactive: boolean;
  is_focusable: boolean;

  /** Design-space rect. Absent/false `laid_out` means Slate gave this widget no
   *  box (collapsed, or an inactive switcher slot) — geometry rules must skip
   *  it rather than treat it as a zero-size violation. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  depth?: number;
  laid_out: boolean;

  anchors?: UiAnchors;
  z_order?: number;
  auto_size?: boolean;
  child_count?: number;

  text_info?: UiTextInfo;
  brush_info?: UiBrushInfo;
}

export interface UiSnapshot {
  widget_blueprint_path: string;
  screen_width: number;
  screen_height: number;
  /** False when the blueprint could not be instantiated for layout. Every
   *  geometry-dependent rule is SKIPPED in that case and reported as skipped,
   *  never as passing. */
  layout_resolved: boolean;
  layout_error?: string;
  widget_count: number;
  widgets: UiWidget[];
}

export type UiSeverity = 'error' | 'warning' | 'info';

/** A single problem found in a widget blueprint. */
export interface UiFinding {
  ruleId: string;
  category: RuleCategory;
  severity: UiSeverity;
  /** Widget the finding is about, when it is about one. */
  widget?: string;
  message: string;
  hint: string;
  /** Numbers behind the message, so a caller can re-check the maths. */
  data?: Record<string, unknown>;
}

/** Which platform's conventions to judge against. Safe areas, minimum touch
 *  targets and legible font sizes differ enough between a TV at 3m and a phone
 *  at 30cm that one set of numbers would be wrong for both. */
export const UI_PLATFORMS = ['pc', 'console', 'handheld', 'mobile'] as const;
export type UiPlatform = (typeof UI_PLATFORMS)[number];

export interface UiRuleContext {
  snapshot: UiSnapshot;
  platform: UiPlatform;
  strictness: Strictness;
  /** Resolved numeric thresholds for this platform + strictness. */
  thresholds: UiThresholds;
  /** Widgets keyed by name, for parent/child lookups. */
  byName: Map<string, UiWidget>;
  /** Direct children of each widget, in tree order. */
  childrenOf: Map<string, UiWidget[]>;
}

export interface UiThresholds {
  /** Fraction of each screen edge that is unsafe for critical content. */
  titleSafeFraction: number;
  /** Fraction of each screen edge that is unsafe for anything at all. */
  actionSafeFraction: number;
  /** Minimum px for the short side of an interactive widget. */
  minTouchTargetPx: number;
  /** Minimum px gap between two interactive widgets. */
  minInteractiveGapPx: number;
  /** Minimum legible font size in px at the design resolution. */
  minFontPx: number;
  /** Font size below which text is flagged only in strict mode. */
  comfortableFontPx: number;
  /** Spacing grid that positions and sizes should land on. */
  spacingGridPx: number;
  /** Multiplier of headroom a label needs for localisation growth. */
  localizationHeadroom: number;
  /** Fraction of the box at which text is "close enough to overflowing". */
  textFillWarnRatio: number;
  /** Minimum contrast ratio for body text against its background. */
  minContrastRatio: number;
  /** Widget-tree depth beyond which nesting is flagged. */
  maxNestingDepth: number;
  /** Widget count beyond which the blueprint is flagged as heavy. */
  maxWidgetCount: number;
}

/** One rule. `evaluate` returns every finding it produces for the snapshot. */
export interface UiRule {
  id: string;
  category: RuleCategory;
  severity: UiSeverity;
  /** Lowest strictness at which this rule fires. */
  minStrictness: Strictness;
  /** One-line summary shown in the settings UI. */
  title: string;
  /** True when the rule needs resolved geometry — skipped, and reported as
   *  skipped, when the layout could not be computed. */
  needsLayout: boolean;
  evaluate: (ctx: UiRuleContext) => UiFinding[];
}

export interface UiValidationResult {
  widget_blueprint_path: string;
  platform: UiPlatform;
  strictness: Strictness;
  layout_resolved: boolean;
  layout_error?: string;
  findings: UiFinding[];
  /** Rules that ran, were disabled, or were skipped for want of geometry.
   *  Reported explicitly so "no findings" is never confused with "no checks". */
  rules_evaluated: number;
  rules_skipped_no_layout: string[];
  rules_disabled: string[];
  rules_below_strictness: string[];
  counts: Record<UiSeverity, number>;
}
