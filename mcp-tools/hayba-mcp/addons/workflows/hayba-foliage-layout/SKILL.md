---
name: hayba-foliage-layout
description: Use when planning and painting foliage in an Unreal level while preserving routes, focal areas, and a measurable density budget.
metadata:
  category: set-dressing
  tags: foliage, density, biome, performance
---

# Lay out foliage

## When to use

Use for a bounded region with known ground and a visual goal. Identify traversable space, sightlines, and no-scatter zones first. Ask for a density or performance target if one matters; otherwise treat density as a trial parameter.

## Tool routing

- Inspect the region with `scene_export`, `foliage_list_types`, and `editor_capture_viewport`. Select only available foliage assets or request a suitable asset choice.
- Use `foliage_paint_at` for a controlled patch. A PCG graph is a better choice when the area must regenerate by seed, cover many cells, or express repeated spatial rules.
- Read back the scene and capture the same camera. Run `scene_validate_physics` and `validator_run` for scene effects, then compare `editor_get_performance_stats` under the same editor conditions if a performance budget was supplied.
- After accepting the patch, save the exact active map through `level_save`, inspect saved, dirty, and verified status, then re-read the foliage type/count and scene with `foliage_list_types` and `scene_export`. If the save or external actor coverage is uncertain, mark the patch unsaved and route it to hayba-world-save-integrity.

## Evidence

Record the region, asset types, intended and observed density, visible route clearance, and measured frame/draw-call change if available. A successful paint response does not prove the intended coverage; inspect the result. Stop after one pilot patch before expanding across the level.
