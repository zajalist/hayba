---
name: hayba-combat-encounter
description: Use when blocking out one combat encounter around cover, enemy positions, sightlines, player route, and a measurable runtime budget.
metadata:
  category: gameplay
  tags: encounter, cover, sightlines, pacing
---

# Block out one combat encounter

## When to use

Use for one room or arena with a defined entry, objective, exit, enemy count, and target difficulty. State the expected player path, minimum cover choices, maximum simultaneous threats, and any frame or actor-count caps supplied for the target platform. Keep unknown limits explicitly unknown.

## Tool routing

- Read scene_export and actor_list to map existing geometry, spawns, cover, and exits. Capture entry and combat views with editor_capture_viewport. Choose a layout based on approach visibility, flank routes, and escape space, then change only the identified actors with actor_transform or actor_spawn_from_asset.
- Run placement_validate and scene_validate_physics after edits. Check editor_get_state before starting editor_start_pie. Use editor_pie_actor_list to confirm runtime spawns and editor_pie_sightlines for selected eye-to-target collision traces. Always call editor_stop_pie after a session this workflow started; do not take over a user's running session.
- Measure the same encounter path with editor_get_performance_stats when a budget is supplied. If a repeated dressing field dominates the count, consider a targeted PCG workflow, but keep cover and spawn ownership explicit.
- After accepting cover or spawn changes, re-read the affected actors with actor_inspect, save the exact active map with level_save, and check saved, dirty, and verified status. Re-read the encounter actors after saving; if persistence is uncertain, mark the layout unsaved and route it to hayba-world-save-integrity.

## Evidence

Report before/after layout, actor identities, cover and route observations, PIE spawn count, sampled sightline results, validation findings, and measured budget comparison. A clear collision trace does not prove visible rendering, navigation, tactical fairness, or AI decision quality. Those need a playtest or Unreal navigation/AI debugger observation.
