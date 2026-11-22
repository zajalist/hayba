# Agentic editor workflow research

Evidence checked 2026-11-12. Scope: Hayba's Unreal chat workspace, long conversations, child tasks, media generation and removal of the retired semantic World UI. Recommendations below are engineering inferences from official documentation and the current source, not claims of feature parity or live editor verification.

## What the reference products establish

| Source | Documented behavior | Useful implication for Hayba |
| --- | --- | --- |
| [Claude Code in VS Code](https://code.claude.com/docs/en/vs-code) | Searchable session history, separate conversations, context attachments, a subagent map showing task status and tool activity, and read-only child transcripts. | Make threads, turns and child tasks independently discoverable. Keep the main task visible while inspecting delegated work. A profile label alone is not a subagent. |
| [Claude checkpointing](https://code.claude.com/docs/en/checkpointing) | Conversation branching and file restoration are separate operations with explicit tracking limits; not all shell or subagent changes are restored. | Separate “continue from this point” from “undo editor work.” Do not suggest that chat history is a backup of an Unreal project. |
| [Codex IDE workflow](https://learn.chatgpt.com/docs/codex/ide) | Uses selected code/open-file context, presents focused diffs beside the source, and returns delegated work to a reviewable editor result. | Attach concrete editor targets, retain the rationale beside actual changes, and return agent results to the parent conversation. Avoid a separate dashboard for each tool. |
| [Unity Assistant](https://docs.unity.com/en-us/engine/6000.6/manual/packages-list/packages-all/pack-safe/com-unity-ai-assistant) | Distinguishes Ask/read-only inspection from Agent/editor modification governed by permissions. | Retain explicit Inspect/Draft/Production consequences. A selected mode must describe executable behavior, not merely alter the prompt. |
| [Unity AI menu](https://docs.unity.com/en-us/engine/6000.6/manual/unity-ai/ai-menu) | Groups generation by asset category and exposes account/credit information. | Use output categories such as Model, Video and Splat, then provider capabilities within a category. Show account state and paid submission clearly; never invent a balance or price. |
| [Unity's CLI migration](https://docs.unity.com/en-us/unity-cli/replace-mcp-server-unity-cli) | Deprecates the Assistant package's in-editor MCP server while retaining CLI MCP and direct editor commands. | Keep execution transport behind native/backend boundaries. UI should expose task results, not force users to understand or manage competing transport panels. This is not a recommendation to replace Hayba's working transport. |
| [Epic editor Python](https://dev.epicgames.com/documentation/unreal-engine/scripting-the-unreal-editor-using-python) | Supports named undo transactions and cancellable progress for editor operations; explicitly warns that some operations, including imports, are not undoable through transactions. | Offer undo only for an applicable, recorded transaction. Report long-running progress honestly and distinguish stopping observation from cancelling the underlying operation. |
| [Epic Data Validation](https://dev.epicgames.com/documentation/en-us/unreal-engine/data-validation-in-unreal-engine) | Assets can be checked by extensible validation rules from editor scripting. | Show checks with target, result and evidence. “No error text” must not become “validated.” |
| [Godot EditorPlugin](https://docs.godotengine.org/en/stable/classes/class_editorplugin.html), [EditorUndoRedoManager](https://docs.godotengine.org/en/stable/classes/class_editorundoredomanager.html) | Native plugins integrate docks, resource/node editing and scene-associated undo histories. | Fit into the editor's selection, resource navigation and transaction model. These references establish plugin mechanics; they do not establish a built-in Godot AI agent. |

## Highest-value Hayba changes

1. **Scalable task navigation.** One navigator with Threads, This conversation and Agents. Search thread metadata on the server in bounded pages; show the current thread and date. Search/jump within turns without rendering the full transcript at once. Preserve the reader's position during streaming and preserve unsent drafts on failed transitions. A child entry needs its parent, assigned task, running/terminal state, tool activity, result and explicit Stop action. Completed child results can be referenced in the parent draft. These are the active implementation priorities.

2. **Visible review and truthful results.** Keep a pending-review strip adjacent to the composer; jump to the exact operation rather than hiding it beneath expanded tool details. Keep generated text separate from authoritative approval state. Link existing Activity/Changes/Checks views to the task instead of introducing a new approval system. Display “not run” when no native validation evidence exists. Any future Undo action must use a real transaction ID and current applicability check; no universal rewind or import rollback.

3. **Editor context with provenance.** A context chip should expose the captured actor/asset/file path and its kind, allow removal, and reveal an editor asset only when the native handler resolves that target. Distinguish captured selection from whatever is selected later. Keep the context attached through blocked sends, and let the user review which references will be sent. Source and validation links should be reusable in follow-up drafts.

4. **Media workspace, not a provider button collection.** Group supported output kinds and show real providers within each. The current adapters cover models through Meshy/Tripo/Aholo, video through fal/Wan, and splats through World Labs. Keep configured/verified/checking/error separate. Use explicit paid generation and separate paid Meshy texturing. Show job state, nullable progress and result format. Opening a download or adding its URL to chat is not an Unreal import. SPZ imports require compatible rendering and scale metadata; do not label an unimported output “game-ready.”

5. **Recovery attached to the failed operation.** Preserve the draft or partial result, explain the failed boundary, and offer the relevant action: configure provider, refresh status, review, or retry. Creation timeouts must warn that provider work may already exist; do not automatically submit another billed job. Avoid restarting all services for a single request failure.

## Bounded implementation guidance

Use the existing chat renderer, native state projection, activity model, provider vault, session store and guarded local routes. A larger history browser should not require a second frontend framework. Window transcript DOM and page thread metadata before introducing a database or generalized event platform. Initially constrain child tasks to read-only tools with separate context, bounded execution and cancellation; mutation-capable parallel agents would need conflict and approval isolation beyond a UI change.

Do not add decorative dashboards, a new semantic map, placeholder provider integrations, invented token/credit meters, universal rollback, or automatic downloads/imports to satisfy a visual reference. Add capabilities only when the corresponding engine or provider path is real and testable.

## Retired World UI: dependency closure

Source searches were scoped to plugin C++ headers/sources, resources, backend tools and scripts. The following closure was implemented on 2026-11-12 after explicit authorization. Sixteen tracked, previously unmodified files were removed (5,440 lines; 299,302 bytes), with the dead UI projection, module pointer, World brush registration and scratch renderer test removed from retained files. The two core observation-fusion tests remain. A backend source-assertion test no longer reads the retired web-panel file; its actual backend behavior tests remain.

| Candidate | Reference evidence | Required companion change |
| --- | --- | --- |
| `Private/HaybaMCPSceneMapWebPanel.{cpp,h}` | No production construction after World navigation removal. Remaining construction is in `HaybaMCPWorldVisualReviewTest.cpp` and the scratch-renderer portion of `HaybaWorldObservationFusionTest.cpp`. | Remove retired visual-review test and only the scratch renderer test block; retain pure observation-fusion tests. |
| `Resources/cognitive-map/` | Runtime HTML consumer is `SceneMapWebPanel::ResolveHtmlUrl`; JS consumers are that HTML and its dedicated tests. | Remove the resource family and dedicated JS tests with the web panel. Update packaging/docs that describe the embedded map. |
| `Private/HaybaMCPSceneMapPanel.{cpp,h}`, `HaybaMCPCogMapBuilder.{cpp,h}`, `HaybaMCPSceneMapData.h` | Native map has no construction/assignment. Builder and map data are consumed only by that panel and a legacy command-handler projection. | Remove the dead projection and its includes, module include, and `Public/HaybaMCPModule.h` weak map pointer. |
| `SemanticFromString`, `PushSceneGraphToPanel` in `HaybaMCPCommandHandler.cpp` | One projection call after `scene_get_graph`. Its target `LoadSceneGraph` is already an empty method in the old panel header. | Remove only this UI side effect; preserve the real `scene_get_graph` response and handler. |
| `Hayba.Icon.Nav.World` registration / `Resources/Icons/world.svg` | Source search finds the registration but no consuming brush lookup after navigation removal. | Recheck filename references before removing the SVG. Leave shared colors and icon utilities used by other views. |

**Keep:** `HaybaMCPSceneGraphHandler`, `HaybaMCPWorldGeometry`, `HaybaMCPWorldDepth`, `HaybaMCPWorldTileCapture`, `HaybaMCPWorldTileSnapshot`, and `HaybaMCPWorldObservationFusion`. The scene/geometry/capture tool paths actively call these. In `HaybaWorldObservationFusionTest.cpp`, the first two tests validate the underlying store and memory limits independently of the retired panel; only `FHaybaWorldObservationFusionScratchTest` constructs it. `WriteCognitiveMapCache` still has a backend call and should not be removed merely because its name resembles the retired UI.

**Not established as dead:** Library, Rules, Memory, Slivers, Validation and Lessons. Native direct callers/tests and meaningful content builders remain. Removing their navigation does not prove the implementation is unused. Preserve the HTML failure fallback, exact native approval panels and credential UI.

## Verification boundary

Research used official documentation and repository reference searches. Media adapter tests pass against fake transports; UI/browser and native build evidence are recorded separately by the implementation owner. No live provider generation, imported-media validation, desktop control, or cross-editor comparative usability study was performed.
