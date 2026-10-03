---
name: hayba-traversal-playtest
description: Use when checking a noncombat route for reachable waypoints, readable exits, obstacles, and loading behavior during actual play.
metadata:
  category: world-composition
  tags: traversal, route, collision, pie
---

# Walk one player route

## When to use

Use for a defined start-to-goal path after geometry or terrain changes. Record the player movement mode, intended waypoints, maximum detour, and which landmarks should be visible. Include the target platform's streaming or frame budget only if supplied.

## Tool routing

- Read scene_export and actor_list to identify route geometry and goal actors. Run placement_validate and scene_validate_physics around suspected blockages. Capture the route entrance with editor_capture_viewport before touching actors.
- Check editor_get_state, start editor_start_pie, and replay a bounded movement sequence with editor_pie_press_key or repeated editor_pie_axis frames. Use editor_pie_actor_list to locate the runtime goal and editor_pie_screenshot at each waypoint; a screenshot request needs a later readiness check. Use editor_pie_sightlines only for sampled collision visibility, not walkability. Always finish with editor_stop_pie if this workflow started the session.
- If a confirmed obstacle blocks the intended route, change only that actor with actor_transform, then repeat the same path and validators. Route streaming uncertainty to the World Partition workflow.
- For an accepted obstacle edit, read the actor with actor_inspect, save the exact active map through level_save, inspect saved, dirty, and verified status, and re-read the actor. If persistence is uncertain, mark the fix unsaved and route it to hayba-world-save-integrity.

## Evidence

Report waypoints reached, input path, screenshots, obstruction identity, before/after placement findings, and any load or collision warnings. A clear visibility trace or actor presence does not prove navigation or comfortable movement. Mark untraversed branches and subjective readability for manual playtest.
