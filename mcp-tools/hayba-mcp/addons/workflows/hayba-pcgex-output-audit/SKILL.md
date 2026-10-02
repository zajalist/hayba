---
name: hayba-pcgex-output-audit
description: Use when a PCG or PCGEx graph claims success but the actual generated instances, placement, or freshness remain uncertain.
metadata:
  category: pcg
  tags: pcgex, cook, instances, verification
---

# Audit generated PCG output

## When to use

Use after graph creation, edit, or regeneration, especially when a tool reports success while the viewport looks empty. Establish the target actor/component and expected output type.

## Tool routing

- Read the graph and run `hayba_validate_pcg_graph` for structural faults. This does not establish output quantity or correctness.
- Prefer `pcg_cook_and_wait` for a bound actor expected to produce instances. Inspect its per-mesh instance counts and freshness data. `hayba_execute_pcg_graph` or `pcg_execute_graph` only establishes that execution was triggered. `pcg_read_node_output` may read a stale inspection cache and cannot disprove fresh instance output.
- Capture with `editor_capture_viewport`, inspect representative positions, and run `validator_run` after scene generation.
- When this audit accepts a cook that changed persistent map content, save the exact active map with `level_save`, inspect saved, dirty, and verified status, then re-read the bound actor and generated counts. If it was only an inspection, state that no map save was needed. If persistence remains uncertain, mark the generated result unsaved and route it to hayba-world-save-integrity.

## Evidence

Report graph path, target component, expected output, fresh counts by mesh, viewport observation, and validation findings. A zero count fails an instance-generation goal. A nonzero count does not establish visual composition or frame-time safety; route those questions to the relevant skill. Do not retry a cook without checking whether a prior call already changed the scene.
