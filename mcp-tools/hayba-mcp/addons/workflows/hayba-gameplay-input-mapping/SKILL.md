---
name: hayba-gameplay-input-mapping
description: Use when adding or auditing a gameplay input action and mapping, then checking that the intended control works in PIE.
metadata:
  category: gameplay
  tags: input, controls, pie, interaction
---

# Gameplay input mapping

## When to use

Use for a named player action with a known device and intended context. Establish whether the game already has an action and mapping; duplicate bindings can produce confusing behavior.

## Tool routing

- Inspect the project's current input setup through `project_get_info` and relevant signatures from `get_tool_signature`. Use `input_create_action`, `input_create_mapping`, and `input_add_mapping` only for missing elements. These are legacy UE commands, so check their accepted fields before calling them through `hayba_invoke`.
- Read `field:unresolved_classes` from the mapping response. If any requested modifier or trigger class did not resolve, correct it before testing; a binding can exist while its modifier is absent. Call `asset_save` with the exact returned action and mapping asset paths and inspect the per-asset failed list before opening PIE.
- Check `editor_get_state` first. If this workflow starts `editor_start_pie`, trigger the control with `editor_pie_press_key`, inspect `editor_stream_log` and game behavior, then always call `editor_stop_pie` even if the test fails. Do not stop a PIE session that was already running. A saved mapping alone does not prove it was applied to the active player context.
- If the action requires gameplay logic that the current tool surface cannot author, report that gap and leave the mapping as an incomplete integration rather than claiming a working mechanic.

## Evidence

Report action asset, mapping context, device/key, unresolved modifier/trigger classes, per-asset save result, PIE trigger, observed result, and any conflict or missing logic. Limit this pass to one action and its associated binding set; expand only after the control is observed in game.
