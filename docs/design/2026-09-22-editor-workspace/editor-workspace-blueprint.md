# Hayba editor workspace — concept blueprint

Status: revised design proposal, 2026-09-22. The [interactive spatial-field mockup](./spatial-cloud-concept.html) and its [near splat view](./spatial-near.png), [zoomed-out relation view](./spatial-far.png), and [compact apply state](./spatial-apply.png) are illustrative. They are not screenshots of implemented plugin behavior. The earlier 2D layout and full-page Review concepts are superseded.

## Product promise

Hayba helps a game maker move one idea through inspection, an editable proposal, scoped editor changes, and evidence of what happened. The user should always know the current level and selection, what the agent knows, what it intends to change, what actually changed, and what remains unchecked.

The user asked for a refined in-editor agent experience, stronger production specialists, useful scene/blockout reasoning, and fewer disconnected tools. The current Agent / World / Library shell does not meet that bar: World Import and Validate only draft chat text, the narrow view is mostly generic controls, and scene/asset outcomes do not yet have a first-class review surface. This blueprint treats the **task** as the product unit; chat, scene design, assets, import, and validation are views and artifacts of that same task.

## One task, one spatial field

| Surface | Why it exists | What it must show |
| --- | --- | --- |
| Docked task | Direct the agent without covering Unreal | Current task, exact context, conversation, progress, important artifacts, composer, connection state |
| Spatial field | Visualize and edit what the AI understands about a scene | 3D point clouds and splats at object scale; semantic clusters and relation edges at distant zoom; bounds, constraints, evidence, uncertainty, and links into Unreal |
| Compact apply state | Make one scoped decision in context | Highlighted targets, exact operation count, destination, checks and unknowns, edit/approve controls; optional expanded detail only when requested |

The dock has no permanent Agent / World / Library navigation rail. The task header opens its relevant artifact in the spatial field. Assets and references enter through a context picker and appear in the task. A library browser remains available from that picker, with an expanded browse view only when necessary. Specialists route behind the task and identify themselves in activity when a handoff matters.

At roughly 350–500 px of dock width, the task remains a single column. The spatial field opens as a larger dockable tab; it does not squeeze beside chat. There is no mandatory full-screen Review page. An apply ribbon appears over the relevant splats/actors and can expand its exact target list. Both surfaces use the same task ID and selected artifact ID, so opening or closing the field never forks conversation state.

## The task loop

1. **Capture context.** Show project, current level, loaded-world scope, selected actors/assets, attached files/images, and user-picked region. Each chip opens or removes its source. The agent must distinguish an attached source from a broad project search result.
2. **Inspect.** Read the world and relevant assets. The response records coverage and capability limits. "No findings" is not "validated." A disconnected backend gets an actionable connection state near the composer.
3. **Propose.** Produce a typed artifact: spatial cloud, import plan, asset preparation, Blueprint change, concept direction, or validation report. The user can revise it in chat and, where useful, directly in the field. A proposal has stable object IDs and a version; an edit creates a new version, not a silent overwrite.
4. **Preview changes.** Highlight the proposed splats/actors in place and bind an apply ribbon to the precise editor operations it will authorize. Show target packages/actors, create/modify/delete counts, expected save behavior, required versus optional stages, and unsupported actions. Expand to exact targets on demand. An import preview includes source format, dimensions, transforms, material/LOD/Nanite/partition policies, and expected destinations.
5. **Apply and observe.** Approval acts on that proposal ID and operation set. Activity reports meaningful stages, exact objects created or modified, failures, cancellation, and partial results. Use Unreal transactions and a dedicated draft folder where native operations support recovery; do not promise rollback for operations that cannot be reversed.
6. **Verify.** Attach evidence to the task: actor/asset diff, viewport capture when available, compile or PIE result where relevant, and checks with explicit `passed`, `failed`, or `not_run` state. "Production ready" is unavailable when required checks are not run or fail. The user can revise, inspect in Unreal, or start a scoped repair from the result.

### Work modes

Modes describe behavior, not agent personas.

| Mode | Contract |
| --- | --- |
| Inspect | Read and explain; no project writes |
| Draft | Create editable, scoped, provisional artifacts and preview changes; any writes require exact approval |
| Production | Apply reviewed changes and run the task's required checks; explicitly report any blocked or unknown requirement |

The current `Explore` mode can map to Inspect. `Draft` and `Production` names may remain, but the visible contract and backend enforcement must match. A specialist profile alone cannot grant a production verdict.

## A scene example

User: “Block out a calm clinic lobby with a clear path to reception.”

- Context: `L_Clinic`, a user-selected region, four selected actors, a clinic brief, and loaded World Partition cells.
- Scene proposal: observed shell points plus proposed splat groups for entry, waiting, reception, corridor, and object slots; stable IDs, bounds, relations such as `visible_from`, `adjacent_to`, and `path_to`; constraints such as minimum access width and no overlap with selected actors.
- Spatial field: the near view shows 3D shape, density, color, and semantic selection through points/splats. Zooming away continuously aggregates samples into volumetric object/room clusters and reveals typed edges. Selecting a cluster zooms back into its samples and highlights linked Unreal actors. A “mood” is an authored brief and references, not a magical fifth spatial coordinate.
- Apply ribbon: 18 highlighted proposed proxies in one named folder, exact transforms available on expansion, no existing asset replacements, and current save policy. Unloaded cells are marked not checked. No separate wall-of-text review page.
- Result: new actor IDs and counts, a viewport image if capture succeeds, clearance/overlap checks that actually ran, and specific gaps. The next conversation turn can refer to the same plan and actor IDs.

The existing Scene Intent Graph feasibility note contains the underlying representation and stop conditions: [feasibility](../2026-08-23-extension-redesign/13-SCENE-INTENT-GRAPH-FEASIBILITY.md). The graph remains the reliable internal model; the point cloud and splats become the primary user-facing medium. The "fourth dimension" is a relational layer revealed by scale, not a fourth spatial coordinate. Time/variants can be another filter, and mood remains a semantic art-direction target. This is a UI and workflow hypothesis; the graph editor and realization pipeline are not implemented yet.

### Across the game-making pipeline

The same task model carries work between specialties. A planner's brief becomes a versioned source for concept directions; a chosen visual reference becomes context for a scene proposal; the scene proposal creates blockout actors; asset preparation replaces or refines proxies; lighting, audio, gameplay, and QA attach checks to those same objects. Each handoff names its input artifacts, output artifacts, and unresolved decisions. The user can return to the originating brief from any result.

| User intent | Reviewable artifact | Next linked action |
| --- | --- | --- |
| Explore a game's look | Concept brief, palette, references, image variants if a real generator is connected | Choose a direction for scene or asset work |
| Plan a playable area | Spatial plan with zones, relations, dimensions, and constraints | Preview a blockout in the current level |
| Import terrain or assets | Source inspection, target and policy choices, dry-run report | Apply supported stages with exact approval |
| Build gameplay | Blueprint/code change proposal tied to actors and expected behavior | Compile and run relevant PIE checks |
| Prepare for production | Changed-object bundle, performance/readiness checks, and explicit unknowns | Resolve failures or accept documented limits |

Concept art remains an unrendered brief when no image-generation provider is available. A prepared mesh remains blocked for production when a required Nanite, collision, or UV operation is unsupported. These states are visible in the artifact card and propagate to downstream work.

## How current features fit

| Existing feature | New place in the workflow | Current truth |
| --- | --- | --- |
| Built-in agent chat, sessions, activity, approvals | Docked task | Usable foundation; needs typed artifacts, attached editor context, and stronger review |
| `world_inspect` | Inspect and coverage panel | Reads loaded world facts; unloaded partition cells are not indexed |
| `world_ingest` | Import proposal and activity | Staged orchestration exists; automatic partition/HLOD and several preparation adapters remain unsupported |
| `asset_prepare` | Asset change proposal | Some LOD reductions supported; Nanite mutation, collision, lightmap UV, and material-instance creation are incomplete |
| Scene map and validator | Spatial field and evidence | Map loading and check coverage need live validation; findings cannot imply a full pass |
| Eleven specialist profiles | Internal routing and named handoffs | Prompt/routing profiles, not separately trained or benchmarked agents |
| Library/recipes | Context picker and repeatable task templates | Keep only actions backed by a real operation; avoid a second home for task state |
| External MCP plan gate | Settings and task-scoped external proposal | Existing gate approves the next native write, not an exact frozen operation set |

## Implementation seams

The editor shell can remain native Slate. It owns the task dock, context chips, result cards, compact apply ribbon, and links into Content Browser, Outliner, Details, and viewport. The spatial field needs a performant 3D renderer and picking, ideally in an Unreal preview viewport; the browser canvas in the mockup only illustrates the interaction. The existing CEF map spinner is not an acceptable completion state. Benchmark splat count, zoom transitions, and selection on a representative project machine before choosing a rendering adapter. The source of truth for a task is a structured task record, not parsed chat prose.

Observed geometry, proposed samples, inferred semantics, and unknown/unloaded regions need distinct visual states and provenance. Generated proxy splats are a design preview; they must not be presented as a photorealistic reconstruction. Zooming out aggregates by stable object/region ID and turns on typed relation edges. Zooming in restores the samples. Neither view should silently change the underlying task record.

Minimum typed records:

```text
Task { id, goal, mode, stage, contextSnapshot, artifacts[], actions[], evidence[] }
ContextSnapshot { level, selectionIds[], region, loadedScope, sources[], capturedAt }
Artifact { id, kind, version, sourceTaskId, preview, targetRefs[], constraints[], status }
SpatialSample { id, ownerNodeId, position3D, radius, color, semanticRole, origin: observed|proposed }
Relation { fromNodeId, toNodeId, type, parameters, provenance, confidence }
ActionProposal { id, artifactVersion, operations[], targets[], risk, requiredChecks[], unsupported[], approvalState }
CheckResult { name, targetRefs[], status: passed|failed|not_run, evidenceRef?, reason? }
```

Every UI view reads the same records. The backend streams state changes; the native adapter resolves actor and asset IDs and performs scoped operations. An action proposal becomes invalid if its artifact version or relevant target state changes before approval. This replaces the ambiguous “approve next command” contract for built-in task actions.

## Delivery sequence and proof

1. **Honest dock.** Replace the rail with a task header and context/status. Make World Import and Validate genuine entry flows or relabel them until they are. Show meaningful connected/disconnected setup. Verify the 420 px layout with real Slate captures and keyboard navigation.
2. **Typed task review.** Add durable artifacts and exact proposal IDs; render proposal, activity, results, and check coverage in one conversation. Verify restart/session restore, approval of the intended operation only, cancellation, and partial failure.
3. **Spatial field MVP.** One room or compact point of interest. Render observed/proposed 3D samples as distinct point clouds or splats; aggregate into stable spatial clusters and typed edges with distance; select and edit bounds, relations, and constraints; preview placement in a dedicated draft folder. Verify selected-world grounding and a recoverable path. Do not expand to full partitioned maps before unloaded-cell coverage is designed.
4. **Real production workflows.** Complete missing native adapters and checks for the advertised import/asset policies. Test with representative landscapes, meshes, partitioned worlds, and existing project content. Evaluate specialists on real briefs using artifact quality and correction cost, not routing tests alone.

The first release is successful when a user can complete one real task from a narrow dock—context, proposal, exact approval, editor change, and evidence—without guessing which tab owns the result. Production readiness requires a checked result, not just a confident agent response.

## Design basis

The blueprint follows an interaction loop common to agent-assisted editing tools: precise context → reviewable plan → scoped action → inspectable result → evidence. Its principles are that the user states scope before the agent acts, approvals name the exact operation and targets, changes stay reviewable in the task that produced them, and a result counts as verified only when a real check ran. Hayba's opportunity is to make **native game-world artifacts** the center of that loop.
