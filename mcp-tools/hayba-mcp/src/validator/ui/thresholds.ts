// Numeric thresholds the UI rules judge against.
//
// Every number here has a source, cited on the line, because "the validator
// says 44px" is only useful if you can find out why 44. They are expressed at
// the blueprint's DESIGN resolution and scaled to the actual design size, so a
// 720p-authored menu is judged by 720p numbers rather than 1080p ones.

import type { Strictness } from '../config.js';
import type { UiPlatform, UiThresholds } from './types.js';

/** The resolution the base numbers are expressed at. */
export const REFERENCE_HEIGHT = 1080;

interface PlatformBase {
  titleSafeFraction: number;
  actionSafeFraction: number;
  minTouchTargetPx: number;
  minInteractiveGapPx: number;
  minFontPx: number;
  comfortableFontPx: number;
}

const PLATFORM_BASE: Record<UiPlatform, PlatformBase> = {
  // Desktop: mouse pointer, ~60cm viewing distance, no broadcast safe area.
  pc: {
    titleSafeFraction: 0.0,
    actionSafeFraction: 0.0,
    // A 24px target is the practical floor for comfortable mouse clicking;
    // WCAG 2.2 AA (2.5.8) sets 24x24 CSS px as the minimum target size.
    minTouchTargetPx: 24,
    minInteractiveGapPx: 8,
    // 12px is the smallest reliably legible UI text on desktop; below that,
    // hinting breaks down at 100% scaling.
    minFontPx: 12,
    comfortableFontPx: 16,
  },
  // Console on a TV: ~3m viewing distance, overscan still exists on some sets.
  console: {
    // Title safe = inner 90% (5% per edge); action safe = inner 93% (3.5% per
    // edge). These are the long-standing broadcast/console cert numbers, and
    // both Xbox and PlayStation TRC/XR checklists still use them.
    titleSafeFraction: 0.05,
    actionSafeFraction: 0.035,
    // Focus-driven, not pointer-driven, but a target still has to be visible
    // and distinguishable from 3m.
    minTouchTargetPx: 40,
    minInteractiveGapPx: 12,
    // The widely used console floor is 28px at 1080p for body copy; smaller
    // text is unreadable at couch distance.
    minFontPx: 28,
    comfortableFontPx: 32,
  },
  // Handheld (Steam Deck / Switch): small screen, close, often touch as well.
  handheld: {
    titleSafeFraction: 0.02,
    actionSafeFraction: 0.015,
    minTouchTargetPx: 40,
    minInteractiveGapPx: 8,
    // Steam Deck's own UI guidance lands around 20px at 800p; scaled to the
    // 1080p reference that is ~24.
    minFontPx: 20,
    comfortableFontPx: 24,
  },
  // Touch: finger, not pointer.
  mobile: {
    // Notches and gesture bars, not overscan.
    titleSafeFraction: 0.03,
    actionSafeFraction: 0.02,
    // Apple HIG says 44x44pt; Material says 48x48dp. 44 is the lower of the two
    // and therefore the one that flags only genuine violations.
    minTouchTargetPx: 44,
    minInteractiveGapPx: 8,
    minFontPx: 16,
    comfortableFontPx: 18,
  },
};

/** Strictness scales the discretionary numbers. Hard floors (safe areas, touch
 *  targets) do NOT get more lenient in relaxed mode — they are either met or
 *  not; relaxed mode drops the rules that report them at low severity instead. */
interface StrictnessTuning {
  spacingGridPx: number;
  localizationHeadroom: number;
  textFillWarnRatio: number;
  minContrastRatio: number;
  maxNestingDepth: number;
  maxWidgetCount: number;
}

const STRICTNESS_TUNING: Record<Strictness, StrictnessTuning> = {
  relaxed: {
    spacingGridPx: 4,
    // Only flag labels with no room for growth at all.
    localizationHeadroom: 1.0,
    textFillWarnRatio: 0.98,
    // WCAG AA for large text.
    minContrastRatio: 3.0,
    maxNestingDepth: 16,
    maxWidgetCount: 500,
  },
  standard: {
    spacingGridPx: 4,
    // English -> German/Russian commonly grows 30% for short UI strings.
    localizationHeadroom: 1.3,
    textFillWarnRatio: 0.9,
    // WCAG 2.1 AA for body text.
    minContrastRatio: 4.5,
    maxNestingDepth: 12,
    maxWidgetCount: 300,
  },
  strict: {
    // 8pt grid: the spacing system most UI kits standardise on.
    spacingGridPx: 8,
    // Short strings (single words on buttons) can grow far more than 30%;
    // 1.5 is the figure Microsoft's localisation guidance gives for strings
    // under 10 characters.
    localizationHeadroom: 1.5,
    textFillWarnRatio: 0.8,
    // WCAG AAA.
    minContrastRatio: 7.0,
    maxNestingDepth: 8,
    maxWidgetCount: 200,
  },
};

/** Resolve thresholds for a platform + strictness at a given design height.
 *  Pixel numbers scale with the design resolution; fractions do not. */
export function resolveThresholds(
  platform: UiPlatform,
  strictness: Strictness,
  designHeight: number = REFERENCE_HEIGHT,
): UiThresholds {
  const base = PLATFORM_BASE[platform];
  const tuning = STRICTNESS_TUNING[strictness];

  // A menu authored at 720p has smaller pixel numbers for the same physical
  // size; judging it with 1080p pixels would flag every font in the file.
  const scale = designHeight > 0 ? designHeight / REFERENCE_HEIGHT : 1;
  const px = (v: number) => Math.round(v * scale);

  return {
    titleSafeFraction: base.titleSafeFraction,
    actionSafeFraction: base.actionSafeFraction,
    minTouchTargetPx: px(base.minTouchTargetPx),
    minInteractiveGapPx: px(base.minInteractiveGapPx),
    minFontPx: px(base.minFontPx),
    comfortableFontPx: px(base.comfortableFontPx),
    spacingGridPx: tuning.spacingGridPx,
    localizationHeadroom: tuning.localizationHeadroom,
    textFillWarnRatio: tuning.textFillWarnRatio,
    minContrastRatio: tuning.minContrastRatio,
    maxNestingDepth: tuning.maxNestingDepth,
    maxWidgetCount: tuning.maxWidgetCount,
  };
}

/** Relative luminance per WCAG 2.1, from linear 0-1 RGB.
 *  UMG colours are already linear, so the sRGB companding step the WCAG
 *  formula starts with has effectively been done for us. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

/** WCAG contrast ratio between two linear colours; 1.0 (identical) to 21.0. */
export function contrastRatio(
  a: [number, number, number, number],
  b: [number, number, number, number],
): number {
  const la = relativeLuminance(a[0], a[1], a[2]);
  const lb = relativeLuminance(b[0], b[1], b[2]);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
