---
name: hayba-ui-data-binding
description: Use when a Widget Blueprint displays a changing gameplay value or reacts to a control and the binding needs compile and PIE proof.
metadata:
  category: ui
  tags: binding, events, dynamic-data, pie
---

# Verify one live widget binding

## When to use

Use for one named widget property or button event with a known data owner, update event, and expected visual response. Record the refresh frequency and performance budget if the value changes often. Establish whether the project already has a variable or event before adding one.

## Tool routing

- Inspect ui_get_widget_info and ui_query, then expose the exact child with ui_set_variable if the graph must reach it. Use ui_bind_property for supported text, tooltip, visibility, or enabled-state binding. For a control action, compile first, use ui_bind_event to get the event node, inspect exact pins with blueprint_inspect_graph, and connect the behavior through blueprint_connect_nodes.
- Compile with ui_compile_widget and inspect errors and warnings. Run ui_validate and ui_layout_snapshot; repair any new overflow or focus issue created by the live value. Save with ui_save_widget after the binding reads back correctly.
- Check editor_get_state, start editor_start_pie, change the source value through the game's supported interaction, and observe editor_pie_widget_tree plus editor_pie_screenshot. Stop with editor_stop_pie. If the data owner is not exposed, use a project test or manual Blueprint debugger rather than claiming the widget updated.

## Evidence

Report widget and source variable, event or property bound, compile state, validator findings, initial and changed runtime text/state, and remaining gaps. A successful binding call does not prove live source data, event execution, or an acceptable per-frame cost.
