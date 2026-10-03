---
name: hayba-texture-memory-pass
description: Use when trimming texture cost for a target platform while checking format, mip policy, streaming, and visible detail.
metadata:
  category: optimization
  tags: textures, memory, mips, streaming
---

# Tune one texture group

## When to use

Use for a named texture or small group identified by an audit, not an indiscriminate project-wide resize. Record target platform, viewing distance, texel-density need, source resolution, material usage, and a real memory or package-size target if one exists.

## Tool routing

- Read texture_audit and texture_get_info for dimensions, source/platform format, mip count, compression, LOD group, and streaming settings. Check asset_get_referencers to understand which materials and maps will change. Do not equate source bytes or dimensions with measured resident GPU memory.
- Choose one change: compression for content type, mip policy or maximum size for distance, or streaming behavior for residency. Use get_tool_signature and texture_set_settings or texture_set_compression. These tools can re-import the resource; wait_for_shaders if compilation is pending, then re-read texture_get_info and asset_validate.
- Save with asset_save after the desired settings read back. Compare editor_capture_viewport at the same close and normal play distances, and editor_get_performance_stats under matching conditions if a runtime budget motivated the work.

## Evidence

Report source/platform format, before/after settings, visible detail at each distance, affected referencers, warnings, and measured performance or memory only where a real measurement exists. A smaller source texture or estimated audit size is not proof of lower peak GPU memory across the whole level.
