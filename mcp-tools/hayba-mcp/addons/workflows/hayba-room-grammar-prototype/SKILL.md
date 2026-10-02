---
name: hayba-room-grammar-prototype
description: Use when prototyping repeatable room or set-piece variations from explicit grammar rules and checking their placement constraints.
metadata:
  category: procedural-design
  tags: grammar, rooms, constraints, variation
---

# Prototype one room grammar

## When to use

Use for a bounded room family with defined entrance, exit, functional zones, required clearances, and variation count. State the maximum placed objects or instances, repetition tolerance, and platform budget if supplied. Separate fixed hero elements from generated filler before authoring rules.

## Tool routing

- Read plumb_production_list and plumb_constraint_list for existing rules and guards. Use plumb_production_define to add one seed-to-layout rule with explicit emitted shells, assets, or symbols. Call get_tool_signature for the exact rule schema rather than inventing an operation.
- Expand a small set of seeds with plumb_grammar_expand and inspect every PlacementPlan. Dry-run expansion skips geometry-dependent constraints, so a successful dry run is a syntax and rule-choice check only. Reject plans that violate the stated exit, clearance, instance, or repetition limits before placing them.
- If the plan is applied to an authorized scene through the project's world authoring path, run plumb_validate on resulting instances and inspect scene_export plus editor_capture_viewport. Resolve hard failures and record soft costs. Route any PCGEx graph implementation through the node-selection and output-audit workflows.
- If applying the plan changed persistent map content, save the exact active map with level_save, inspect saved, dirty, and verified status, and re-read scene_export for the placed instances. A dry run needs no map save. If persistence is uncertain, mark the placement unsaved and route it to hayba-world-save-integrity.

## Evidence

Report rule identifiers, seeds, accepted/rejected variants and reasons, placement counts, validation verdicts, visual captures, and budgets measured. A PlacementPlan is not a spawned room; skipped geometric guards and unloaded-world costs remain unknown until applied and observed.
