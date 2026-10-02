---
name: hayba-debug-level
description: Use when an Unreal level has placement, streaming, physics, or performance symptoms that need a measured diagnosis and verified fix.
metadata:
  category: qa
  tags: debugging, physics, streaming, performance
---

# Diagnose a level symptom

## When to use

Use for a concrete symptom such as floating objects, overlaps, missing generated content, low frame rate, or a streaming gap. Record the camera, active map, and reproduction steps so a later readback is comparable.

## Tool routing

- Start with `hayba_check_ue_status`. Gather a baseline through `editor_get_performance_stats`, `editor_stream_log`, and `scene_export` in hierarchical mode. Use `wp_get_cells` when World Partition is relevant.
- For placement symptoms, run `scene_validate_physics`; inspect affected actors with `actor_list` and `placement_validate` before considering `actor_transform` or `actor_set_visibility`. A position that looks unusual may be an intentional user adjustment.
- For generated content, use the hayba-pcg-build skill and a fresh cook readback. For performance, change one suspected cause at a time, then repeat the same measurement conditions.
- For an accepted map repair, read back the changed actor or generated output, call `level_save` for the exact active map, and inspect saved, dirty, and verified status. If persistence cannot be checked safely, report the repair as unsaved and route it to hayba-world-save-integrity.

## Evidence

Give the original symptom, baseline values or findings, the smallest confirmed cause, the edit made, and the after measurement. Run `validator_run` after scene edits. If measurements are unavailable, leave the diagnosis as a hypothesis rather than calling the level fixed.
