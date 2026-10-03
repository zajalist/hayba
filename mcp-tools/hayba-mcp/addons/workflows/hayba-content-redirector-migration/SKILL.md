---
name: hayba-content-redirector-migration
description: Use when moving or renaming a small set of Unreal assets while preserving references and cleaning the resulting redirectors.
metadata:
  category: assets
  tags: references, redirectors, migration, validation
---

# Move one asset family safely

## When to use

Use for a named asset or small family with an agreed new folder or name. Record the source and destination paths, ownership, dependent maps and assets, and why the move is needed. Do not sweep unrelated project folders or rename during an active content edit by someone else.

## Tool routing

- Inspect exact source and destination with asset_get_info and asset_search. Read asset_get_referencers and asset_get_dependencies before moving so the expected reference graph is known. Stop if the destination collides or a critical referencer cannot be inspected.
- Use asset_rename for an in-place name correction and asset_move for a folder change. After each bounded move, re-query both paths and affected referencers. These operations leave redirectors; run asset_fix_redirectors for the intended folder only after dependent packages can be updated.
- Validate the moved asset with asset_validate and its project references with content_validate. If a referencer is read-only or failed to update, keep the redirector and report it rather than deleting it manually. Run a focused cook check when the move affects a shipping map.

## Evidence

Report old and new paths, referencers before and after, redirector count fixed, validation or cook findings, and any remaining redirector. A successful move reply does not prove every unloaded map or external package has been rewritten.
