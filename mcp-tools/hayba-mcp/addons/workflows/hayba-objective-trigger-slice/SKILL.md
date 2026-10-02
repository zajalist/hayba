---
name: hayba-objective-trigger-slice
description: Use when adding one project-defined objective trigger and verifying its event wiring, state change, and player-facing response.
metadata:
  category: gameplay
  tags: objectives, triggers, blueprint, verification
---

# Wire one objective trigger

## When to use

Use for one event such as entering an area or interacting with an item. Identify the project's existing objective owner and state model, the trigger actor, the exact state transition, and what the player should see or hear. Hayba has no generic quest system, so do not invent one when the project has no owner.

## Tool routing

- Inspect the existing Blueprint with blueprint_get_info and blueprint_inspect_graph, and find the trigger actor with actor_find. Confirm the component/event signature through get_tool_signature. For a supported overlap or interaction, use blueprint_add_bound_event or blueprint_add_custom_event, then blueprint_add_variable, blueprint_add_node, and blueprint_connect_nodes only after reading exact node GUIDs and pin names.
- Compile with blueprint_compile and read every error and warning. A failed compile leaves the old generated class in place. Save the intended asset with asset_save after the graph reads back. Use ui_bind_property or ui_bind_event only if the project already exposes objective UI; a widget binding is not a quest state store.
- Check editor_get_state before starting editor_start_pie. Trigger the event once and observe the relevant actor state through editor_pie_actor_inspect or editor_pie_assert and the visible response through editor_pie_widget_tree. Stop with editor_stop_pie. If the state is not exposed to these tools, use a project test or manual Blueprint debugger.

## Evidence

Report the state owner, trigger component, event and data pins, compile diagnostics, saved asset, input action, runtime state, and player-facing response. Event wiring alone does not prove an objective completes, persists, or avoids duplicate activation.
