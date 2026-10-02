---
name: hayba-ai-behavior-tree
description: Use when authoring or repairing an Unreal Behavior Tree branch and checking its blackboard contract, execution order, and observed AI behavior.
metadata:
  category: gameplay
  tags: ai, behavior-tree, blackboard, testing
---

# Build one AI behavior branch

## When to use

Use for one bounded patrol, chase, or fallback branch in an existing Behavior Tree. Identify the pawn, controller, blackboard asset and keys, expected branch priority, and one observable runtime outcome before editing. Establish the target platform's concurrent AI count and frame budget if performance is part of the request; leave them unknown when no target exists.

## Tool routing

- Read bt_get_info first. It returns the current graph, blackboard keys, and stable node identifiers. Compare the requested behavior with existing branches before adding a duplicate. Use get_tool_signature for exact node classes and parameters.
- Add the minimum composite/task/decorator set with bt_add_node, root first. Use bt_connect to set the intended parent; sibling order is execution order for selectors and sequences. Compile with bt_compile, then address every warning that affects the branch. A tree can compile without a useful blackboard binding.
- Save with asset_save only after the graph and blackboard references read back correctly. If a relevant PIE scenario exists, check editor_get_state, start editor_start_pie, inspect the intended actor through editor_pie_actor_list and editor_pie_actor_inspect, and always finish with editor_stop_pie. Leave an already running user PIE session alone.

## Evidence

Report the tree path, key names, node order, compile errors and warnings, saved state, and the actor behavior actually observed. A compile pass establishes graph validity, not that AI perception, navigation, or branch timing works. If the tools cannot expose the needed runtime blackboard value, request a manual Unreal debugger observation and leave that condition unverified.
