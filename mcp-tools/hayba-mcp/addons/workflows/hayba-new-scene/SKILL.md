---
name: hayba-new-scene
description: Use when creating a new Unreal scene from a brief, including spatial structure, asset choices, a first playable area, and observed validation.
metadata:
  category: world-composition
  tags: scene, blockout, environment, composition
---

# New scene from a brief

## When to use

Use this for a new level or a major empty area. Ask for the intended player experience, references the user already has, target platform, scale, and any hard budgets. Unknown constraints stay unknown. A reference board can be user-provided images or written examples; do not claim an automatic moodboard or CLIP score.

## Tool routing

- Check `hayba_check_ue_status` and `editor_get_state` before changing the editor. For a new map, use `level_create` with a deliberate name and package path; it creates an asset but does not open it. Confirm the created path with `level_list`, account for unsaved work in the current map, then use `level_load` on that exact path. Verify the active map with `level_get_info` and `editor_get_state` before placing anything. For an existing level, read `scene_export` and `wp_get_cells` when World Partition is active. Keep existing user-authored work visible in the plan.
- Sketch traversal, landmarks, sightlines, and a small pilot zone before filling cells. Use `hayba_asset_search` to choose project assets; `actor_spawn_from_asset` places content assets, while `world_generate` can produce a repeatable broad field around an area actor. For a PCG graph, load the separate hayba-pcg-build skill.
- Compare a hand-authored composition, PCG, and a hybrid where scale justifies the choice. Keep hero placement separate from any regenerated field.
- Inspect the pilot with `editor_capture_viewport` and `scene_validate_physics`. After a scene mutation, run `validator_run` and read its findings before expanding the pattern.
- When the pilot is accepted, call `level_save` with the exact active-map path as a guard. Check saved, dirty, and verified readback, then re-read the pilot actors with `actor_list` or `scene_export`. If persistence is uncertain, report the level as unsaved and route it to hayba-world-save-integrity before handoff.

## Evidence

Deliver a zone plan, the active map path, its create/load and save results, the asset paths and generation method actually used, a fixed-view capture, placement findings, and observed counts where available. Cap the first pass at one pilot zone and two visual revisions; ask for a design decision when competing compositions remain plausible. A clean validator run proves only the checks it performed, so report visual and gameplay judgments separately.
