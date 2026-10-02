---
name: hayba-weather-visibility-pass
description: Use when fog, sky, or daylight makes a player route or landmark hard to read and visibility must be checked at fixed distances.
metadata:
  category: lighting
  tags: fog, sky, visibility, landmarks
---

# Tune weather visibility on one route

## When to use

Use for a specific weather or time-of-day state and named landmarks at near, mid, and far distances. Record the intended mood, minimum readable distance, target display settings, and any frame budget. This is a visibility pass, not a general lighting redesign.

## Tool routing

- Probe lighting_capability_probe and inspect existing sky, sun, and fog actors with actor_list and light_list. Capture fixed near/mid/far views with editor_capture_viewport. Use sky_setup only when the scene lacks the triad; it spawns up to three actors and may partially succeed, so inspect every spawned path and warning before any retry.
- Tune one confirmed fog actor with fog_configure and check changed versus unchanged keys. Adjust a confirmed light with light_set or exposure with exposure_set only if the measured visibility problem requires it. Re-capture identical views. For an accepted look, save the exact active map through level_save, inspect saved, dirty, and verified status, then re-read the changed sky, fog, or light actor. If persistence is uncertain, mark the visibility edit unsaved and route it to hayba-world-save-integrity.
- Compare editor_get_performance_stats under identical viewport settings when volumetric fog is involved. Inspect the route in PIE for moving-player readability. A collision sightline is not a rendered-fog visibility measurement.

## Evidence

Report weather state, actor paths, applied settings, near/mid/far landmark observations, performance measurements, and unresolved warnings. A viewport still cannot prove temporal stability, accessibility for all displays, or target-platform cost.
