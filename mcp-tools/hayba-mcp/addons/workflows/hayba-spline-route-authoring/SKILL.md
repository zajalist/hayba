---
name: hayba-spline-route-authoring
description: Use when authoring a road, path, fence, or cable guide as a spline and checking its geometry before downstream generation.
metadata:
  category: world-composition
  tags: spline, route, geometry, generation
---

# Author one spline guide

## When to use

Use for a defined start, end, and major bends. Record intended width or clearance, maximum grade and turn severity if supplied, and the downstream consumer, such as a road mesh or PCG spline sampler. A spline curve alone does not create a playable road.

## Tool routing

- Inspect scene_export and actor_list for an existing route. Read spline_get_info before changing a known spline. Use spline_create only if a new guide is needed, then spline_add_point for the minimum control points. Adjust an existing indexed point with spline_set_point after re-reading point order.
- Re-read spline_get_info for count, positions, and total length. Capture an overhead and player-height view with editor_capture_viewport. Run placement_validate and scene_validate_physics around likely intersections; these checks concern placed actors, not the curve's final generated mesh.
- If the spline will feed PCG or PCGEx, pass its verified points to the PCG build workflow and inspect the installed node/pin contract there. Use a separate road-mesh or gameplay traversal pass for width, collision, and slope; do not infer them from spline length.
- Once the authored route is accepted, save the exact active map with level_save, inspect saved, dirty, and verified status, then re-read spline_get_info for its points and length. If persistence is uncertain, mark the route unsaved and route it to hayba-world-save-integrity.

## Evidence

Report spline identity, control points, length, before/after views, intended consumer, and intersection findings. Mark generated geometry, player clearance, and streaming cost unverified until the downstream system is built and tested.
