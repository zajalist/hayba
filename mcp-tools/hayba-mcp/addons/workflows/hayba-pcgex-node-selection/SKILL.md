---
name: hayba-pcgex-node-selection
description: Use when choosing PCGEx nodes and pins for a specific graph operation, especially when documentation and installed plugin versions may differ.
metadata:
  category: pcg
  tags: pcgex, nodes, pins, discovery
---

# Select PCGEx nodes from evidence

## When to use

Use when a graph needs a path, cluster, filter, scatter, or other specialized operation and the exact node class is uncertain. Describe the required input and output data before searching.

## Tool routing

- Search intent with `hayba_search_node_catalog`. `hayba_query_pcgex_docs` provides task-oriented documentation; `hayba_get_pattern_template` offers a starting topology. These are candidate sources, not proof of installed classes.
- Confirm a candidate with `hayba_get_node_details` and, in the target editor, `pcg_list_node_classes` plus `pcg_get_node_details`. Use `hayba_compatible_pins` to narrow downstream choices. If a graph already exists, inspect its actual dynamic pins with `pcg_list_pins`.
- Prefer native PCG when its simpler node covers the requirement. Record the PCGEx dependency when choosing a specialized node. Never guess a pin label from a screenshot or a different plugin version.

## Evidence

Return a small candidate table: class, intended role, observed pins, version/source confidence, and rejection reason for alternatives. Stop before mutation if the installed node or required pin cannot be confirmed; carry that as an explicit gap into hayba-pcg-build.
