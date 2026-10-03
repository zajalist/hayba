---
name: hayba-localization-layout-stress
description: Use when a widget must survive long translated strings and different viewport sizes without clipping or losing usable controls.
metadata:
  category: ui
  tags: localization, typography, overflow, layout
---

# Stress a localized screen layout

## When to use

Use for a named screen with real translated strings or a clearly labeled expansion sample. Record target locales, font assets and glyph needs, viewport sizes, and input methods. This is a layout verification workflow; it does not translate copy or author localization tables.

## Tool routing

- Inspect the widget with ui_get_widget_info and ui_query. Feed representative short, long, and multiline strings to ui_measure_text. Use ui_layout_snapshot and ui_render_widget_to_png at each target size. If geometry is unresolved, compile with ui_compile_widget before treating any layout measurement as valid.
- Run ui_validate per platform and strictness. Follow each overflow, safe-area, contrast, or focus finding to the named widget. Adjust only the confirmed text style or slot via ui_set_text_style and ui_set_slot_layout, then remeasure and rerender. Save through ui_save_widget after compilation and read back the saved state.
- For text entered at runtime, check editor_get_state, start editor_start_pie, inspect editor_pie_widget_tree, and capture editor_pie_screenshot. Stop with editor_stop_pie after a session this workflow started. If the project does not expose locale switching to Hayba, change locale through its normal Unreal or game setting and record that manual step.

## Evidence

Report locale or expansion sample, string lengths, viewport sizes, measured versus available width, rendered captures, validator findings and skipped rules, and actual runtime text. A pseudolocalized fit does not prove translation accuracy, glyph coverage, line-break quality, or right-to-left behavior.
