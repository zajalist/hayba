---
name: hayba-material-instance-variants
description: Use when creating a small family of material instances from one parent while preserving parameter consistency and scene readability.
metadata:
  category: assets
  tags: material-instances, parameters, variants, reuse
---

# Build a controlled material variant set

## When to use

Use when the same parent material needs a few deliberate surface variants for gameplay or art direction. Define their use cases, allowed parameter ranges, texture budget, and naming before creating assets. Prefer an existing instance when it already represents the intended surface.

## Tool routing

- Inspect the parent and existing instances through material_get_info and material_list. Read actual exposed parameter names and types. Use material_create_instance for each missing variant, then material_set_param only for confirmed scalar, vector, or texture parameters. Re-read material_get_info after each change.
- Make a test copy with asset_duplicate, then apply a candidate with mesh_set_material_slot to that copied StaticMesh. The setter saves the mesh asset and changes its shared material slot. Compare editor_capture_viewport from the same camera under representative lighting. Use material_validate on the parent graph and asset_validate on the instance; save accepted material instances with asset_save.
- Check asset_get_referencers before modifying or replacing an instance used elsewhere. A texture substitution can alter memory and streaming, so route large texture changes to the texture budget workflow rather than assuming a cheap variant.

## Evidence

Report parent and variant paths, parameters and readback, representative captures, validation warnings, affected referencers, and any measured budget. A different color swatch does not prove the material reads correctly across all lighting or meets runtime shader cost.
