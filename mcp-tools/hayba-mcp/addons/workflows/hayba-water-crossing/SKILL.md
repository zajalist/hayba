---
name: hayba-water-crossing
description: Use when placing a river or lake beside a playable crossing and checking Water plugin state, spline or zone setup, and traversal evidence.
metadata:
  category: water
  tags: river, crossing, zones, traversal
---

# Build one water crossing

## When to use

Use for one crossing where water shape, bank height, bridge or ford clearance, and player route are defined. Record target width, depth impression, landscape interaction, and platform budget. Decide whether a visual-only water body is sufficient before adding waves or complex geometry.

## Tool routing

- Call water_check_plugin first. If Water is disabled or its classes are absent, stop and report the prerequisite; do not fabricate a body with a generic actor spawn. Read water_body_list and water_body_inspect for existing bodies and water_zone_inspect for coverage.
- For a new river, use get_tool_signature and the dry-run path of water_body_river_create before spawning. Inspect its spline-applied flag and warnings; a spawned actor with unapplied spline points is not a river matching the route. Add or adjust a Water Zone with water_zone_create only when needed and verify its bounds.
- Run water_validate for missing zones, bodies outside coverage, and wave configuration. Inspect the body again, capture the banks with editor_capture_viewport, and use scene_validate_physics for placement conflicts. A representative PIE traversal or manual playtest must confirm collision and crossing readability; water validation alone cannot.
- After accepting a persistent water body or zone, save the exact active map with level_save, inspect saved, dirty, and verified status, then re-read water_body_inspect and water_zone_inspect. If persistence is uncertain, mark the crossing unsaved and route it to hayba-world-save-integrity.

## Evidence

Report plugin status, body and zone identities, intended versus observed spline points and bounds, validation findings, crossing view, traversal observation, and warnings. Treat deferred per-point river width, depth, or velocity metadata as unresolved rather than assuming the requested values applied.
