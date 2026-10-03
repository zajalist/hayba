---
name: hayba-asset-import-vetting
description: Use when bringing a supported external asset into Unreal and proving its source, import result, dependencies, quality, and save state.
metadata:
  category: assets
  tags: import, provenance, validation, dependencies
---

# Vet one imported asset

## When to use

Use for a specific mesh, texture, or audio source that the project is allowed to use. Record source provenance and license outside the editor, intended package path, asset type, target platform, and an agreed triangle, texture, or audio budget. Do not infer usage rights from a successful download or import.

## Tool routing

- Check asset_search and asset_get_info for a collision at the destination. Inspect the source with asset_get_source_path where an asset already exists. Use get_tool_signature before asset_import: that importer accepts one supported file from its connector cache under a bounded policy and refuses overwrite; it is not a general arbitrary-file sanitizer.
- Import once with asset_import. Inspect the returned exact asset path, class, save state, and warnings before any retry. A dirty in-memory result needs asset_save. Re-query that exact path with asset_get_info and use asset_validate plus asset_get_dependencies to find missing references.
- For a mesh, run mesh_audit and inspect LOD/UV/material facts. For a texture, run texture_audit and texture_get_info. Compare the result with the stated platform budget; route further tuning to the matching focused skill. Use asset_get_referencers before replacing or moving an existing asset.

## Evidence

Return source and license evidence, exact package path and class, import warnings, validation findings, dependencies, saved status, and relevant quality measurements. An importer success does not prove a remote file is safe to parse, that the asset is visually suitable, or that it fits runtime memory. If source trust or rights are unresolved, stop before importing it into the editor.
