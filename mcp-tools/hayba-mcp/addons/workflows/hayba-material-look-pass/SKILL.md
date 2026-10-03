---
name: hayba-material-look-pass
description: Use when adjusting an existing Unreal material or instance to match a stated visual target, with graph checks and same-view comparison.
metadata:
  category: assets
  tags: material, look, shader, validation
---

# Material look pass

## When to use

Use for a specific surface whose roughness, color, response, or readability needs improvement. Gather the intended lighting context and preserve any shared master material used by other assets.

## Tool routing

- Inspect the target with `material_get_info` and capture its current appearance using `editor_capture_viewport`. If a material instance already exposes the right parameter, prefer `material_set_param` over editing the shared graph.
- When graph work is needed, inspect exact nodes and outputs before a small edit. Run `material_validate` before `material_compile`; then capture again under the same lighting and camera. Do not infer that compilation means the visual target was met.
- If the target affects many assets, list impacted references with `asset_get_referencers` before changing a shared source.

## Evidence

Record the material path, parameters or graph nodes changed, validation and compile result, impacted assets, and same-view before/after captures. Stop after one focused look pass and a correction pass; ask for a design choice when two looks both satisfy the brief.
