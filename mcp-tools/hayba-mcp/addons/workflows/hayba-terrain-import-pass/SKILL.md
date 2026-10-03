---
name: hayba-terrain-import-pass
description: Use when importing or auditing a heightmap landscape and checking scale, layers, material, collision, and streaming implications.
metadata:
  category: terrain
  tags: landscape, heightmap, scale, layers
---

# Import one terrain tile or bounded landscape

## When to use

Use when a prepared heightmap must become a playable Unreal landscape. Record source resolution, height encoding, horizontal and vertical scale, target world bounds, intended paint layers, and memory/streaming budget. Work in an authorized scratch map first when scale or source data is uncertain.

## Tool routing

- Read landscape_list and landscape_inspect to avoid duplicate terrain and establish the existing material, layout, bounds, and scale. Verify the source format and exact signature before landscape_import. That importer is the callable C++ route; the Python landscape readers do not sculpt or paint height data.
- Import once, then re-query with landscape_list and landscape_inspect. Check component layout and bounds against the plan, run landscape_layer_list and landscape_get_material, and set a confirmed material with landscape_set_material if needed. Use landscape_set_lod_settings only against a stated view-distance or performance target.
- Run scene_validate_physics and validator_run, capture an overview with editor_capture_viewport, and save the exact active map with level_save. Inspect saved, dirty, and verified status, then re-read landscape_list and landscape_inspect for the imported terrain. If import or persistence is uncertain, inspect the world before another import, mark the terrain unsaved, and route it to hayba-world-save-integrity; repeated creation can duplicate large terrain.

## Evidence

Report source dimensions and scale, resulting landscape identity and bounds, layer/material readback, collision findings, save state, warnings, and observed visual seams. Imported geometry alone does not prove walkability, visual quality, runtime streaming, or target-platform memory; test those separately.
