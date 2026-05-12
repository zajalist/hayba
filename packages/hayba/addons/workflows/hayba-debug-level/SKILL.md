---
name: hayba-debug-level
description: Use when a level has performance, physics, or layout problems — combines editor_stream_log, scene_validate_physics, and scene_export hierarchical mode to find issues.
---

# hayba-debug-level

## Workflow

1. `editor_get_performance_stats` — baseline FPS / draw calls / memory.
2. `editor_stream_log` filtered by `LogStreaming|LogPhysics|LogPCG` — start tail.
3. `scene_validate_physics` (no deep check first).
4. `scene_export` mode "hierarchical" — look for over-dense cells.
5. For floating actors: `actor_transform` to snap to ground (use `placement_validate` first).
6. For interpenetration: `actor_transform` or `actor_set_visibility` based on context.
7. For perf hotspots: check `wp_get_cells` for heavy cells; consider ISM consolidation opportunities (`ism_*`).
