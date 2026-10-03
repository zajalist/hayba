# World intelligence

**Status: design direction with read-only building blocks in development.** Hayba exposes scene and asset inspection tools. The complete composition and production reasoning loop described here is planned work; it is not a shipped end-to-end feature.

The development branch can count currently loaded actors and ISM/HISM instances with `world_budget_snapshot`, capture bounded whole-editor PIE timing and memory proxies with `editor_pie_capture_start` / `editor_pie_capture_get`, and compare caller-supplied records with `world_compare_snapshots`. Structural deltas and cap headroom require complete, matching loaded-world scans; PIE proxy deltas require compatible, complete captures and full samples for each compared metric. The [PIE collision sightline probe](PIE-sightlines.md) adds bounded approach-route evidence. None of these tools measures rendered visibility, actual streaming residency, GPU cost, NPC AI cost, texel density, or a production performance verdict. A comparison protocol is declared by the caller; Hayba cannot verify that two captures used the same hardware, route, build, and editor conditions.

The development World panel has a read-only, three-dimensional point-cloud preview of the loaded editor world. An initial CPU-accessible static-mesh overview includes a bounded subset of ISM/HISM transforms. Zoom requests fixed world-space tiles sampled from CPU mesh render-LOD triangles and clipped to the tile; each tile has an 8,192-point ceiling and explicit source nodes. The renderer's upper addressable capacity is 256 tiles, or 2,097,152 real mesh-derived points, with an adaptive memory cache and a lower per-frame draw budget. That number is a capacity ceiling, **not a claim of complete coverage, two million points in every scene, or a measured Unreal frame rate**. A separate 256×256 editor-camera depth pass observes first visible surfaces only. Sparse physics rays add depth-matched collision labels to individual pixels; coincident or hidden collision geometry can make a label ambiguous. Other depth points remain explicitly unattributed. Selecting a mesh point can highlight its authored source, author-assigned tag, shared mesh asset, or derived spatial neighborhood when that evidence exists. Unknown depth points offer only spatial groups, and depth-matched labels do not trigger automatic Unreal actor selection.

[View the actual scratch-editor depth capture](media/world-depth-scratch-preview.png). The default camera frames the main observed point mass; Shift+Fit includes every distant sample. Both views retain the same underlying points.

[View a zoom-local mesh tile](media/world-tile-scratch-preview.png) from the synthetic scratch level. That tile contains 8,192 triangle-sampled points from loaded meshes across four source pages; it reached the per-tile cap, so its `partial` status and coverage gap remain visible to agent queries.

The read-only `world_semantic_snapshot` tool exposes three distinct observations, each with bounded pages:

| Source | What an agent can query | Change guard and limit |
| --- | --- | --- |
| `mesh` | Loaded authored hierarchy, derived spatial clusters, memberships, and sampled points | `expected_scan_id` rejects a changed scan; queries rebuild a bounded scan. |
| `mesh_tile` | A geometry tile from World or `world_tile_capture`: `overview`, `pages`, authored `semantic` groups, provisional spatial `relations`, source `nodes`, and exact `points` | Pass a canonical `tile_id`. If an agent started the capture, pass its returned `capture_id` as `expected_capture_id` on the **first overview and every later page**. A bounded cache retains 32 immutable captures, so a newer view of the same tile does not silently replace this observation; eviction or world/origin invalidation refuses the pinned ID. Numeric indices are page-local; canonical source IDs and capture-local point IDs join results. |
| `view_depth` | Last editor-camera observation: `overview`, fixed-grid `groups`, and first-visible `points` | Pass `expected_capture_id` on later pages to reject a replaced capture. Unattributed pixels remain unknown. |

An authored semantic group records a tag, folder, actor class, or mesh asset and the source nodes whose sampled points contributed. It is not an automatically inferred gameplay label. A cached tile is an observation at `captured_at_utc`, not proof that the editor still has the same geometry after later edits. An agent can request a tile without opening World: `world_tile_capture` starts a bounded CPU capture by `tile_id` or by `position_cm` and `lod`, returns a capture ID, and supports status/cancel. LOD 0, 1, and 2 tile edges are 4,000, 2,000, and 1,000 Unreal centimeters respectively; each address coordinate is `floor(position_cm / edge_cm)`, including for negative positions. After capture, read `world_semantic_snapshot` with `source=mesh_tile`, `tile_id`, and the returned `capture_id` as `expected_capture_id` on the first overview and every subsequent page. Its `relations` page computes bounded proximity, above, overlap, and containment candidates from sampled source bounds, with point IDs as evidence. These do not prove physical contact, navigability, visibility, or gameplay meaning. Zooming in World initiates the same kind of geometry sampling. Unloaded World Partition cells, unsupported geometry, Nanite proxy differences, and clipped or capped sampling remain explicit coverage gaps. Neither mesh nor depth samples reconstruct materials or measure landscape, skeletal meshes, NPC, streaming, GPU cost, or production performance. Colors are shape or provenance cues rather than material colors. The current single-view depth readback is synchronous and can briefly pause an editor frame; its elapsed time is reported as a performance warning. This model helps locate and inspect a loaded scene; it does not produce a composition or performance verdict.

For a known location, an agent can make the query without translating a screenshot into coordinates:

```text
world_tile_capture({action:"start", position_cm:{x:-250,y:3000,z:100}, lod:2})
  → tile_id:"tile:2:-1:3:0", capture_id:"<returned ID>"
world_tile_capture({action:"status", capture_id:"<returned ID>"})
  → captured or partial
world_semantic_snapshot({source:"mesh_tile", section:"overview",
  tile_id:"tile:2:-1:3:0", expected_capture_id:"<returned ID>"})
world_semantic_snapshot({source:"mesh_tile", section:"semantic",
  tile_id:"tile:2:-1:3:0", expected_capture_id:"<returned ID>"})
world_semantic_snapshot({source:"mesh_tile", section:"relations",
  tile_id:"tile:2:-1:3:0", expected_capture_id:"<returned ID>"})
```

The semantic and relation rows are candidate evidence. Before an edit, the agent resolves source IDs to Unreal objects, checks the request's gameplay and production constraints, and uses the appropriate guarded authoring tool. More elaborate open-vocabulary or view-dependent reasoning needs its own model and evidence path; a point count or nearby pair is never an edit instruction.

An Unreal world can contain thousands of actors, instances, procedural outputs, and streaming cells. A flat inventory answers *what exists* but leaves the harder question open: *how does this world work as a scene?* The World layer is intended to help an agent read composition, compare interventions, and make a production-aware edit with evidence.

## What World is for

World is the shared scene model behind the in-editor view and agent inspection. Its first job is to locate a meaningful part of a loaded scene and explain what evidence supports that location. Dense points resolve local geometry; source identities and hierarchy make those points useful for reasoning. Mesh samples lead back to authored objects, spatial neighborhoods, tags, and coverage gaps. View-depth samples are separate camera observations, and most do not yet identify a source.

## Queryable geometry and meaning

The direction follows the useful idea behind [ReLaGS](https://openaccess.thecvf.com/content/CVPR2026/html/Xie_ReLaGS_Relational_Language_Gaussian_Splatting_CVPR_2026_paper.html) and [Open3DSG](https://openaccess.thecvf.com/content/CVPR2024/papers/Koch_Open3DSG_Open-Vocabulary_3D_Scene_Graphs_from_Point_Clouds_with_Queryable_CVPR_2024_paper.pdf): a spatial representation is more valuable when an agent can query objects and relations across scales than when it can only rotate a picture. Hayba adapts that principle to an Unreal project. The editor already knows the actor, component, instance, asset, level, and folder identities, so there is no need to reconstruct those identities from photographs. This is a sampled point cloud of project geometry, **not a trained Gaussian radiance field**; open-vocabulary features and relational inference remain separate capabilities to validate.

[3DSceneEditor](https://arxiv.org/abs/2412.01583) adds another useful pattern: resolve a language request to a specific object before editing it. Hayba can map a request such as “move the stalls near this entrance” through spatial candidates, semantic evidence, and canonical Unreal source IDs. The reviewed action must then edit the owning actors, instances, or generation graph through Hayba's guarded tools. Moving preview points would only change an observation, not the game level. This mapping is a design adaptation of the research, not a claim that Hayba implements its segmentation or CLIP grounding model.

The intended query path is:

```text
Question and constraints
  → coarse world/level/region search
  → zoom-local geometry tile and authored-source lookup
  → optional visual/depth evidence for appearance and visibility
  → typed spatial relations with evidence and confidence
  → candidate interventions and measured production-budget checks
```

A point references one capture, tile, page, source actor and source node. Source nodes describe authored ancestry from level and folder down to component and instance; tags, actor class, and mesh asset come from Unreal metadata. Spatial tiles and proximity groups are computed, not authored. A future relation such as “stall obscures entrance from route A” needs a named route, view or ray evidence, and a stated confidence. Point density alone cannot establish that relation or prove free traversal space. Optional image-language detection can suggest a label, but must join a canonical source and expose uncertainty before it drives an edit.

For example, “find market stalls that crowd the approach to the gate” first narrows to loaded regions intersecting the route, then retrieves source nodes whose authored tags or verified visual labels indicate stalls, then tests bounds, visibility, and navigable space along the approach. The result should identify actors or instances, explain which observation supports each relation, and report unloaded cells or unsupported geometry. If the proposed response is to replace hand placement with PCG, the decision also needs the project's tool inventory, streaming/NPC/frame-time budget, authoring tradeoffs, and a before/after measurement. A spatial match is a candidate, not a design verdict.

Two hierarchies should coexist. The **authored hierarchy** is a fact from Unreal: level, Outliner folder, actor, component, and instance. The **spatial hierarchy** groups nearby sampled surfaces into coarse and fine regions; its boundaries are computed from each scan and should not be described as persistent designer-authored areas. A splat refers to both. Metadata belongs in source and cluster records, so it can be queried without repeating long strings thousands of times in the renderer. Unreal tags remain authored tags; a cluster can summarize those tags only as a union of its sources. Labels such as “route,” “market,” or “focal point” require a separate inference with evidence and confidence. A cluster's proximity alone cannot establish its gameplay meaning.

The in-editor World view should let someone move from the whole scene to a region and then a source, revealing detail on demand. An agent can page the mesh model and the latest observed view-depth capture without interpreting a screenshot; the panel's adaptive scope IDs and the depth API's fixed-grid IDs still need a shared selection mapping. Neither view can infer streaming, NPC load, memory, frame time, or material appearance from these samples alone; those require the specific measurements in the working loop below.

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
