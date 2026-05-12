---
name: hayba-new-scene
description: Use when the user asks to generate a new scene from scratch — coordinates moodboard → references → spatial planning → asset placement → physics validation → CLIP scoring.
---

# hayba-new-scene

## Workflow

1. Call `hayba_generate_moodboard` with the scene brief — get 3-5 reference embeddings.
2. Call `hayba_fetch_references` for any specific keywords — extend reference set.
3. Call `level_get_spatial_index` to get the level cognitive map (cells + cluster labels).
4. Plan biome zones top-down: assign each World Partition cell a target cluster label.
5. For each zone: call `pcg_create_graph` (terrain) → `pcg_execute_graph` → `foliage_paint_at`.
6. Dress hero areas: `actor_spawn` from Content Browser assets matched by `asset_search`.
7. Call `scene_validate_physics` (with `deep_check: false` first; only `true` for hero shots).
8. Call `editor_capture_viewport` + `hayba_compare_clip_score` against moodboard refs.
9. If score < 0.65, invoke `hayba-refine-scene`.

## Important

- Always start with the moodboard. Do not place assets before establishing references.
- Use `scene_export` mode "relational"; do not use "flat" unless explicitly asked.
- Record every spatial decision to memory with a clear `intent` string.
