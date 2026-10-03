---
name: hayba-world-composition
description: Use when organizing an existing Unreal level into readable routes, landmarks, vistas, and streaming cells before adding detail.
metadata:
  category: world-composition
  tags: layout, traversal, sightlines, streaming
---

# Compose an existing world

## When to use

Use after a level exists but its spatial hierarchy or player route needs work. Establish player start, intended route, focal landmarks, scale, and the camera positions that matter. Decide which places need authored control and which can tolerate repeatable generation.

## Tool routing

- Read `scene_export` in relational or hierarchical mode and `wp_get_cells` where World Partition is active. `actor_list` helps resolve exact actor identities before any move.
- Capture at least one route view with `editor_capture_viewport`. Map foreground, middle distance, destination, and occluders. State where the route is ambiguous, where a landmark is hidden, and where detail competes with a focal point.
- Propose the smallest layout change. Use `actor_transform` only for an identified actor whose position is confirmed to be editable; use the hayba-hero-set-dressing skill for localized asset changes and hayba-pcg-build for repeatable fields.
- After accepting a map edit, read the changed actor with `actor_inspect`, save the exact active map through `level_save`, and inspect saved, dirty, and verified status. Re-read its transform after saving. If the save cannot be verified, mark the composition unsaved and route it to hayba-world-save-integrity.

## Evidence

Record the before/after route view, affected cells and actors, and a short explanation of how the edit changes navigation or hierarchy. Run `validator_run` after scene changes. A viewport image supports a composition judgment; it does not establish player comprehension, so mark that for a PIE walkthrough if needed.
