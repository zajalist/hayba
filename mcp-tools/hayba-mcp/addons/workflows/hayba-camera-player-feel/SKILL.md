---
name: hayba-camera-player-feel
description: Use when a playable camera feels too close, slow, occluded, or unstable and a repeatable input path can test a focused adjustment.
metadata:
  category: gameplay
  tags: camera, controls, framing, feel
---

# Tune one player camera symptom

## When to use

Use for a specific camera symptom at named locations and actions, such as a wall occluding the player on a turn. Record target field of view, target platform and input device, tolerance for occlusion, and the exact movement path. Player feel requires observation; a property value alone cannot settle it.

## Tool routing

- Inspect the pawn with actor_get_components and the identified camera or spring-arm component with object_get_property. Capture the starting view and actor positions. Use input mapping inspection if the reported symptom may be a control mapping issue.
- If a component property is confirmed by reflection, change one value with object_set_property on its exact object path, then read it back. Prefer this bounded reflected setter to a freeform script; do not guess a camera property name. If the camera logic is project-specific Blueprint code, inspect with blueprint_inspect_graph and use focused Blueprint tools only where exact nodes and pins are known.
- Check editor_get_state, start editor_start_pie, replay the same keyboard or gamepad steps with editor_pie_press_key and frame-by-frame editor_pie_axis, and capture editor_pie_screenshot at the problem points. Poll the screenshot request until the file exists. Stop with editor_stop_pie; leave an existing user PIE session alone.
- If the accepted setting changed a placed actor, save the exact active map with level_save, inspect saved, dirty, and verified status, then re-read the component property. If it changed a Blueprint asset, use asset_save and read back that asset instead. If map persistence is uncertain, mark the camera edit unsaved and route it to hayba-world-save-integrity.

## Evidence

Report the component and changed property, readback, before/after frames at identical actions, observed occlusion and responsiveness, and unresolved warnings. PIE axis input applies for one frame, so repeat it for a sustained turn. A still frame or editor camera move does not prove tracking smoothness, motion comfort, or controller feel; those require viewed playback and player testing.
