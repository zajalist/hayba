---
name: hayba-controller-focus-audit
description: Use when a menu works with a mouse but gamepad or keyboard focus, activation, or back navigation may fail.
metadata:
  category: ui
  tags: gamepad, focus, navigation, accessibility
---

# Audit one controller menu path

## When to use

Use for a defined menu route: initial focus, next/previous controls, activate, and back. State target platform, input device, expected focus order, and minimum readable or touch target size where applicable.

## Tool routing

- Read ui_get_widget_info and ui_layout_snapshot, then run ui_validate. Resolve focus, contrast, overlap, and small-target findings at their named widgets. A skipped geometry rule remains open. Use ui_set_widget_properties or ui_set_slot_layout only after inspecting the exact affected widget, then compile and revalidate.
- Check editor_get_state, start editor_start_pie, inspect editor_pie_widget_tree, and send each gamepad or keyboard step through editor_pie_press_key. Its press-and-release mode returns before the release tick; observe the next frame instead of assuming a completed action. Capture editor_pie_screenshot at each focus transition and activation. Stop with editor_stop_pie after this workflow's session.
- If live focus identity is not exposed in the widget tree or screenshot, verify it in Unreal's widget reflector or by a human using a controller. Do not infer focus from an OnClicked binding or a mouse click.

## Evidence

Report expected and observed focus sequence, activation/back result, captures, compile and validation findings, and input-device gaps. Passing static focus rules does not prove navigation works in the running game, especially after dynamic elements appear.
