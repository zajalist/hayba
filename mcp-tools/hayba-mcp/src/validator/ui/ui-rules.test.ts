import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateUiSnapshot, UI_RULES } from './index.js';
import { contrastRatio, resolveThresholds } from './thresholds.js';
import { setConfigPath, setRuleDisabled, setStrictness } from '../config.js';
import type { UiSnapshot, UiWidget } from './types.js';

// Each test gets its own config file so strictness/disable state never leaks
// between cases (the config is read from disk on every call, by design).
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hayba-ui-validator-'));
  setConfigPath(join(tmp, 'validator-config.json'));
});
afterEach(() => {
  setConfigPath(null);
  rmSync(tmp, { recursive: true, force: true });
});

function widget(partial: Partial<UiWidget> & { name: string }): UiWidget {
  return {
    class: 'TextBlock',
    parent: 'Root',
    slot_class: 'CanvasPanelSlot',
    is_panel: false,
    is_variable: true,
    visibility: 'ESlateVisibility::Visible',
    render_opacity: 1,
    is_enabled: true,
    is_interactive: false,
    is_focusable: false,
    laid_out: true,
    x: 100,
    y: 100,
    width: 200,
    height: 40,
    depth: 1,
    ...partial,
  };
}

function snapshot(widgets: UiWidget[], overrides: Partial<UiSnapshot> = {}): UiSnapshot {
  return {
    widget_blueprint_path: '/Game/UI/WBP_Test',
    screen_width: 1920,
    screen_height: 1080,
    layout_resolved: true,
    widget_count: widgets.length,
    widgets,
    ...overrides,
  };
}

const rootPanel = widget({
  name: 'Root',
  class: 'CanvasPanel',
  parent: '',
  is_panel: true,
  child_count: 1,
  depth: 0,
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
});

function findingsFor(result: ReturnType<typeof validateUiSnapshot>, ruleId: string) {
  return result.findings.filter((f) => f.ruleId === ruleId);
}

describe('text fit rules', () => {
  it('reports overflow with the exact character count that fits', () => {
    const label = widget({
      name: 'PlayerName',
      text_info: {
        text: 'Bartholomew Ravensworth III',
        font_size: 24,
        auto_wrap: false,
        measured_width: 320,
        available_width: 200,
        overflows: true,
        chars_that_fit: 17,
        typical_chars_that_fit: 18,
        worst_case_chars_that_fit: 11,
      },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, label]), { strictness: 'standard' });
    const found = findingsFor(result, 'ui_text_overflows_box');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('error');
    // The hint must name the exact cut-off point, not a vague "too long".
    expect(found[0]!.hint).toContain('only the first 17 fit');
    expect(found[0]!.data).toMatchObject({ chars_that_fit: 17, overflow_px: 120 });
  });

  it('warns before overflow and states the character budget for variable text', () => {
    const label = widget({
      name: 'ItemName',
      text_info: {
        text: 'Iron Sword',
        font_size: 24,
        auto_wrap: false,
        measured_width: 190,
        available_width: 200,
        overflows: false,
        chars_that_fit: 10,
        typical_chars_that_fit: 21,
        worst_case_chars_that_fit: 13,
      },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, label]), { strictness: 'standard' });
    const found = findingsFor(result, 'ui_text_near_overflow');
    expect(found).toHaveLength(1);
    expect(found[0]!.hint).toContain('at most 13 characters');
    expect(found[0]!.data).toMatchObject({ worst_case_chars_that_fit: 13 });
  });

  it('does not flag wrapping text as overflowing', () => {
    const paragraph = widget({
      name: 'Body',
      text_info: {
        text: 'A long paragraph of body copy that is meant to wrap onto several lines.',
        font_size: 20,
        auto_wrap: true,
        measured_width: 900,
        available_width: 300,
        overflows: true,
        chars_that_fit: 20,
      },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, paragraph]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_text_overflows_box')).toHaveLength(0);
  });

  it('flags a label that fits in English but not after translation growth', () => {
    const label = widget({
      name: 'SettingsLabel',
      text_info: {
        text: 'Settings',
        font_size: 24,
        auto_wrap: false,
        measured_width: 100,
        available_width: 120, // 100 * 1.3 = 130 > 120
        overflows: false,
        chars_that_fit: 8,
        typical_chars_that_fit: 12,
        worst_case_chars_that_fit: 8,
      },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, label]), { strictness: 'standard' });
    const found = findingsFor(result, 'ui_text_no_localization_headroom');
    expect(found).toHaveLength(1);
    expect(found[0]!.data).toMatchObject({ required_width: 130, headroom: 1.3 });
  });

  it('applies a larger localisation margin in strict mode', () => {
    const label = widget({
      name: 'SettingsLabel',
      text_info: {
        text: 'Settings',
        font_size: 24,
        auto_wrap: false,
        measured_width: 100,
        available_width: 140, // survives 1.3x, fails 1.5x
        overflows: false,
        chars_that_fit: 8,
      },
    });
    const snap = snapshot([rootPanel, label]);
    expect(findingsFor(validateUiSnapshot(snap, { strictness: 'standard' }), 'ui_text_no_localization_headroom')).toHaveLength(0);
    expect(findingsFor(validateUiSnapshot(snap, { strictness: 'strict' }), 'ui_text_no_localization_headroom')).toHaveLength(1);
  });

  it('catches a UFontFace assigned where a UFont is required', () => {
    const label = widget({
      name: 'Title',
      text_info: { text: 'Play', font_size: 48, font_object: '/Game/UI/Fonts/Cormorant_Font', font_is_font_face: true },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, label]), { strictness: 'relaxed' });
    const found = findingsFor(result, 'ui_font_is_font_face');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('error');
  });

  it('does not report an empty runtime label whose own visibility is Collapsed', () => {
    const label = widget({
      name: 'RuntimeState',
      visibility: 'ESlateVisibility::Collapsed',
      text_info: { text: '', font_size: 18 },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, label]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_text_empty')).toHaveLength(0);
  });

  it('treats a label below a Collapsed ancestor as effectively Collapsed', () => {
    const runtimePanel = widget({
      name: 'RuntimePanel',
      class: 'VerticalBox',
      parent: 'Root',
      is_panel: true,
      child_count: 1,
      visibility: 'Collapsed',
    });
    const label = widget({
      name: 'RuntimeState',
      parent: 'RuntimePanel',
      visibility: 'ESlateVisibility::Visible',
      text_info: { text: '   ', font_size: 18 },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, runtimePanel, label]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_text_empty')).toHaveLength(0);
  });

  it.each(['ESlateVisibility::Hidden', 'Hidden', 'ESlateVisibility::Visible', 'NotCollapsed'])(
    'still reports empty text whose effective visibility is %s',
    (visibility) => {
      const label = widget({
        name: 'EmptyState',
        visibility,
        text_info: { text: '', font_size: 18 },
      });
      const result = validateUiSnapshot(snapshot([rootPanel, label]), { strictness: 'standard' });
      expect(findingsFor(result, 'ui_text_empty')).toHaveLength(1);
    },
  );
});

describe('platform-sensitive thresholds', () => {
  it('accepts a 16px font on PC and rejects it on console', () => {
    const label = widget({ name: 'Hint', text_info: { text: 'Press A', font_size: 16 } });
    const snap = snapshot([rootPanel, label]);
    expect(findingsFor(validateUiSnapshot(snap, { platform: 'pc' }), 'ui_font_too_small')).toHaveLength(0);
    const console = findingsFor(validateUiSnapshot(snap, { platform: 'console' }), 'ui_font_too_small');
    expect(console).toHaveLength(1);
    expect(console[0]!.hint).toContain('3m');
  });

  it('applies the 44px touch target minimum only on mobile', () => {
    const button = widget({
      name: 'CloseButton',
      class: 'Button',
      is_interactive: true,
      is_focusable: true,
      width: 32,
      height: 32,
    });
    const snap = snapshot([rootPanel, button]);
    expect(findingsFor(validateUiSnapshot(snap, { platform: 'pc' }), 'ui_interactive_targets_touch')).toHaveLength(0);
    expect(findingsFor(validateUiSnapshot(snap, { platform: 'mobile' }), 'ui_interactive_targets_touch')).toHaveLength(1);
  });

  it('scales pixel thresholds to the design resolution', () => {
    const at1080 = resolveThresholds('console', 'standard', 1080);
    const at720 = resolveThresholds('console', 'standard', 720);
    expect(at1080.minFontPx).toBe(28);
    // A 720p-authored screen is judged with proportionally smaller pixels.
    expect(at720.minFontPx).toBe(19);
    // Fractions are resolution-independent.
    expect(at720.titleSafeFraction).toBe(at1080.titleSafeFraction);
  });
});

describe('safe areas', () => {
  it('flags console content inside the action-safe margin', () => {
    const label = widget({ name: 'Score', x: 10, y: 10, width: 200, height: 40, text_info: { text: '0', font_size: 32 } });
    const result = validateUiSnapshot(snapshot([rootPanel, label]), { platform: 'console' });
    expect(findingsFor(result, 'ui_outside_action_safe')).toHaveLength(1);
  });

  it('does not apply TV safe areas on PC', () => {
    const label = widget({ name: 'Score', x: 10, y: 10, width: 200, height: 40, text_info: { text: '0', font_size: 32 } });
    const result = validateUiSnapshot(snapshot([rootPanel, label]), { platform: 'pc' });
    expect(findingsFor(result, 'ui_outside_action_safe')).toHaveLength(0);
    expect(findingsFor(result, 'ui_outside_title_safe')).toHaveLength(0);
  });

  it('does not apply console safe margins along a ScrollBox scroll axis', () => {
    const scroll = widget({
      name: 'GoodsScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 1,
      x: 100,
      y: 100,
      width: 500,
      height: 400,
    });
    const row = widget({
      name: 'LateGoodRow',
      parent: 'GoodsScroll',
      x: 100,
      y: 1200,
      width: 500,
      height: 200,
      text_info: { text: 'Grain', font_size: 32 },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, scroll, row]), {
      platform: 'console',
      strictness: 'standard',
    });
    expect(findingsFor(result, 'ui_outside_action_safe').map((f) => f.widget)).not.toContain('LateGoodRow');
    expect(findingsFor(result, 'ui_outside_title_safe').map((f) => f.widget)).not.toContain('LateGoodRow');
  });

  it('still reports visible scroller content in the console top and bottom safe margins', () => {
    const topScroll = widget({
      name: 'TopScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 2,
      x: 100,
      y: 0,
      width: 500,
      height: 400,
    });
    const bottomScroll = widget({
      name: 'BottomScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 2,
      x: 100,
      y: 680,
      width: 500,
      height: 400,
    });
    const topAction = widget({
      name: 'TopAction', parent: 'TopScroll', x: 200, y: 0, width: 200, height: 40,
      text_info: { text: 'Unsafe top', font_size: 32 },
    });
    const topTitle = widget({
      name: 'TopTitle', parent: 'TopScroll', x: 200, y: 40, width: 200, height: 40,
      text_info: { text: 'Near top', font_size: 32 },
    });
    const bottomTitle = widget({
      name: 'BottomTitle', parent: 'BottomScroll', x: 200, y: 1000, width: 200, height: 40,
      text_info: { text: 'Near bottom', font_size: 32 },
    });
    const bottomAction = widget({
      name: 'BottomAction', parent: 'BottomScroll', x: 200, y: 1040, width: 200, height: 40,
      text_info: { text: 'Unsafe bottom', font_size: 32 },
    });
    const result = validateUiSnapshot(
      snapshot([rootPanel, topScroll, bottomScroll, topAction, topTitle, bottomTitle, bottomAction]),
      { platform: 'console', strictness: 'standard' },
    );
    expect(findingsFor(result, 'ui_outside_action_safe').map((f) => f.widget)).toEqual([
      'TopAction',
      'BottomAction',
    ]);
    expect(findingsFor(result, 'ui_outside_title_safe').map((f) => f.widget)).toEqual([
      'TopTitle',
      'BottomTitle',
    ]);
  });

  it('judges both safe-margin edges of the visible clipped slice', () => {
    const scroll = widget({
      name: 'FullHeightScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 1,
      x: 100,
      y: 0,
      width: 500,
      height: 1080,
    });
    const row = widget({
      name: 'OppositeEdgeDefect',
      parent: 'FullHeightScroll',
      x: 200,
      y: -100,
      width: 200,
      height: 1170,
      text_info: { text: 'Tall malformed row', font_size: 32 },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, scroll, row]), {
      platform: 'console',
      strictness: 'standard',
    });
    const action = findingsFor(result, 'ui_outside_action_safe').find((f) => f.widget === 'OppositeEdgeDefect');
    expect(action?.message).toContain('bottom edge');
    expect(action?.message).toContain('top edge');
  });

  it('reports partially visible rows clipped at the top and bottom of a ScrollBox', () => {
    const topScroll = widget({
      name: 'PartialTopScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 1,
      x: 100,
      y: 0,
      width: 500,
      height: 400,
    });
    const bottomScroll = widget({
      name: 'PartialBottomScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 1,
      x: 100,
      y: 680,
      width: 500,
      height: 400,
    });
    const partialTop = widget({
      name: 'PartialTopRow',
      parent: 'PartialTopScroll',
      x: 200,
      y: -150,
      width: 200,
      height: 200,
      text_info: { text: 'Partly visible top', font_size: 32 },
    });
    const partialBottom = widget({
      name: 'PartialBottomRow',
      parent: 'PartialBottomScroll',
      x: 200,
      y: 1030,
      width: 200,
      height: 200,
      text_info: { text: 'Partly visible bottom', font_size: 32 },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, topScroll, bottomScroll, partialTop, partialBottom]), {
      platform: 'console',
      strictness: 'standard',
    });
    expect(findingsFor(result, 'ui_outside_action_safe').map((f) => f.widget)).toEqual([
      'PartialTopRow',
      'PartialBottomRow',
    ]);
    expect(
      findingsFor(result, 'ui_outside_action_safe').find((f) => f.widget === 'PartialBottomRow')?.data,
    ).toMatchObject({
      safe_area_projection: { vertical: { start: 1030, end: 1080 } },
    });
  });

  it('preserves cross-axis action-safe and title-safe findings inside a vertical ScrollBox', () => {
    const scroll = widget({
      name: 'GoodsScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 2,
      x: 0,
      y: 100,
      width: 500,
      height: 400,
    });
    const actionCross = widget({
      name: 'ActionCrossAxis',
      parent: 'GoodsScroll',
      x: 10,
      y: 120,
      width: 200,
      height: 40,
      text_info: { text: 'Unsafe', font_size: 32 },
    });
    const titleCross = widget({
      name: 'TitleCrossAxis',
      parent: 'GoodsScroll',
      x: 80,
      y: 180,
      width: 200,
      height: 40,
      text_info: { text: 'Near edge', font_size: 32 },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, scroll, actionCross, titleCross]), {
      platform: 'console',
      strictness: 'standard',
    });
    expect(findingsFor(result, 'ui_outside_action_safe').map((f) => f.widget)).toEqual(['ActionCrossAxis']);
    expect(findingsFor(result, 'ui_outside_title_safe').map((f) => f.widget)).toEqual(['TitleCrossAxis']);
  });

  it('preserves cross-axis safe findings while content is far along a vertical scroll axis', () => {
    const scroll = widget({
      name: 'FarVerticalScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 2,
      x: 0,
      y: 100,
      width: 500,
      height: 400,
    });
    const actionCross = widget({
      name: 'FarVerticalActionCross',
      parent: 'FarVerticalScroll',
      x: 10,
      y: 1200,
      width: 200,
      height: 40,
      text_info: { text: 'Unsafe when scrolled in', font_size: 32 },
    });
    const titleCross = widget({
      name: 'FarVerticalTitleCross',
      parent: 'FarVerticalScroll',
      x: 80,
      y: 1300,
      width: 200,
      height: 40,
      text_info: { text: 'Near edge when scrolled in', font_size: 32 },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, scroll, actionCross, titleCross]), {
      platform: 'console', strictness: 'standard',
    });
    expect(findingsFor(result, 'ui_outside_action_safe').map((f) => f.widget)).toEqual([
      'FarVerticalActionCross',
    ]);
    expect(findingsFor(result, 'ui_outside_title_safe').map((f) => f.widget)).toEqual([
      'FarVerticalTitleCross',
    ]);
  });

  it('preserves cross-axis safe findings while content is far along a horizontal scroll axis', () => {
    const scroll = widget({
      name: 'FarHorizontalScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Horizontal',
      child_count: 2,
      x: 100,
      y: 0,
      width: 500,
      height: 400,
    });
    const actionCross = widget({
      name: 'FarHorizontalActionCross',
      parent: 'FarHorizontalScroll',
      x: 2000,
      y: 10,
      width: 200,
      height: 40,
      text_info: { text: 'Unsafe when scrolled in', font_size: 32 },
    });
    const titleCross = widget({
      name: 'FarHorizontalTitleCross',
      parent: 'FarHorizontalScroll',
      x: 2300,
      y: 40,
      width: 200,
      height: 40,
      text_info: { text: 'Near edge when scrolled in', font_size: 32 },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, scroll, actionCross, titleCross]), {
      platform: 'console', strictness: 'standard',
    });
    expect(findingsFor(result, 'ui_outside_action_safe').map((f) => f.widget)).toEqual([
      'FarHorizontalActionCross',
    ]);
    expect(findingsFor(result, 'ui_outside_title_safe').map((f) => f.widget)).toEqual([
      'FarHorizontalTitleCross',
    ]);
  });

  it('reports a widget hanging off the screen', () => {
    const label = widget({ name: 'Offscreen', x: 1850, y: 100, width: 300, height: 40 });
    const result = validateUiSnapshot(snapshot([rootPanel, label]), { strictness: 'relaxed' });
    expect(findingsFor(result, 'ui_outside_screen')).toHaveLength(1);
  });

  it('does not report a vertically scrolled descendant below the screen', () => {
    const scroll = widget({
      name: 'GoodsScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 1,
      x: 100,
      y: 100,
      width: 500,
      height: 400,
    });
    const row = widget({
      name: 'LateGoodRow',
      class: 'TradeGoodRow',
      parent: 'GoodsScroll',
      x: 100,
      y: 1120,
      width: 500,
      height: 200,
    });
    const result = validateUiSnapshot(snapshot([rootPanel, scroll, row]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_outside_screen')).toHaveLength(0);
    expect(findingsFor(result, 'ui_child_exceeds_parent')).toHaveLength(0);
  });

  it('still reports the ScrollBox itself when it hangs off-screen', () => {
    const scroll = widget({
      name: 'GoodsScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 1,
      x: 1850,
      y: 100,
      width: 500,
      height: 400,
    });
    const row = widget({
      name: 'LateGoodRow',
      class: 'TradeGoodRow',
      parent: 'GoodsScroll',
      x: 1850,
      y: 1200,
      width: 500,
      height: 200,
    });
    const result = validateUiSnapshot(snapshot([rootPanel, scroll, row]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_outside_screen').map((f) => f.widget)).toEqual(['GoodsScroll']);
  });

  it('reports cross-axis overflow inside a vertical ScrollBox', () => {
    const scroll = widget({
      name: 'GoodsScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 1,
      x: 100,
      y: 100,
      width: 500,
      height: 400,
    });
    const row = widget({
      name: 'TooWideRow',
      class: 'TradeGoodRow',
      parent: 'GoodsScroll',
      x: 1700,
      y: 900,
      width: 500,
      height: 200,
    });
    const result = validateUiSnapshot(snapshot([rootPanel, scroll, row]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_outside_screen').map((f) => f.widget)).toContain('TooWideRow');
    expect(findingsFor(result, 'ui_child_exceeds_parent').map((f) => f.widget)).toContain('TooWideRow');
  });

  it('uses a horizontal ScrollBox orientation without suppressing vertical defects', () => {
    const scroll = widget({
      name: 'CardCarousel',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Horizontal',
      child_count: 2,
      x: 100,
      y: 100,
      width: 500,
      height: 300,
    });
    const expectedHorizontalOverflow = widget({
      name: 'FarCard',
      parent: 'CardCarousel',
      x: 2100,
      y: 100,
      width: 300,
      height: 250,
    });
    const brokenVerticalOverflow = widget({
      name: 'DroppedCard',
      parent: 'CardCarousel',
      x: 900,
      y: 1200,
      width: 300,
      height: 250,
    });
    const result = validateUiSnapshot(
      snapshot([rootPanel, scroll, expectedHorizontalOverflow, brokenVerticalOverflow]),
      { strictness: 'standard' },
    );
    expect(findingsFor(result, 'ui_outside_screen').map((f) => f.widget)).not.toContain('FarCard');
    expect(findingsFor(result, 'ui_child_exceeds_parent').map((f) => f.widget)).not.toContain('FarCard');
    expect(findingsFor(result, 'ui_outside_screen').map((f) => f.widget)).toContain('DroppedCard');
    expect(findingsFor(result, 'ui_child_exceeds_parent').map((f) => f.widget)).toContain('DroppedCard');
  });

  it('still reports a grandchild that exceeds an ordinary panel inside a ScrollBox', () => {
    const scroll = widget({
      name: 'GoodsScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      scroll_orientation: 'Vertical',
      child_count: 1,
      x: 100,
      y: 100,
      width: 500,
      height: 400,
    });
    const row = widget({
      name: 'GoodRow',
      class: 'VerticalBox',
      parent: 'GoodsScroll',
      is_panel: true,
      child_count: 1,
      x: 100,
      y: 700,
      width: 500,
      height: 200,
    });
    const brokenChild = widget({
      name: 'BrokenFactors',
      parent: 'GoodRow',
      x: 100,
      y: 950,
      width: 500,
      height: 100,
    });
    const result = validateUiSnapshot(snapshot([rootPanel, scroll, row, brokenChild]), {
      strictness: 'standard',
    });
    expect(findingsFor(result, 'ui_child_exceeds_parent').map((f) => f.widget)).toContain('BrokenFactors');
  });

  it('fails closed for a pre-orientation ScrollBox snapshot', () => {
    const scroll = widget({
      name: 'LegacyScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      child_count: 1,
      x: 100,
      y: 100,
      width: 500,
      height: 400,
    });
    const row = widget({
      name: 'LegacyOffscreenRow',
      parent: 'LegacyScroll',
      x: 2100,
      y: 1200,
      width: 500,
      height: 200,
    });
    const result = validateUiSnapshot(snapshot([rootPanel, scroll, row]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_outside_screen').map((f) => f.widget)).toContain('LegacyOffscreenRow');
    expect(findingsFor(result, 'ui_child_exceeds_parent').map((f) => f.widget)).toContain('LegacyOffscreenRow');
  });

  it('fails closed when a current ScrollBox fact omits its required orientation', () => {
    const scroll = widget({
      name: 'MalformedScroll',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: true,
      child_count: 1,
      x: 100,
      y: 100,
      width: 500,
      height: 400,
    });
    const row = widget({
      name: 'MalformedOffscreenRow',
      parent: 'MalformedScroll',
      x: 2100,
      y: 1200,
      width: 500,
      height: 200,
    });
    const result = validateUiSnapshot(snapshot([rootPanel, scroll, row]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_outside_screen').map((f) => f.widget)).toContain('MalformedOffscreenRow');
    expect(findingsFor(result, 'ui_child_exceeds_parent').map((f) => f.widget)).toContain('MalformedOffscreenRow');
  });

  it('honours an explicit non-ScrollBox identity over a misleading legacy class name', () => {
    const notScroll = widget({
      name: 'ContradictoryPanel',
      class: 'ScrollBox',
      parent: 'Root',
      is_panel: true,
      is_scroll_box: false,
      scroll_orientation: 'Vertical',
      child_count: 1,
      x: 100,
      y: 100,
      width: 500,
      height: 400,
    });
    const row = widget({
      name: 'ContradictoryOffscreenRow',
      parent: 'ContradictoryPanel',
      x: 100,
      y: 1200,
      width: 500,
      height: 200,
    });
    const result = validateUiSnapshot(snapshot([rootPanel, notScroll, row]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_outside_screen').map((f) => f.widget)).toContain('ContradictoryOffscreenRow');
    expect(findingsFor(result, 'ui_child_exceeds_parent').map((f) => f.widget)).toContain(
      'ContradictoryOffscreenRow',
    );
  });
});

describe('overlap', () => {
  it('reports overlapping siblings and names the ambiguity when z-order ties', () => {
    const a = widget({
      name: 'Label',
      x: 100,
      y: 100,
      width: 200,
      height: 40,
      z_order: 0,
      text_info: { text: 'Health', font_size: 24 },
    });
    const b = widget({ name: 'Icon', class: 'Image', x: 250, y: 110, width: 100, height: 20, z_order: 0 });
    const result = validateUiSnapshot(snapshot([rootPanel, a, b]), { strictness: 'relaxed' });
    const found = findingsFor(result, 'ui_widgets_overlap');
    expect(found).toHaveLength(1);
    expect(found[0]!.hint).toContain('decided by child order');
  });

  it('treats stacking inside an Overlay as intentional', () => {
    const overlay = widget({ name: 'Stack', class: 'Overlay', parent: 'Root', is_panel: true, child_count: 2 });
    const a = widget({ name: 'Label', parent: 'Stack', x: 100, y: 100, width: 200, height: 40 });
    const b = widget({ name: 'Badge', parent: 'Stack', x: 120, y: 100, width: 100, height: 40 });
    const result = validateUiSnapshot(snapshot([rootPanel, overlay, a, b]), { strictness: 'relaxed' });
    expect(findingsFor(result, 'ui_widgets_overlap')).toHaveLength(0);
  });
});

describe('focus and input', () => {
  it('reports an interactive widget that visibility makes unclickable', () => {
    const button = widget({
      name: 'PlayButton',
      class: 'Button',
      is_interactive: true,
      is_focusable: true,
      visibility: 'ESlateVisibility::HitTestInvisible',
      width: 200,
      height: 60,
    });
    const result = validateUiSnapshot(snapshot([rootPanel, button]), { strictness: 'relaxed' });
    expect(findingsFor(result, 'ui_interactive_hit_test_invisible')).toHaveLength(1);
  });

  it('reports a screen where gamepad focus has nowhere to land', () => {
    const button = widget({
      name: 'PlayButton',
      class: 'Button',
      is_interactive: true,
      is_focusable: false,
      width: 200,
      height: 60,
    });
    const result = validateUiSnapshot(snapshot([rootPanel, button]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_no_focusable_widget')).toHaveLength(1);
  });
});

describe('contrast', () => {
  it('computes WCAG ratios correctly', () => {
    // Black on white is the canonical 21:1.
    expect(contrastRatio([0, 0, 0, 1], [1, 1, 1, 1])).toBeCloseTo(21, 5);
    expect(contrastRatio([1, 1, 1, 1], [1, 1, 1, 1])).toBeCloseTo(1, 5);
  });

  it('flags low-contrast text over an opaque background', () => {
    const panel = widget({
      name: 'Card',
      class: 'Border',
      parent: 'Root',
      is_panel: true,
      child_count: 1,
      brush_info: { tint: [0.5, 0.5, 0.5, 1] },
    });
    const label = widget({
      name: 'Caption',
      parent: 'Card',
      text_info: { text: 'Hello', font_size: 20, color: [0.6, 0.6, 0.6, 1] },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, panel, label]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_text_contrast_below_minimum')).toHaveLength(1);
  });

  it('skips contrast when the background brush has a texture', () => {
    // A tint over art is a multiplier, not a colour. Reading the default
    // [1,1,1,1] tint as "white" is how a live HUD reported 1.1:1 against a
    // background that is actually a dark panel texture.
    const panel = widget({
      name: 'Card',
      class: 'Border',
      parent: 'Root',
      is_panel: true,
      child_count: 1,
      brush_info: { tint: [1, 1, 1, 1], has_resource: true, resource: '/Game/UI/T_DarkPanel' },
    });
    const label = widget({
      name: 'Caption',
      parent: 'Card',
      text_info: { text: 'Hello', font_size: 20, color: [1, 0.9, 0.61, 1] },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, panel, label]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_text_contrast_below_minimum')).toHaveLength(0);
  });

  it('skips contrast when the backdrop is translucent and therefore unknown', () => {
    const panel = widget({
      name: 'Card',
      class: 'Border',
      parent: 'Root',
      is_panel: true,
      child_count: 1,
      brush_info: { tint: [0.5, 0.5, 0.5, 0.4] },
    });
    const label = widget({
      name: 'Caption',
      parent: 'Card',
      text_info: { text: 'Hello', font_size: 20, color: [0.6, 0.6, 0.6, 1] },
    });
    const result = validateUiSnapshot(snapshot([rootPanel, panel, label]), { strictness: 'standard' });
    expect(findingsFor(result, 'ui_text_contrast_below_minimum')).toHaveLength(0);
  });
});

describe('strictness and configuration', () => {
  it('raising strictness only ever adds findings', () => {
    const widgets = [
      rootPanel,
      widget({ name: 'TextBlock_12', x: 101, y: 103, text_info: { text: 'Hi', font_size: 20 } }),
      widget({ name: 'Panel_3', class: 'VerticalBox', is_panel: true, child_count: 1 }),
    ];
    const snap = snapshot(widgets);
    const relaxed = validateUiSnapshot(snap, { strictness: 'relaxed' }).findings.map((f) => f.ruleId);
    const standard = validateUiSnapshot(snap, { strictness: 'standard' }).findings.map((f) => f.ruleId);
    const strict = validateUiSnapshot(snap, { strictness: 'strict' }).findings.map((f) => f.ruleId);

    for (const id of relaxed) expect(standard).toContain(id);
    for (const id of standard) expect(strict).toContain(id);
    expect(strict.length).toBeGreaterThan(relaxed.length);
  });

  it('honours the persisted per-category strictness', () => {
    setStrictness('strict', 'ui');
    const widgets = [rootPanel, widget({ name: 'TextBlock_12', text_info: { text: 'Hi', font_size: 20 } })];
    const result = validateUiSnapshot(snapshot(widgets));
    expect(result.strictness).toBe('strict');
    expect(findingsFor(result, 'ui_default_widget_name')).toHaveLength(1);
  });

  it('respects a disabled rule and reports it as disabled rather than passing', () => {
    setRuleDisabled('ui_font_too_small', true);
    const label = widget({ name: 'Tiny', text_info: { text: 'x', font_size: 4 } });
    const result = validateUiSnapshot(snapshot([rootPanel, label]), { platform: 'console' });
    expect(findingsFor(result, 'ui_font_too_small')).toHaveLength(0);
    expect(result.rules_disabled).toContain('ui_font_too_small');
  });
});

describe('missing layout is reported, never assumed to pass', () => {
  it('skips geometry rules and lists them when the layout could not be resolved', () => {
    const label = widget({ name: 'Label', laid_out: false });
    const result = validateUiSnapshot(
      snapshot([rootPanel, label], { layout_resolved: false, layout_error: 'needs compiling' }),
      { strictness: 'standard' },
    );
    expect(result.layout_resolved).toBe(false);
    expect(result.layout_error).toBe('needs compiling');
    expect(result.rules_skipped_no_layout).toContain('ui_text_overflows_box');
    expect(result.rules_skipped_no_layout).toContain('ui_interactive_targets_touch');
    // Non-geometry rules still run.
    expect(result.rules_evaluated).toBeGreaterThan(0);
  });
});

describe('catalogue integrity', () => {
  it('has unique rule ids', () => {
    const ids = UI_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every rule id is namespaced to the ui category', () => {
    for (const r of UI_RULES) {
      expect(r.id.startsWith('ui_')).toBe(true);
      expect(r.category).toBe('ui');
    }
  });

  it('no rule throws on an empty snapshot', () => {
    const result = validateUiSnapshot(snapshot([]), { strictness: 'strict' });
    const threw = result.findings.filter((f) => f.hint.includes('threw'));
    expect(threw).toHaveLength(0);
  });

  it('no rule throws on a snapshot with a cyclic parent reference', () => {
    // Defensive: a malformed snapshot must not hang or crash the pass.
    const a = widget({ name: 'A', parent: 'B', is_panel: true, child_count: 1 });
    const b = widget({ name: 'B', parent: 'A', is_panel: true, child_count: 1 });
    const result = validateUiSnapshot(snapshot([a, b]), { strictness: 'strict' });
    expect(result.findings.filter((f) => f.hint.includes('threw'))).toHaveLength(0);
  });
});

describe('engine default font', () => {
  // From field use: the most-repeated authoring mistake on record. Invisible
  // until rendered, and a session hit it five separate times.
  const roboto = (over: Record<string, unknown> = {}) =>
    widget({
      name: 'Label',
      parent: 'Root',
      text_info: { text: 'Persephone', font_object: '/Engine/EngineFonts/Roboto', typeface: 'Bold', ...over },
    });

  it('flags an engine font even at the most relaxed setting', () => {
    const r = validateUiSnapshot(snapshot([rootPanel, roboto()]), { strictness: 'relaxed' });
    expect(findingsFor(r, 'ui_engine_default_font')).toHaveLength(1);
  });

  it('names the font and the typeface, so the fix is obvious', () => {
    const r = validateUiSnapshot(snapshot([rootPanel, roboto()]), { strictness: 'relaxed' });
    const f = findingsFor(r, 'ui_engine_default_font')[0]!;
    expect(f.message).toContain('/Engine/EngineFonts/Roboto');
    expect(f.message).toContain('Bold');
    expect(f.data).toMatchObject({ font_object: '/Engine/EngineFonts/Roboto', typeface: 'Bold' });
  });

  it('calls out the Bold default only when the typeface is actually Bold', () => {
    const bold = validateUiSnapshot(snapshot([rootPanel, roboto()]), { strictness: 'relaxed' });
    expect(findingsFor(bold, 'ui_engine_default_font')[0]!.hint).toContain('Bold');
    const regular = validateUiSnapshot(snapshot([rootPanel, roboto({ typeface: 'Regular' })]), {
      strictness: 'relaxed',
    });
    expect(findingsFor(regular, 'ui_engine_default_font')[0]!.hint).not.toContain('reads as emphasis');
  });

  it('warns that a partial ui_set_text_style leaves the font in place', () => {
    // The compounding half of the bug: passing size/colour without font_asset
    // keeps the engine font AND still reports success.
    const r = validateUiSnapshot(snapshot([rootPanel, roboto()]), { strictness: 'relaxed' });
    expect(findingsFor(r, 'ui_engine_default_font')[0]!.hint).toMatch(/font_asset AND typeface/);
  });

  it('leaves a project font alone', () => {
    const r = validateUiSnapshot(
      snapshot([rootPanel, roboto({ font_object: '/Game/UI/Fonts/F_AphrosiaBody', typeface: 'Regular' })]),
      { strictness: 'strict' },
    );
    expect(findingsFor(r, 'ui_engine_default_font')).toHaveLength(0);
  });

  it('says nothing when the font is unknown, rather than guessing', () => {
    const r = validateUiSnapshot(snapshot([rootPanel, roboto({ font_object: undefined })]), { strictness: 'strict' });
    expect(findingsFor(r, 'ui_engine_default_font')).toHaveLength(0);
  });
});
