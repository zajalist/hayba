---
name: hayba-mesh-lod-pass
description: Use when adjusting static-mesh LOD thresholds or reduction for a measured scene cost while preserving silhouette and material behavior.
metadata:
  category: optimization
  tags: mesh, lod, triangles, silhouette
---

# Tune one mesh LOD family

## When to use

Use when a repeated mesh contributes to a measured cost at known camera distances. Record target platform, screen resolution, existing triangle counts, intended switch distances, and acceptable silhouette error. Establish the scene baseline before modifying the asset.

## Tool routing

- Read mesh_get_info, mesh_get_lods, and mesh_audit. Identify every LOD's UV and material state. Use asset_get_referencers to understand affected levels and world_budget_snapshot for loaded use count; unknown unloaded coverage remains unknown.
- Use get_tool_signature and mesh_set_lod for one threshold or reduction change at a time. This tool rebuilds the mesh and refuses a zero-UV LOD to protect the editor. Treat that refusal as an asset repair task, not a reason to retry with another value. Save the changed asset with asset_save after readback.
- Capture near and far views with editor_capture_viewport under the same camera settings. Compare editor_get_performance_stats in the same scene and quality mode, then run asset_validate. If the mesh is heavily instanced, test culling and pop at representative movement speeds in PIE.

## Evidence

Report each available LOD triangle count and screen size before and after, affected referencers, visual transition, validator findings, warnings, and measured scene change. Some engine builds expose only LOD count, leaving per-LOD triangles unknown. Triangle reduction by itself does not establish a frame-time or memory win.
