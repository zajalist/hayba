---
name: hayba-refine-scene
description: Use when improving the composition or look of an existing Unreal scene through focused edits and observed before-and-after evidence.
metadata:
  category: set-dressing
  tags: composition, lighting, materials, iteration
---

# Refine an existing scene

## When to use

Use when the user identifies a scene that feels weak, cluttered, unreadable, or unlike a supplied reference. Establish the intended focal point and viewing position. Treat changes made by the user since the last inspection as deliberate until checked.

## Tool routing

- Capture a baseline with `editor_capture_viewport`; read `scene_export` in relational or hierarchical mode and `actor_list` to understand what occupies the frame.
- Pick one visible issue and one reversible change per pass. `actor_transform` can improve silhouette or sightline; `material_get_info` and `material_set_param` can adjust an existing instance; `foliage_paint_at` applies only when additional foliage is actually needed. Inspect the exact signature before mutating.
- Compare another capture from the same camera and lighting state. Run `scene_validate_physics` and `validator_run` after placements. Stop after three focused passes or when another change no longer clearly improves the stated goal.
- Persist accepted actor or foliage edits with `level_save` for the exact active map; check saved, dirty, and verified status and re-read the affected actors or foliage. Persist an accepted material-instance change with `asset_save` and re-read it through `material_get_info`. If map persistence is uncertain, mark the scene edit unsaved and route it to hayba-world-save-integrity.

## Evidence

Report the before/after captures, the specific assets or actors changed, validation findings, and which judgments remain visual opinions. No score is inferred from image similarity alone; any numeric target must come from an actually available measurement or a user-specified criterion.
