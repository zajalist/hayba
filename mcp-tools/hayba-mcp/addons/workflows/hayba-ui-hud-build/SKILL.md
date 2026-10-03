---
name: hayba-ui-hud-build
description: Use when building a focused Unreal HUD widget and verifying its hierarchy, layout, text, focus, compile state, and PIE display.
metadata:
  category: ui
  tags: hud, widgets, layout, focus
---

# Build one HUD screen

## When to use

Use for one gameplay HUD or small screen with known player decisions: what must be read, what can be acted on, and which platform and viewport sizes matter. Identify long and localized text examples, controller focus order, and an update-frequency budget for dynamic elements.

## Tool routing

- Search ui_list_widget_blueprints and inspect a candidate with ui_get_widget_info. Use ui_create_widget only for a new screen. Build a small hierarchy with ui_add_element or ui_build_tree; the latter can keep a partial subtree on failure, so inspect ui_query before retrying. Use ui_set_slot_layout and focused property tools for geometry, rather than guessing canvas coordinates.
- Check ui_measure_text with ordinary and long strings. Use ui_layout_snapshot and ui_render_widget_to_png at each target viewport. Run ui_validate for text overflow, safe area, touch targets, contrast, focus, and performance findings. Resolve each returned warning or document why the remaining condition is intentional; skipped geometry checks are open, not passing.
- Compile with ui_compile_widget, inspect warnings, then persist with ui_save_widget. If a real gameplay HUD is required, check editor_get_state, start editor_start_pie, inspect editor_pie_widget_tree and a screenshot, and stop with editor_stop_pie. Leave an existing user session alone.

## Evidence

Report widget path, hierarchy, target sizes, rendered captures, text/focus findings, compile and save state, PIE display, and every unresolved or skipped validation rule. A good static preview does not establish live data binding or controller navigation.
