---
name: hayba-pcg-build
description: Use when planning, building, or reviewing PCG/PCGEx content in Unreal; choose the production method, ground PCGEx choices in documentation and live editor facts, then verify the cooked result.
metadata:
  category: pcg
  tags: pcgex, graphs, generation, verification
---

# Hayba PCG build

## When to use

Use for a new or existing PCG/PCGEx graph when the result must be repeatable and verified in a real editor. The production method is still a choice to make from the scene requirements.

## Decide before authoring

1. State the desired scene outcome and its constraints: target platform, frame-time and memory budgets, streaming boundaries, instance and draw-call expectations, texel density, deterministic regeneration, edit frequency, and designer override needs. Record unknown budgets as unknown; do not invent a pass/fail threshold.
2. Compare viable methods before choosing a graph. Include manual/Actor Palette placement or reusable composed assets, native PCG, PCGEx, and a hybrid where relevant. Manual composition gives precise art direction but costs placement and maintenance time. Native PCG supports repeatable broad distribution with fewer dependencies but may need bespoke graph logic. PCGEx offers specialized graph, cluster, path, and staging operations but adds a plugin/version dependency and more graph complexity. A hybrid can reserve hero assets and exceptions for manual control while generating the repeatable field, at the cost of a clear ownership boundary. For each candidate, note streaming and regeneration costs, correction workflow, and why it fits or fails this scene.
3. Look for a relevant standard production pattern when evidence is available, then propose at least one structural alternative, such as changing route, visibility, or asset grouping rather than only tuning density. Label analogies as design hypotheses until tested in this project.

## Tool routing

### Ground the graph

4. If PCGEx is a candidate, call `hayba_query_pcgex_docs` for the task concepts and candidate classes, then `hayba_get_pcgex_knowledge_detail` for exact IDs. Record the bundle generation date, documented plugin version, source hash/stale flag, and any warnings or conditions. Treat `placeableInPcgGraph` as a documentation classification, not proof that the node is installed. The bundle is optional; an unavailable result is an evidence gap, not permission to guess pins or settings.
5. Use `hayba_get_pattern_template` only as an annotated starting point. Its preflight is catalog-only and can report absent or unknown pins. In the target scratch editor, use `pcg_list_node_classes` and `pcg_get_node_details` to confirm loaded settings classes, default pins/types, and properties. Compare the installed PCGEx `.uplugin` version with the documented version. Resolve a mismatch from live reflection or defer the uncertain connection; never silently convert a documentation pin into a wire.
6. Sketch the graph as JSON with explicit asset/component ownership. Use `pcg_validate_graph` and resolve its errors before `pcg_create_graph`. Before wiring a created node, use `pcg_list_pins` on that graph to check its exact current labels and types, including dynamic pins. A validator pass is only a structural check; it does not establish that the graph produces the intended scene or meets performance budgets.

## Cook and verify

7. Build in a scratch project or other explicitly authorized target under Hayba's write/lease/plan safety gates. Bind the graph to the intended component. Prefer `pcg_cook_and_wait` for a bound actor when instance output is expected: it regenerates, waits, and returns post-cook `result.ism[]` mesh/count readback and `freshness`. `pcg_execute_graph` only reports how many components were triggered; it does not prove placement. `pcg_read_node_output` can be a stale same-frame cache and is not sufficient proof of a fresh cook.
8. Check the actual result in the viewport and inspect representative generated data, exceptions, and regeneration behavior. Record instance counts by mesh, the measured budgets available in the project, and any remaining unknowns. A zero-instance result fails an instance-generating task; a nonempty result still does not prove art direction, streaming behavior, frame time, memory, or texel density. If an asynchronous PCG idle timeout accompanies nonempty instance output, inspect the tool's idle note and freshness field instead of treating the timeout alone as proof of success or failure.
9. Revisit the method choice if visual quality or budgets fail. Keep generated and hand-authored ownership explicit so a re-cook does not erase deliberate set dressing.
10. If the accepted build changed a bound actor or generated map content, save the exact active map through `level_save`, inspect saved, dirty, and verified status, and re-read the bound actor and generated counts. Save an authored graph asset with `asset_save` when it is dirty, then re-read its graph details. If map persistence or external actor coverage is uncertain, mark the scene unsaved and route it to hayba-world-save-integrity.

## Evidence

Report the inspected node classes and pins, validation result, fresh post-cook instance counts, capture, measured budgets, remaining warnings, and what still needs human review.
