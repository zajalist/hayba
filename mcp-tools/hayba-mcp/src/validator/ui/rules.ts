// The UI rule catalogue.
//
// Each rule is a pure function of the snapshot, so every one of them is
// unit-testable and none of them needs a live editor to exercise. Rules that
// depend on resolved geometry declare `needsLayout` and are SKIPPED (and
// reported as skipped) when the blueprint could not be laid out — a rule that
// silently passes because it had no data is worse than no rule.
//
// Adding a rule: append an entry here. Nothing else needs touching — the
// runner, the settings surface and the strictness gate all read this array.

import type { UiFinding, UiRule, UiRuleContext, UiWidget } from './types.js';
import { contrastRatio } from './thresholds.js';

// ── helpers ─────────────────────────────────────────────────────────────────

const round = (v: number) => Math.round(v * 100) / 100;

/** Widgets Slate actually gave a box to. */
function laidOut(ctx: UiRuleContext): UiWidget[] {
  return ctx.snapshot.widgets.filter((w) => w.laid_out && w.width !== undefined && w.height !== undefined);
}

function rect(w: UiWidget): { x: number; y: number; w: number; h: number } {
  return { x: w.x ?? 0, y: w.y ?? 0, w: w.width ?? 0, h: w.height ?? 0 };
}

function overlapArea(a: UiWidget, b: UiWidget): number {
  const ra = rect(a);
  const rb = rect(b);
  const ox = Math.min(ra.x + ra.w, rb.x + rb.w) - Math.max(ra.x, rb.x);
  const oy = Math.min(ra.y + ra.h, rb.y + rb.h) - Math.max(ra.y, rb.y);
  if (ox <= 0 || oy <= 0) return 0;
  return ox * oy;
}

/** True when `ancestor` is above `w` in the tree. */
function isAncestor(ctx: UiRuleContext, ancestor: string, w: UiWidget): boolean {
  let current: UiWidget | undefined = w;
  const seen = new Set<string>();
  while (current && current.parent) {
    if (seen.has(current.name)) return false; // defensive: malformed snapshot
    seen.add(current.name);
    if (current.parent === ancestor) return true;
    current = ctx.byName.get(current.parent);
  }
  return false;
}

/** Widgets that are siblings (same parent) and both laid out. */
function siblingPairs(ctx: UiRuleContext, filter: (w: UiWidget) => boolean): Array<[UiWidget, UiWidget]> {
  const pairs: Array<[UiWidget, UiWidget]> = [];
  for (const [, children] of ctx.childrenOf) {
    const eligible = children.filter((c) => c.laid_out && filter(c));
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        pairs.push([eligible[i]!, eligible[j]!]);
      }
    }
  }
  return pairs;
}

/** Nearest ancestor that paints a solid background, for contrast checks. */
function backgroundColorOf(ctx: UiRuleContext, w: UiWidget): [number, number, number, number] | null {
  let current = ctx.byName.get(w.parent);
  let guard = 0;
  while (current && guard++ < 64) {
    const tint = current.brush_info?.tint;
    // Only an opaque fill is a defensible "background" to measure against.
    // A translucent panel sits on top of something unknown, and guessing would
    // produce a contrast number that is precise and wrong.
    if (tint && tint[3] >= 0.95) return tint;
    current = ctx.byName.get(current.parent);
  }
  return null;
}

function isTextWidget(w: UiWidget): boolean {
  return w.text_info !== undefined;
}

const PLACEHOLDER_TEXT = [
  'text block',
  'textblock',
  'lorem ipsum',
  'lorem',
  'placeholder',
  'todo',
  'tbd',
  'sample text',
  'your text here',
  'button',
  'xxx',
  'asdf',
  'test',
];

/** UMG's auto-generated names look like "TextBlock_42" / "Button_0". */
const DEFAULT_NAME_RE = /^(?:[A-Z][A-Za-z]*)_\d+$/;

function finding(
  rule: Pick<UiRule, 'id' | 'category' | 'severity'>,
  message: string,
  hint: string,
  widget?: string,
  data?: Record<string, unknown>,
): UiFinding {
  return { ruleId: rule.id, category: rule.category, severity: rule.severity, widget, message, hint, data };
}

// ── rules ───────────────────────────────────────────────────────────────────

export const UI_RULES: UiRule[] = [
  // ══ Text fit and localisation ═════════════════════════════════════════════
  {
    id: 'ui_text_overflows_box',
    category: 'ui',
    severity: 'error',
    minStrictness: 'relaxed',
    title: 'Text is wider than the box it sits in',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of laidOut(ctx)) {
        const t = w.text_info;
        if (!t?.overflows || t.measured_width === undefined || t.available_width === undefined) continue;
        if (t.auto_wrap) continue; // wrapping text is meant to exceed one line
        const text = t.text ?? '';
        const fits = t.chars_that_fit ?? 0;
        out.push(
          finding(
            { id: 'ui_text_overflows_box', category: 'ui', severity: 'error' },
            `"${w.name}" overflows: its text is ${round(t.measured_width)}px wide in a ${round(t.available_width)}px box.`,
            `The string is ${text.length} characters and only the first ${fits} fit — it is clipped from "${text.slice(0, fits)}" onward. Widen the box to at least ${Math.ceil(t.measured_width)}px, drop the font size, or turn on auto-wrap.`,
            w.name,
            {
              measured_width: t.measured_width,
              available_width: t.available_width,
              text_length: text.length,
              chars_that_fit: fits,
              overflow_px: round(t.measured_width - t.available_width),
            },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_text_near_overflow',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Text nearly fills its box, so any longer string will clip',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of laidOut(ctx)) {
        const t = w.text_info;
        if (!t || t.overflows || t.measured_width === undefined || t.available_width === undefined) continue;
        if (t.auto_wrap || t.available_width <= 0) continue;
        const ratio = t.measured_width / t.available_width;
        if (ratio < ctx.thresholds.textFillWarnRatio) continue;
        const text = t.text ?? '';
        const typical = t.typical_chars_that_fit ?? 0;
        const worst = t.worst_case_chars_that_fit ?? 0;
        out.push(
          finding(
            { id: 'ui_text_near_overflow', category: 'ui', severity: 'warning' },
            `"${w.name}" fills ${Math.round(ratio * 100)}% of its box — it will overlap or clip as soon as the text gets longer.`,
            `At this font and box width, ${typical} characters of typical text fit and only ${worst} fit if the string is all wide glyphs (caps, W/M). The current string is ${text.length}. If this label ever shows variable content — a player name, an item name, a localised string — budget for at most ${worst} characters or make the box wider.`,
            w.name,
            {
              fill_ratio: round(ratio),
              text_length: text.length,
              typical_chars_that_fit: typical,
              worst_case_chars_that_fit: worst,
              available_width: t.available_width,
            },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_text_no_localization_headroom',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Label has no room to grow when translated',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      const headroom = ctx.thresholds.localizationHeadroom;
      if (headroom <= 1) return out;
      for (const w of laidOut(ctx)) {
        const t = w.text_info;
        if (!t || t.measured_width === undefined || t.available_width === undefined) continue;
        if (t.auto_wrap || t.available_width <= 0 || !t.text) continue;
        // Already reported by the overflow/near-overflow rules; don't pile on.
        if (t.measured_width / t.available_width >= ctx.thresholds.textFillWarnRatio) continue;
        const needed = t.measured_width * headroom;
        if (needed <= t.available_width) continue;
        out.push(
          finding(
            { id: 'ui_text_no_localization_headroom', category: 'ui', severity: 'warning' },
            `"${w.name}" fits in English but not with ${Math.round((headroom - 1) * 100)}% translation growth.`,
            `The string measures ${round(t.measured_width)}px in a ${round(t.available_width)}px box, but a German or Russian translation of a string this short commonly runs ${Math.round((headroom - 1) * 100)}% longer, which needs ${Math.ceil(needed)}px. Widen the box by ${Math.ceil(needed - t.available_width)}px, or turn on auto-wrap / text auto-sizing.`,
            w.name,
            {
              measured_width: t.measured_width,
              available_width: t.available_width,
              required_width: round(needed),
              headroom,
            },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_font_too_small',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'relaxed',
    title: 'Font is below the legible minimum for the target platform',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        const size = w.text_info?.font_size;
        if (size === undefined || size <= 0) continue;
        if (size >= ctx.thresholds.minFontPx) continue;
        out.push(
          finding(
            { id: 'ui_font_too_small', category: 'ui', severity: 'warning' },
            `"${w.name}" uses ${size}px text, below the ${ctx.thresholds.minFontPx}px minimum for ${ctx.platform}.`,
            ctx.platform === 'console'
              ? `Console UI is read from about 3m away. Body text under ${ctx.thresholds.minFontPx}px at this design resolution is not reliably legible and is a common certification finding. Raise it to at least ${ctx.thresholds.comfortableFontPx}px.`
              : `Raise it to at least ${ctx.thresholds.minFontPx}px (${ctx.thresholds.comfortableFontPx}px is comfortable for ${ctx.platform}).`,
            w.name,
            { font_size: size, minimum: ctx.thresholds.minFontPx, platform: ctx.platform },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_font_below_comfortable',
    category: 'ui',
    severity: 'info',
    minStrictness: 'strict',
    title: 'Font is legible but below the comfortable size',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        const size = w.text_info?.font_size;
        if (size === undefined || size <= 0) continue;
        if (size < ctx.thresholds.minFontPx) continue; // the harder rule owns this
        if (size >= ctx.thresholds.comfortableFontPx) continue;
        out.push(
          finding(
            { id: 'ui_font_below_comfortable', category: 'ui', severity: 'info' },
            `"${w.name}" is ${size}px; ${ctx.thresholds.comfortableFontPx}px reads more comfortably on ${ctx.platform}.`,
            'This is a polish note, not a defect — it only fires in strict mode.',
            w.name,
            { font_size: size, comfortable: ctx.thresholds.comfortableFontPx },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_font_is_font_face',
    category: 'ui',
    severity: 'error',
    minStrictness: 'relaxed',
    title: 'A UFontFace is assigned where Slate needs a composite UFont',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (!w.text_info?.font_is_font_face) continue;
        out.push(
          finding(
            { id: 'ui_font_is_font_face', category: 'ui', severity: 'error' },
            `"${w.name}" has a UFontFace assigned as its font.`,
            `Slate cannot render a raw font face — it draws the face's glyph-preview atlas instead, which is why the widget shows "BASIC LATIN / A / 0000-007F" tiles rather than text. Create (or pick) the composite UFont asset that wraps this face and assign that. Current asset: ${w.text_info.font_object ?? 'unknown'}.`,
            w.name,
            { font_object: w.text_info.font_object },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_text_empty',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Text widget has no text',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (!isTextWidget(w)) continue;
        const text = w.text_info?.text;
        if (text === undefined || text.trim().length > 0) continue;
        out.push(
          finding(
            { id: 'ui_text_empty', category: 'ui', severity: 'warning' },
            `"${w.name}" is a text widget with no text.`,
            'If it is filled in at runtime this is fine — mark it as a variable (ui_set_variable) so the intent is visible. If it is not, it is dead weight in the tree.',
            w.name,
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_placeholder_text',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Placeholder text left in the widget',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        const text = w.text_info?.text?.trim().toLowerCase();
        if (!text) continue;
        if (!PLACEHOLDER_TEXT.includes(text)) continue;
        out.push(
          finding(
            { id: 'ui_placeholder_text', category: 'ui', severity: 'warning' },
            `"${w.name}" still reads "${w.text_info?.text}".`,
            'This is UMG default or scratch copy. Replace it with the real string before this screen ships.',
            w.name,
            { text: w.text_info?.text },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_bounded_text_without_wrap',
    category: 'ui',
    severity: 'info',
    minStrictness: 'standard',
    title: 'Long text in a fixed-width box with wrapping off',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of laidOut(ctx)) {
        const t = w.text_info;
        if (!t || t.auto_wrap !== false || !t.text) continue;
        // Only meaningful for prose; a short label is supposed to be one line.
        if (t.text.length < 40) continue;
        if (t.available_width === undefined || t.available_width <= 0) continue;
        out.push(
          finding(
            { id: 'ui_bounded_text_without_wrap', category: 'ui', severity: 'info' },
            `"${w.name}" holds ${t.text.length} characters on a single unwrapped line.`,
            'Turn on Auto Wrap Text so the paragraph reflows instead of running out of its box at longer strings or in translation.',
            w.name,
            { text_length: t.text.length },
          ),
        );
      }
      return out;
    },
  },

  // ══ Safe areas ════════════════════════════════════════════════════════════
  {
    id: 'ui_outside_action_safe',
    category: 'ui',
    severity: 'error',
    minStrictness: 'relaxed',
    title: 'Content sits outside the action-safe area',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      const f = ctx.thresholds.actionSafeFraction;
      if (f <= 0) return out;
      const { screen_width: sw, screen_height: sh } = ctx.snapshot;
      const marginX = sw * f;
      const marginY = sh * f;
      for (const w of laidOut(ctx)) {
        if (w.is_panel) continue; // panels legitimately span the screen
        const r = rect(w);
        const violations: string[] = [];
        if (r.x < marginX) violations.push(`left edge ${round(marginX - r.x)}px inside the margin`);
        if (r.y < marginY) violations.push(`top edge ${round(marginY - r.y)}px inside the margin`);
        if (r.x + r.w > sw - marginX) violations.push(`right edge ${round(r.x + r.w - (sw - marginX))}px inside the margin`);
        if (r.y + r.h > sh - marginY) violations.push(`bottom edge ${round(r.y + r.h - (sh - marginY))}px inside the margin`);
        if (violations.length === 0) continue;
        out.push(
          finding(
            { id: 'ui_outside_action_safe', category: 'ui', severity: 'error' },
            `"${w.name}" extends into the ${Math.round(f * 100)}% action-safe margin (${violations.join('; ')}).`,
            `On ${ctx.platform} anything inside this margin can be cropped by the display. Move it at least ${Math.ceil(Math.max(marginX, marginY))}px from the screen edges, or parent it under a SafeZone widget which does this automatically.`,
            w.name,
            { rect: r, margin_x: round(marginX), margin_y: round(marginY) },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_outside_title_safe',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Text or interactive content sits outside the title-safe area',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      const f = ctx.thresholds.titleSafeFraction;
      const action = ctx.thresholds.actionSafeFraction;
      if (f <= 0) return out;
      const { screen_width: sw, screen_height: sh } = ctx.snapshot;
      const marginX = sw * f;
      const marginY = sh * f;
      const actionX = sw * action;
      const actionY = sh * action;
      for (const w of laidOut(ctx)) {
        // Only critical content — readable text and things you can press.
        if (!isTextWidget(w) && !w.is_interactive) continue;
        const r = rect(w);
        const insideTitle =
          r.x < marginX || r.y < marginY || r.x + r.w > sw - marginX || r.y + r.h > sh - marginY;
        if (!insideTitle) continue;
        // The action-safe rule already reports the worse violation.
        const insideAction =
          r.x < actionX || r.y < actionY || r.x + r.w > sw - actionX || r.y + r.h > sh - actionY;
        if (insideAction) continue;
        out.push(
          finding(
            { id: 'ui_outside_title_safe', category: 'ui', severity: 'warning' },
            `"${w.name}" is inside the ${Math.round(f * 100)}% title-safe margin.`,
            'Text and interactive elements should stay within the title-safe area so they are fully readable on every display. Non-critical decoration may live out here.',
            w.name,
            { rect: r, margin_x: round(marginX), margin_y: round(marginY) },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_outside_screen',
    category: 'ui',
    severity: 'error',
    minStrictness: 'relaxed',
    title: 'Widget is partly or fully off-screen',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      const { screen_width: sw, screen_height: sh } = ctx.snapshot;
      for (const w of laidOut(ctx)) {
        const r = rect(w);
        if (r.w <= 0 || r.h <= 0) continue;
        const fullyOff = r.x + r.w <= 0 || r.y + r.h <= 0 || r.x >= sw || r.y >= sh;
        const partlyOff = r.x < 0 || r.y < 0 || r.x + r.w > sw || r.y + r.h > sh;
        if (!partlyOff) continue;
        out.push(
          finding(
            { id: 'ui_outside_screen', category: 'ui', severity: 'error' },
            fullyOff
              ? `"${w.name}" is entirely off-screen at ${sw}x${sh}.`
              : `"${w.name}" hangs off the ${sw}x${sh} screen.`,
            fullyOff
              ? 'Nothing here will ever be visible. Either it is dead, or its anchors/position are wrong.'
              : 'Check the anchors: a widget anchored to the top-left with a large offset falls off the edge as soon as the resolution changes.',
            w.name,
            { rect: r, screen: { width: sw, height: sh }, fully_offscreen: fullyOff },
          ),
        );
      }
      return out;
    },
  },

  // ══ Overlap and geometry ══════════════════════════════════════════════════
  {
    id: 'ui_widgets_overlap',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'relaxed',
    title: 'Two siblings overlap on screen',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      // Only content widgets: panels overlapping is how layering works, but
      // anything that actually paints — text, controls, images — colliding
      // with a sibling is a real visual defect.
      const isContent = (w: UiWidget) =>
        !w.is_panel && (isTextWidget(w) || w.is_interactive || w.class === 'Image');
      for (const [a, b] of siblingPairs(ctx, isContent)) {
        const area = overlapArea(a, b);
        if (area <= 1) continue;
        // An Overlay panel exists precisely to stack its children.
        const parent = ctx.byName.get(a.parent);
        if (parent && (parent.class === 'Overlay' || parent.class === 'WidgetSwitcher')) continue;
        const za = a.z_order ?? 0;
        const zb = b.z_order ?? 0;
        out.push(
          finding(
            { id: 'ui_widgets_overlap', category: 'ui', severity: 'warning' },
            `"${a.name}" and "${b.name}" overlap by ${Math.round(area)}px².`,
            za === zb
              ? `Both are at Z-order ${za}, so which one draws on top is decided by child order and can change. Separate them, or set an explicit Z-order.`
              : `"${za > zb ? a.name : b.name}" draws on top. If that is intentional, put them in an Overlay panel to make it explicit.`,
            a.name,
            { other: b.name, overlap_area: Math.round(area), z_order_a: za, z_order_b: zb },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_interactive_targets_touch',
    category: 'ui',
    severity: 'error',
    minStrictness: 'relaxed',
    title: 'Interactive widget is smaller than the minimum target size',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      const min = ctx.thresholds.minTouchTargetPx;
      for (const w of laidOut(ctx)) {
        if (!w.is_interactive) continue;
        const r = rect(w);
        if (r.w <= 0 || r.h <= 0) continue;
        const short = Math.min(r.w, r.h);
        if (short >= min) continue;
        out.push(
          finding(
            { id: 'ui_interactive_targets_touch', category: 'ui', severity: 'error' },
            `"${w.name}" is ${Math.round(r.w)}x${Math.round(r.h)}px; the ${ctx.platform} minimum target is ${min}px on the short side.`,
            ctx.platform === 'mobile'
              ? `Apple HIG asks for 44x44pt and Material for 48x48dp. Grow the widget, or wrap it in a SizeBox of at least ${min}px so the hit area is bigger than the visible art.`
              : `Grow the widget or wrap it in a SizeBox of at least ${min}px. The hit area can be larger than the visible art.`,
            w.name,
            { width: Math.round(r.w), height: Math.round(r.h), minimum: min, platform: ctx.platform },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_interactive_too_close',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Interactive widgets are too close to each other',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      const minGap = ctx.thresholds.minInteractiveGapPx;
      for (const [a, b] of siblingPairs(ctx, (w) => w.is_interactive)) {
        const ra = rect(a);
        const rb = rect(b);
        // Gap along whichever axis actually separates them.
        const gapX = Math.max(ra.x, rb.x) - Math.min(ra.x + ra.w, rb.x + rb.w);
        const gapY = Math.max(ra.y, rb.y) - Math.min(ra.y + ra.h, rb.y + rb.h);
        const gap = Math.max(gapX, gapY);
        if (gap < 0) continue; // overlapping — the overlap rule owns this
        if (gap >= minGap) continue;
        out.push(
          finding(
            { id: 'ui_interactive_too_close', category: 'ui', severity: 'warning' },
            `"${a.name}" and "${b.name}" are only ${round(gap)}px apart (minimum ${minGap}px).`,
            'Adjacent controls this close get mis-pressed. Add padding to the slots or a Spacer between them.',
            a.name,
            { other: b.name, gap: round(gap), minimum: minGap },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_zero_size_widget',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'relaxed',
    title: 'Widget lays out to zero size',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (!w.laid_out) continue;
        const r = rect(w);
        if (r.w > 0.5 && r.h > 0.5) continue;
        // A Spacer with an explicit zero dimension is a legitimate shim.
        if (w.class === 'Spacer') continue;
        out.push(
          finding(
            { id: 'ui_zero_size_widget', category: 'ui', severity: 'warning' },
            `"${w.name}" (${w.class}) lays out to ${Math.round(r.w)}x${Math.round(r.h)}px — nothing will be visible.`,
            'Usually a slot with no size set, an empty panel with no children to size it, or a fill weight of 0 in a box that gives it nothing.',
            w.name,
            { width: r.w, height: r.h },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_child_exceeds_parent',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Child is drawn outside its parent panel',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of laidOut(ctx)) {
        const parent = ctx.byName.get(w.parent);
        if (!parent?.laid_out) continue;
        const rp = rect(parent);
        if (rp.w <= 0 || rp.h <= 0) continue;
        const r = rect(w);
        const overflowRight = r.x + r.w - (rp.x + rp.w);
        const overflowBottom = r.y + r.h - (rp.y + rp.h);
        const overflowLeft = rp.x - r.x;
        const overflowTop = rp.y - r.y;
        const worst = Math.max(overflowRight, overflowBottom, overflowLeft, overflowTop);
        if (worst <= 1) continue;
        out.push(
          finding(
            { id: 'ui_child_exceeds_parent', category: 'ui', severity: 'warning' },
            `"${w.name}" extends ${Math.round(worst)}px beyond its parent "${parent.name}".`,
            'Whether this is visible or clipped depends on the parent Clipping setting, so it renders differently in different panels. Resize the child, or set the parent to clip deliberately.',
            w.name,
            { parent: parent.name, overflow_px: Math.round(worst) },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_off_spacing_grid',
    category: 'ui',
    severity: 'info',
    minStrictness: 'strict',
    title: 'Position or size is off the spacing grid',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      const grid = ctx.thresholds.spacingGridPx;
      if (grid <= 1) return out;
      for (const w of laidOut(ctx)) {
        if (w.is_panel) continue;
        const r = rect(w);
        const offenders: string[] = [];
        // Sub-pixel results from fill/centre layout are not authored numbers,
        // so only flag values that are visibly off the grid.
        const off = (v: number) => {
          const m = Math.abs(v % grid);
          return m > 0.5 && m < grid - 0.5;
        };
        if (off(r.x)) offenders.push(`x=${round(r.x)}`);
        if (off(r.y)) offenders.push(`y=${round(r.y)}`);
        if (off(r.w)) offenders.push(`width=${round(r.w)}`);
        if (off(r.h)) offenders.push(`height=${round(r.h)}`);
        if (offenders.length === 0) continue;
        out.push(
          finding(
            { id: 'ui_off_spacing_grid', category: 'ui', severity: 'info' },
            `"${w.name}" is off the ${grid}px grid (${offenders.join(', ')}).`,
            `Snapping positions and sizes to multiples of ${grid} keeps rhythm consistent across screens. Strict-mode nit.`,
            w.name,
            { grid, values: offenders },
          ),
        );
      }
      return out;
    },
  },

  // ══ Anchors and responsiveness ════════════════════════════════════════════
  {
    id: 'ui_canvas_child_top_left_anchored',
    category: 'ui',
    severity: 'info',
    // Demoted to strict after the first live run: nearly every widget on a
    // canvas-authored screen uses the default anchor, so at standard this rule
    // produced one finding per widget and buried the real defects. It is a
    // real responsiveness concern, but it is house style rather than a bug.
    minStrictness: 'strict',
    title: 'Canvas child is pinned to the top-left and will not adapt',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        const a = w.anchors;
        if (!a) continue;
        const isTopLeft = a.min_x === 0 && a.min_y === 0 && a.max_x === 0 && a.max_y === 0;
        if (!isTopLeft) continue;
        // Something at the actual top-left corner is fine pinned there.
        const r = rect(w);
        const nearCorner = r.x < ctx.snapshot.screen_width * 0.25 && r.y < ctx.snapshot.screen_height * 0.25;
        if (nearCorner) continue;
        out.push(
          finding(
            { id: 'ui_canvas_child_top_left_anchored', category: 'ui', severity: 'info' },
            `"${w.name}" uses the default top-left anchor but sits at (${Math.round(r.x)}, ${Math.round(r.y)}).`,
            'With a top-left anchor the widget keeps that pixel offset at every resolution, so it drifts away from where you placed it on wider or shorter screens. Anchor it to the region it belongs to (centre, bottom-right, or a stretched anchor).',
            w.name,
            { anchors: a, position: { x: round(r.x), y: round(r.y) } },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_stretched_anchor_with_pivot',
    category: 'ui',
    severity: 'info',
    minStrictness: 'strict',
    title: 'Stretched anchor combined with a non-zero alignment',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        const a = w.anchors;
        if (!a) continue;
        const stretched = a.max_x - a.min_x > 0.001 || a.max_y - a.min_y > 0.001;
        if (!stretched) continue;
        if (w.auto_size !== true) continue;
        out.push(
          finding(
            { id: 'ui_stretched_anchor_with_pivot', category: 'ui', severity: 'info' },
            `"${w.name}" has a stretched anchor and auto-size enabled at the same time.`,
            'A stretched anchor tells the widget to fill the anchor region; auto-size tells it to shrink to its content. The two fight, and which wins is not obvious from the designer. Pick one.',
            w.name,
            { anchors: a },
          ),
        );
      }
      return out;
    },
  },

  // ══ Contrast and visibility ═══════════════════════════════════════════════
  {
    id: 'ui_text_contrast_below_minimum',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Text contrast against its background is below the minimum',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        const color = w.text_info?.color;
        if (!color) continue;
        const bg = backgroundColorOf(ctx, w);
        if (!bg) continue;
        const ratio = contrastRatio(color, bg);
        if (ratio >= ctx.thresholds.minContrastRatio) continue;
        out.push(
          finding(
            { id: 'ui_text_contrast_below_minimum', category: 'ui', severity: 'warning' },
            `"${w.name}" has a contrast ratio of ${round(ratio)}:1 against its background (minimum ${ctx.thresholds.minContrastRatio}:1).`,
            `WCAG 2.1 asks for 4.5:1 for body text and 3:1 for large text; AAA asks for 7:1. Darken the background or lighten the text. Measured against the nearest opaque ancestor fill — translucent panels are skipped because the real backdrop is unknown.`,
            w.name,
            { ratio: round(ratio), required: ctx.thresholds.minContrastRatio, text_color: color, background: bg },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_invisible_but_present',
    category: 'ui',
    severity: 'info',
    minStrictness: 'standard',
    title: 'Widget is fully transparent',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        const reasons: string[] = [];
        if (w.render_opacity <= 0.001) reasons.push('render opacity is 0');
        const tintAlpha = w.brush_info?.tint?.[3];
        if (tintAlpha !== undefined && tintAlpha <= 0.001) reasons.push('brush tint alpha is 0');
        const textAlpha = w.text_info?.color?.[3];
        if (textAlpha !== undefined && textAlpha <= 0.001) reasons.push('text alpha is 0');
        if (reasons.length === 0) continue;
        out.push(
          finding(
            { id: 'ui_invisible_but_present', category: 'ui', severity: 'info' },
            `"${w.name}" cannot be seen (${reasons.join(', ')}) but still lays out and still takes input.`,
            'If it is meant to fade in at runtime this is correct. If it is meant to be gone, set Visibility to Collapsed so it also stops consuming layout space and hit tests.',
            w.name,
            { reasons },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_image_without_resource',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Image widget has no texture or material assigned',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (w.class !== 'Image') continue;
        if (w.brush_info?.has_resource) continue;
        out.push(
          finding(
            { id: 'ui_image_without_resource', category: 'ui', severity: 'warning' },
            `"${w.name}" is an Image with no resource assigned.`,
            'It renders as a flat tinted rectangle. Assign a Texture2D or material with ui_set_brush, or use a Border if a solid fill is what you wanted.',
            w.name,
          ),
        );
      }
      return out;
    },
  },

  // ══ Input and focus ═══════════════════════════════════════════════════════
  {
    id: 'ui_interactive_not_focusable',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Interactive widget cannot receive focus',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (!w.is_interactive || w.is_focusable) continue;
        out.push(
          finding(
            { id: 'ui_interactive_not_focusable', category: 'ui', severity: 'warning' },
            `"${w.name}" is interactive but not focusable.`,
            'Gamepad and keyboard navigation move focus between focusable widgets. A control that cannot take focus is unreachable without a mouse — on console that means unreachable, full stop.',
            w.name,
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_no_focusable_widget',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Screen has interactive content but nothing focusable',
    needsLayout: false,
    evaluate: (ctx) => {
      const interactive = ctx.snapshot.widgets.filter((w) => w.is_interactive);
      if (interactive.length === 0) return [];
      if (interactive.some((w) => w.is_focusable)) return [];
      return [
        finding(
          { id: 'ui_no_focusable_widget', category: 'ui', severity: 'warning' },
          `This screen has ${interactive.length} interactive widget(s) and none of them can take focus.`,
          'Gamepad users will land on this screen with no focus target and no way to move. Make at least one control focusable and set it as the initial focus in the widget graph.',
          undefined,
          { interactive_count: interactive.length },
        ),
      ];
    },
  },
  {
    id: 'ui_interactive_hit_test_invisible',
    category: 'ui',
    severity: 'error',
    minStrictness: 'relaxed',
    title: 'Interactive widget has input disabled by its visibility setting',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (!w.is_interactive) continue;
        const v = w.visibility;
        if (!v.includes('HitTestInvisible')) continue;
        out.push(
          finding(
            { id: 'ui_interactive_hit_test_invisible', category: 'ui', severity: 'error' },
            `"${w.name}" is a control with visibility ${v.split('::').pop()}.`,
            'HitTestInvisible and SelfHitTestInvisible make a widget ignore the mouse entirely, so this control is visible but cannot be clicked. Set it to Visible.',
            w.name,
            { visibility: v },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_button_without_content',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Button has no label or icon',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (w.class !== 'Button') continue;
        if ((w.child_count ?? 0) > 0) continue;
        out.push(
          finding(
            { id: 'ui_button_without_content', category: 'ui', severity: 'warning' },
            `"${w.name}" is an empty Button.`,
            'A button with no child renders as a bare box with nothing to tell the player what it does. Add a TextBlock or Image child.',
            w.name,
          ),
        );
      }
      return out;
    },
  },

  // ══ Structure and hygiene ═════════════════════════════════════════════════
  {
    id: 'ui_empty_panel',
    category: 'ui',
    severity: 'info',
    minStrictness: 'standard',
    title: 'Panel has no children',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (!w.is_panel) continue;
        if ((w.child_count ?? 0) > 0) continue;
        // A NamedSlot is a deliberate hole for a caller to fill.
        if (w.class === 'NamedSlot') continue;
        // Buttons and check boxes are panels, but an empty one is already
        // reported by ui_button_without_content with better advice.
        if (w.class === 'Button' || w.class === 'CheckBox') continue;
        out.push(
          finding(
            { id: 'ui_empty_panel', category: 'ui', severity: 'info' },
            `"${w.name}" (${w.class}) has no children.`,
            'Either it is scaffolding that was never filled in, or it is dead. Empty panels still cost a layout pass.',
            w.name,
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_redundant_single_child_panel',
    category: 'ui',
    severity: 'info',
    minStrictness: 'strict',
    title: 'Panel wraps a single child for no layout reason',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      // These wrap one child ON PURPOSE — sizing, scaling, clipping, padding.
      const purposeful = new Set([
        'SizeBox',
        'ScaleBox',
        'Border',
        'RetainerBox',
        'InvalidationBox',
        'SafeZone',
        'BackgroundBlur',
        'NamedSlot',
        'WidgetSwitcher',
      ]);
      for (const w of ctx.snapshot.widgets) {
        if (!w.is_panel || purposeful.has(w.class)) continue;
        if ((w.child_count ?? 0) !== 1) continue;
        out.push(
          finding(
            { id: 'ui_redundant_single_child_panel', category: 'ui', severity: 'info' },
            `"${w.name}" (${w.class}) contains exactly one child.`,
            'A box or canvas around a single widget usually adds a layout pass without changing the result. Consider removing it (ui_reparent_element the child, then ui_remove_element the panel).',
            w.name,
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_nesting_too_deep',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Widget hierarchy is deeper than the recommended limit',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      const max = ctx.thresholds.maxNestingDepth;
      const deepest = laidOut(ctx).reduce<UiWidget | null>(
        (acc, w) => ((w.depth ?? 0) > (acc?.depth ?? -1) ? w : acc),
        null,
      );
      if (!deepest || (deepest.depth ?? 0) <= max) return out;
      out.push(
        finding(
          { id: 'ui_nesting_too_deep', category: 'ui', severity: 'warning' },
          `The tree is ${deepest.depth} levels deep at "${deepest.name}" (recommended maximum ${max}).`,
          'Every level is another layout and paint pass for each child beneath it. Flatten with a Grid or an Overlay where the nesting is only there to position things.',
          deepest.name,
          { depth: deepest.depth, maximum: max },
        ),
      );
      return out;
    },
  },
  {
    id: 'ui_too_many_widgets',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Blueprint contains a lot of widgets',
    needsLayout: false,
    evaluate: (ctx) => {
      const max = ctx.thresholds.maxWidgetCount;
      if (ctx.snapshot.widget_count <= max) return [];
      return [
        finding(
          { id: 'ui_too_many_widgets', category: 'ui', severity: 'warning' },
          `This blueprint has ${ctx.snapshot.widget_count} widgets (soft limit ${max}).`,
          'Large static trees are the usual cause of UI frame cost. Split reusable chunks into their own Widget Blueprints, use a ListView with an entry widget for repeated rows, and wrap static regions in an InvalidationBox.',
          undefined,
          { widget_count: ctx.snapshot.widget_count, maximum: max },
        ),
      ];
    },
  },
  {
    id: 'ui_default_widget_name',
    category: 'ui',
    severity: 'info',
    minStrictness: 'strict',
    title: 'Widget still has its auto-generated name',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (!DEFAULT_NAME_RE.test(w.name)) continue;
        out.push(
          finding(
            { id: 'ui_default_widget_name', category: 'ui', severity: 'info' },
            `"${w.name}" is an auto-generated name.`,
            'The widget name is the variable name the graph and C++ BindWidget resolve against, so it is API. Rename it with ui_rename_element.',
            w.name,
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_named_widget_not_variable',
    category: 'ui',
    severity: 'info',
    minStrictness: 'strict',
    title: 'Deliberately named widget is not exposed as a variable',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (w.is_variable) continue;
        if (DEFAULT_NAME_RE.test(w.name)) continue; // not deliberately named
        // Only content widgets — nobody binds to a spacer.
        if (!isTextWidget(w) && !w.is_interactive && w.class !== 'Image') continue;
        out.push(
          finding(
            { id: 'ui_named_widget_not_variable', category: 'ui', severity: 'info' },
            `"${w.name}" has a deliberate name but is not exposed as a variable.`,
            'Someone named this widget on purpose, which usually means code is meant to reach it. Without Is Variable set, the graph and BindWidget cannot. Fix with ui_set_variable.',
            w.name,
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_no_root_widget',
    category: 'ui',
    severity: 'error',
    minStrictness: 'relaxed',
    title: 'Widget blueprint has no root widget',
    needsLayout: false,
    evaluate: (ctx) => {
      if (ctx.snapshot.widgets.length > 0) return [];
      return [
        finding(
          { id: 'ui_no_root_widget', category: 'ui', severity: 'error' },
          'This Widget Blueprint has an empty widget tree.',
          'Nothing will render. Add a root panel with ui_add_element (a CanvasPanel is the usual choice) before adding content.',
        ),
      ];
    },
  },
  {
    id: 'ui_disabled_interactive',
    category: 'ui',
    severity: 'info',
    minStrictness: 'standard',
    title: 'Control is authored in the disabled state',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (!w.is_interactive || w.is_enabled) continue;
        out.push(
          finding(
            { id: 'ui_disabled_interactive', category: 'ui', severity: 'info' },
            `"${w.name}" is authored with Is Enabled off.`,
            'Fine if the graph enables it later. If not, it ships greyed out — and players cannot tell a deliberately-disabled control from a broken one unless the disabled state is visually distinct.',
            w.name,
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_backgroundblur_overuse',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'Several BackgroundBlur widgets on one screen',
    needsLayout: false,
    evaluate: (ctx) => {
      const blurs = ctx.snapshot.widgets.filter((w) => w.class === 'BackgroundBlur');
      if (blurs.length <= 1) return [];
      return [
        finding(
          { id: 'ui_backgroundblur_overuse', category: 'ui', severity: 'warning' },
          `${blurs.length} BackgroundBlur widgets on one screen (${blurs.map((b) => b.name).join(', ')}).`,
          'Each blur is a separate full-resolution render-target pass and they are one of the most expensive things a UMG screen can do — especially on handheld and mobile. Use one blur behind the whole panel instead of one per element.',
          blurs[0]?.name,
          { count: blurs.length, widgets: blurs.map((b) => b.name) },
        ),
      ];
    },
  },
  {
    id: 'ui_retainerbox_with_dynamic_content',
    category: 'ui',
    severity: 'info',
    minStrictness: 'strict',
    title: 'RetainerBox wraps content that looks dynamic',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (w.class !== 'RetainerBox') continue;
        // Interactive descendants imply content that changes every frame,
        // which is exactly what a retainer is bad at.
        const dynamicChild = ctx.snapshot.widgets.find((c) => c.is_interactive && isAncestor(ctx, w.name, c));
        if (!dynamicChild) continue;
        out.push(
          finding(
            { id: 'ui_retainerbox_with_dynamic_content', category: 'ui', severity: 'info' },
            `"${w.name}" is a RetainerBox containing interactive content ("${dynamicChild.name}").`,
            'A RetainerBox pays for a render target to avoid re-drawing static content. Content that changes on hover or focus invalidates it constantly, so it costs more than it saves. Retain static art instead.',
            w.name,
            { dynamic_child: dynamicChild.name },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_widgetswitcher_empty',
    category: 'ui',
    severity: 'warning',
    minStrictness: 'standard',
    title: 'WidgetSwitcher has fewer than two children',
    needsLayout: false,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of ctx.snapshot.widgets) {
        if (w.class !== 'WidgetSwitcher') continue;
        const count = w.child_count ?? 0;
        if (count >= 2) continue;
        out.push(
          finding(
            { id: 'ui_widgetswitcher_empty', category: 'ui', severity: 'warning' },
            `"${w.name}" is a WidgetSwitcher with ${count} child(ren).`,
            'A switcher exists to swap between alternatives. With fewer than two it adds a layout level for nothing.',
            w.name,
            { child_count: count },
          ),
        );
      }
      return out;
    },
  },
  {
    id: 'ui_image_oversized_texture',
    category: 'ui',
    severity: 'info',
    minStrictness: 'standard',
    title: 'Image is drawn much smaller than its source art',
    needsLayout: true,
    evaluate: (ctx) => {
      const out: UiFinding[] = [];
      for (const w of laidOut(ctx)) {
        const b = w.brush_info;
        if (!b?.has_resource || !b.image_size_x || !b.image_size_y) continue;
        const r = rect(w);
        if (r.w <= 0 || r.h <= 0) continue;
        const ratio = Math.min(b.image_size_x / r.w, b.image_size_y / r.h);
        if (ratio < 2) continue;
        out.push(
          finding(
            { id: 'ui_image_oversized_texture', category: 'ui', severity: 'info' },
            `"${w.name}" draws at ${Math.round(r.w)}x${Math.round(r.h)}px from ${b.image_size_x}x${b.image_size_y} source art (${round(ratio)}x oversized).`,
            'The full texture still occupies memory. Downsize the source or set a smaller max texture size in the asset — UI textures are usually not mip-mapped, so the whole thing stays resident.',
            w.name,
            { drawn: { w: Math.round(r.w), h: Math.round(r.h) }, source: { w: b.image_size_x, h: b.image_size_y } },
          ),
        );
      }
      return out;
    },
  },
];

/** Rules keyed by id. */
export function uiRulesById(): Map<string, UiRule> {
  const m = new Map<string, UiRule>();
  for (const r of UI_RULES) m.set(r.id, r);
  return m;
}
