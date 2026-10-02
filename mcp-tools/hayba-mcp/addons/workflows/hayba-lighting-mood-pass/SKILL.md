---
name: hayba-lighting-mood-pass
description: Use when shaping an Unreal area with lights, exposure, and post process while checking readability and performance from fixed cameras.
metadata:
  category: lighting
  tags: mood, exposure, readability, performance
---

# Shape one lighting look

## When to use

Use for a bounded area with a visual target, gameplay readability requirement, and fixed comparison cameras. Record the intended time of day, color hierarchy, target display settings, and any frame-time budget. Do not invent a lighting score from a screenshot.

## Tool routing

- Probe lighting_capability_probe, then read light_list, light_get, postprocess_list_volumes, and postprocess_get. Capture the same camera and viewport mode with editor_capture_viewport before edits. Decide whether a light move/intensity, exposure adjustment, or post-process change addresses the observed issue; avoid stacking all three at once.
- Prefer light_set, exposure_set, and postprocess_set for existing actors. Use light_spawn or postprocess_spawn_volume only when the scene lacks the required source. Inspect setter readbacks and unchanged keys; a requested field that did not apply remains open. For an accepted look, save the exact active map with level_save, inspect saved, dirty, and verified status, then re-read the changed lights or volumes. If persistence is uncertain, mark the lighting edit unsaved and route it to hayba-world-save-integrity.
- Capture the identical views again and check editor_get_performance_stats under the same settings. Keep a readable player route and focal subject at both bright and dark extremes. Route material contrast faults to a material pass rather than compensating with indiscriminate light intensity.

## Evidence

Report camera settings, before/after captures, changed actors and applied properties, warnings, readability judgment, and measured frame data against a stated budget. An editor still does not prove exposure adaptation, motion, display calibration, or a production performance verdict; test those in representative gameplay when required.
