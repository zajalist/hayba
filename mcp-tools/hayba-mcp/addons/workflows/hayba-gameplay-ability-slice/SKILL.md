---
name: hayba-gameplay-ability-slice
description: Use when creating a small Gameplay Ability System ability or effect and checking its asset, actor prerequisites, and runtime activation path.
metadata:
  category: gameplay
  tags: gas, abilities, effects, activation
---

# Build a bounded GAS slice

## When to use

Use for one ability or attribute effect with an activation trigger and expected state change. Identify the target actor, Ability System Component, authority context, and the effect's duration and magnitude. Define the expected runtime observation before creating assets.

## Tool routing

- Check project_list_plugins and get_tool_signature. GAS commands live in an optional satellite plugin; an unknown command can mean that plugin is unavailable. Inspect an existing ability with blueprint_get_info before creating a duplicate.
- Use gas_create_ability and gas_create_effect only for the assets the slice needs. A newly created ability is empty. Use blueprint_inspect_graph, then blueprint_add_node and blueprint_connect_nodes only for confirmed classes and pins, followed by blueprint_compile for actual behavior; never claim the create call wired activation. Read back effect settings with asset_get_info.
- gas_grant_ability and gas_apply_effect can check actor prerequisites in the editor world, but editor grants are not runtime grants. Save compiled assets with asset_save. Verify the real activation path in a configured PIE scenario with editor_get_state, editor_start_pie, editor_pie_actor_inspect, and editor_stop_pie. Do not start a new PIE session when a user session is running.
- Treat an editor-world grant or effect as a probe unless a persistent placed-actor change is explicitly accepted. For an accepted map change, read back that actor, save the exact active map with level_save, inspect saved, dirty, and verified status, and re-read it. If persistence is uncertain, mark the editor change unsaved and route it to hayba-world-save-integrity.

## Evidence

List asset paths, component and plugin presence, compile diagnostics, effect policy, editor-world probe result, and the actual PIE activation/attribute observation. If no runtime grant or input path exists, report the slice as incomplete instead of treating asset creation or an editor-world application as gameplay proof.
