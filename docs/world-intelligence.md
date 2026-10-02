# World intelligence

**Status: design direction with read-only building blocks in development.** Hayba exposes scene and asset inspection tools. The complete composition and production reasoning loop described here is planned work; it is not a shipped end-to-end feature.

The development branch can count currently loaded actors and ISM/HISM instances with `world_budget_snapshot`, capture bounded whole-editor PIE timing and memory proxies with `editor_pie_capture_start` / `editor_pie_capture_get`, and compare caller-supplied records with `world_compare_snapshots`. Structural deltas and cap headroom require complete, matching loaded-world scans; PIE proxy deltas require compatible, complete captures and full samples for each compared metric. The [PIE collision sightline probe](PIE-sightlines.md) adds bounded approach-route evidence. None of these tools measures rendered visibility, actual streaming residency, GPU cost, NPC AI cost, texel density, or a production performance verdict. A comparison protocol is declared by the caller; Hayba cannot verify that two captures used the same hardware, route, build, and editor conditions.

The development World panel now has a read-only, three-dimensional surface-splat preview of **loaded, CPU-accessible static mesh geometry**. It samples mesh render triangles, including a bounded subset of ISM/HISM transforms, and shows the result in a full-width canvas. Each point references an authored source node and a computed spatial cluster; the on-demand explorer follows either hierarchy. The read-only `world_semantic_snapshot` tool exposes the same evidence to an agent through an overview and bounded pages of nodes, clusters, memberships, or point rows. Its `scan_id` lets a caller reject pages from a changed scan. Both surfaces report truncation and unsupported sources. Their neutral colors are shape proxies: they do not reconstruct materials, sample landscape or skeletal mesh surfaces, include unloaded World Partition cells, or inspect generated PCG output. The cluster bounds come from sampled points, not the full mesh geometry. This model helps locate and inspect a loaded scene; it does not produce a composition or performance verdict.

An Unreal world can contain thousands of actors, instances, procedural outputs, and streaming cells. A flat inventory answers *what exists* but leaves the harder question open: *how does this world work as a scene?* The World layer is intended to help an agent read composition, compare interventions, and make a production-aware edit with evidence.

## What World is for

World is the shared scene model behind the in-editor view and agent inspection. Its first job is to locate a meaningful part of a loaded scene and explain what evidence supports that location. The 3D splats are a sparse spatial index sampled from real mesh surfaces, not an attempt to replace the Unreal viewport with a photorealistic reconstruction. More points do not create more understanding. A useful sample identifies its source and can lead to the relevant authored object, spatial neighborhood, tags, and coverage gaps.

Two hierarchies should coexist. The **authored hierarchy** is a fact from Unreal: level, Outliner folder, actor, component, and instance. The **spatial hierarchy** groups nearby sampled surfaces into coarse and fine regions; its boundaries are computed from each scan and should not be described as persistent designer-authored areas. A splat refers to both. Metadata belongs in source and cluster records, so it can be queried without repeating long strings thousands of times in the renderer. Unreal tags remain authored tags; a cluster can summarize those tags only as a union of its sources. Labels such as “route,” “market,” or “focal point” require a separate inference with evidence and confidence. A cluster's proximity alone cannot establish its gameplay meaning.

The in-editor World view should let someone move from the whole scene to a region and then a source, revealing detail on demand. An agent needs a compact read-only form of the same model so it can search and reason without interpreting a screenshot. Neither view can infer streaming, NPC load, memory, frame time, material appearance, or visibility from mesh samples alone; those require the specific measurements in the working loop below.

## The working loop

```mermaid
flowchart LR
    A[Brief and constraints] --> B[Discover the world]
    B --> C[Build a composition model]
    C --> D[Generate alternatives]
    D --> E[Measure and score]
    E --> F[Choose tools and plan]
    F --> G[Guarded edit]
    G --> H[Verify in the editor]
    H -->|new evidence| C
```

The loop begins with an explicit brief: intended player experience, target platforms, camera and movement constraints, production mode, and budgets. It should stop when essential information is missing, a safety gate refuses the edit, or measured results fall outside the accepted range.

## See composition, not just objects

The world model should preserve Unreal's actual structure: folders, attachments, instanced static meshes, PCG output, levels, World Partition cells, Data Layers, and authored groups. It should also infer useful design relationships such as approach routes, thresholds between spaces, focal points, occluders, repeated motifs, and areas of visual density. An inferred relationship must stay distinguishable from an editor fact.

No single view is sufficient. Indoor and outdoor scenes call for different evidence, and the route through analysis should depend on the task. Possible evidence includes hierarchy and bounds, navigation and sightline queries, streaming-cell footprints, runtime traces, performance captures, and selected viewport images. Images help when visual judgment is required; they are one input to the model, not the whole model.

## Compare viable approaches

Before authoring, Hayba should inventory the tools available in the project and document when each is appropriate. For example:

| Approach | Strong fit | Cost to check |
| --- | --- | --- |
| Hand-placed hero assets | Deliberate focal moments and interaction-critical geometry | Authoring time, draw calls, maintenance |
| Reusable composed sets | Repeated spaces such as stalls, rooms, or street modules | Variation, pivot/attachment quality, instance strategy |
| PCG graphs | Rules-driven distribution and broad iteration | Graph cost, generated-instance control, debugging |
| Hybrid authoring | Procedural coverage with hand-authored landmarks | Boundary between generated and owned content |

The agent should look for a standard production pattern when one applies, then consider alternatives that fit the game's particular constraints. It should explain why it chose a method and what would make that choice wrong.

## Budget the result

A candidate scene should be tested against explicit hard constraints before aesthetic scoring. Depending on the project, those may include frame time, memory, streaming latency, draw calls, instance counts, texture and texel-density targets, shader cost, navmesh and NPC cost, and platform-specific limits. Budgets must specify hardware, camera path, time window, and acceptable headroom; a number without that context is weak evidence.

The comparison should then score feasible options on measurable and reviewable criteria: path legibility, focal visibility, scene hierarchy, variation, occlusion, traversal, and production cost. Each score needs its method and confidence. A screenshot-based visual judgment can be marked as subjective; a recorded frame-time sample can be marked as measured. A hard budget failure cannot be hidden by a high aesthetic score.

### A comparison record, not a single magic number

Every candidate should use the same brief, camera or traversal routes, hardware target, NPC scenario, warm-up period, and capture window. Record a baseline before the edit and measure the candidate under the same conditions. The evaluation record should contain:

| Field | What to record |
| --- | --- |
| Hard gates | Platform and production budgets, measured value, allowed value, and headroom for frame time, memory, streaming, and any task-specific constraint. |
| Experience scores | A 0–5 anchored score for legibility, focal hierarchy, navigation, variation, and task-specific goals; each anchor states observable evidence. |
| Cost scores | Authoring/maintenance effort, runtime cost, iteration time, and reversibility, with units where possible. |
| Evidence | Capture or query method, sample size, route, timestamp, confidence, and whether the claim is observed, inferred, or unverified. |
| Alternatives | At least one materially different viable method, its expected benefit, its failure mode, and why it was accepted or rejected. |

Reject candidates that fail a hard gate before comparing weighted experience scores. For feasible candidates, use weights from the brief that sum to 100 and publish both the component scores and weighted total. A score is an aid to judgment, never a substitute for the underlying measurements: show Pareto tradeoffs when one option looks better but costs more memory or makes later edits harder. A subjective 4/5 needs a visible anchor such as “the intended landmark stays unobstructed along four of five sampled approach paths”; it cannot mean “looks good.” When evidence is weak, lower confidence and collect more evidence instead of awarding precision the measurement does not support.

The tool choice is part of the comparison. For hand placement, Actor Palette or reusable composed sets, PCG, PCGEx, or a hybrid, capture where ownership lives, how updates propagate, whether the result is deterministic, how instances stream, and how a designer can correct exceptions. Search for a known production pattern when one fits, then generate at least one alternative that changes the scene structure rather than only adjusting a parameter. For a dense city, that might mean changing sightline and traversal topology before reducing asset quality. For a market, it might mean composing a repeatable stall set before placing hundreds of independent props.

For a city, the analysis might sample several views and traversal routes, estimate what stays visible and resident, include NPC load, and consider how streets or transitions change the streaming window. For an interior, it might focus on readable entrances, sightlines, encounter space, and lighting. Neither analysis should assume that more camera angles automatically produce better understanding.

## Make evidence visible to the orchestrator

Every plan should carry an evidence ledger: findings, warnings, unknowns, chosen tools, rejected alternatives, budget assumptions, and checks to run after the edit. A warning found during inspection must be acknowledged or explicitly dismissed with a reason before completion. This includes visual-quality warnings from Unreal's UI system; their presence does not imply a crash, but ignoring them can leave unfinished styling in a shipped screen.

The ledger is a completion gate for an orchestrator. Each warning needs a source, affected asset or region, severity, owner, decision, and verification result. A handoff must list unresolved warnings explicitly; a final “done” verdict is unavailable while a relevant warning is unreviewed. Dismissal requires a reason and evidence, such as confirming that a widget is unused. The same rule covers performance captures that were planned but not run, unloaded cells that were not inspected, and a visual composition claim that has only a low-confidence proxy.

The final verdict should separate **observed**, **inferred**, and **unverified** claims. It should state the measured tradeoffs, what changed, how the editor was left, and whether the result stayed within budget. That gives both the agent and the human reviewer a way to challenge a beautiful-looking but expensive or fragile scene.

The [README](../README.md) describes Hayba's current release status. The [architecture guide](ARCHITECTURE.md) explains the existing server/editor boundary on which this future layer would build.
