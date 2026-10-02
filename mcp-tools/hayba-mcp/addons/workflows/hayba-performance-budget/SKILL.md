---
name: hayba-performance-budget
description: Use when measuring an Unreal level against explicit frame, draw-call, memory, or streaming budgets before choosing an optimization.
metadata:
  category: optimization
  tags: frame-time, draw-calls, memory, streaming
---

# Measure a level budget

## When to use

Use for a reported slowdown or an explicit target platform budget. Record resolution, quality settings, map, camera path, and PIE/editor state. Without a stated target, establish a baseline and avoid inventing a pass threshold.

## Tool routing

- Read `editor_get_performance_stats` under repeatable conditions. Use `scene_export` to locate concentrations of actors and `wp_get_cells` for streaming distributions. `editor_stream_log` can expose relevant load or render warnings.
- Choose a hypothesis that matches the measured bottleneck. Instance consolidation helps repeated mesh draw calls but can harm culling granularity; reducing foliage density may help GPU or overdraw but changes art direction. Material and texture work should be routed to their focused tools after identifying the asset.
- Change one factor, then measure again from the same camera and settings. Use `validator_run` after scene edits and `editor_capture_viewport` to catch visual regression.
- If the accepted optimization changed the map, save its exact active path with `level_save`, inspect saved, dirty, and verified status, and read back the changed actors or foliage before reporting the measured improvement. If persistence is uncertain, mark the optimization unsaved and route it to hayba-world-save-integrity.

## Evidence

Provide baseline, target, changed factor, after values, and visual/validator findings. Compare like for like. Stop if the tool reports only aggregate metrics that cannot identify the suspected cause; request a narrower profiling run instead of claiming an optimization.
