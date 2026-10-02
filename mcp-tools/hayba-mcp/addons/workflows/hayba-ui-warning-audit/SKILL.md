---
name: hayba-ui-warning-audit
description: Use when auditing an Unreal widget for layout, clipping, text, and validation warnings before calling the UI finished.
metadata:
  category: ui
  tags: widgets, warnings, layout, typography
---

# Audit widget warnings

## When to use

Use when a widget exists and the user wants a quality pass or reports a clipped, overlapping, or hard-to-read element. Identify the widget asset and intended viewport sizes.

## Tool routing

- Read hierarchy and properties with `ui_get_widget_info` and `ui_query`. Run `ui_validate`; keep each returned warning tied to its widget path and the condition that produced it.
- Use `ui_layout_snapshot` for geometry and `ui_render_widget_to_png` for visual evidence. `ui_measure_text` helps test representative, long, and localized strings against available space.
- Fix one warning class at a time with the focused widget setters discovered through `hayba_search_tools`. Re-run the relevant readback and validation. Do not silence a warning through visibility changes unless the intended UI state truly hides that element.

## Evidence

Deliver a warning table with severity, widget, before state, fix, after state, and unresolved items. Test at the target viewport sizes. A zero-warning validator result does not establish controller usability or visual hierarchy; state those as separate checks.
