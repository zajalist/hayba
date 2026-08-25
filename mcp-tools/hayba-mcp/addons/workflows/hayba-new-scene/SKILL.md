---
name: hayba-new-scene
description: Use when the user asks to generate a new scene from scratch — coordinates visual intent → spatial planning → asset placement → physics validation → visual review.
---

# hayba-new-scene

## Workflow

1. Write the visual intent down first: look, era, mood, key materials, time of day.
   Three or four concrete sentences. Everything below is judged against this,
   so a vague brief here produces an unjudgeable scene later.
2. Restate the brief as the zones you expect to see, before touching the level.
3. Call `level_get_spatial_index` to get the level cognitive map (cells + cluster labels).
4. Plan biome zones top-down: assign each World Partition cell a target cluster label.
5. For each zone: call `pcg_create_graph` (terrain) → `pcg_execute_graph` → `foliage_paint_at`.
6. Dress hero areas: `actor_spawn` from Content Browser assets matched by `asset_search`.
7. Call `scene_validate_physics` (with `deep_check: false` first; only `true` for hero shots).
8. Call `editor_capture_viewport` and describe what the image actually shows,
   point by point, against the intent from step 1.
9. Where the image does not match the intent, invoke `hayba-refine-scene`.

## Important

- Always start with the moodboard. Do not place assets before establishing references.
- Use `scene_export` mode "relational"; do not use "flat" unless explicitly asked.
- Record every spatial decision to memory with a clear `intent` string.
