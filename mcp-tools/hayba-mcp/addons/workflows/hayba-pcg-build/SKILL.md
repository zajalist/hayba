---
name: hayba-pcg-build
description: Use when the user wants to build a PCG/PCGEx graph — guides through node selection, validation, and execution.
---

# hayba-pcg-build

## Workflow

1. `pcg_list_node_classes` → discover available nodes.
2. For each candidate, `pcg_get_node_details` → confirm pin types.
3. Sketch graph as JSON.
4. `pcg_validate_graph` — must pass all 5 layers before creation.
5. `pcg_create_graph` from validated JSON.
6. `pcg_execute_graph` on a target component.
7. `pcg_read_node_output` to verify generated data.
