# Honest Agent Dock — First Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed editor dock feel like one capable agent instead of a collection of speculative buttons: remove dead graph affordances and let the user run a scoped, read-only world inspection from the conversation.

**Architecture:** Keep the existing Slate chat widget, SSE agent client, native `world_inspect` command, and activity model. Delete the legacy wizard message-action row rather than inventing another review surface. Add one explicit Inspect control in the Agent dock that calls the existing native command and reports its real response, failures, and loaded-world limit in the same conversation. This plan is deliberately the first vertical slice of the revised workspace blueprint; the splat field and graph editor are separate work, not simulated here.

**Tech Stack:** Unreal Engine 5.8 C++, Slate, existing TCP command bridge, Unreal automation tests

**Spec:** `docs/design/2026-09-22-editor-workspace/editor-workspace-blueprint.md` (task-first dock and truthful inspect/apply loop); `docs/design/2026-08-23-extension-redesign/13-SCENE-INTENT-GRAPH-FEASIBILITY.md` (scene-field limits)

## Global Constraints

- Do not depict a synthetic cloud as inspected world data.
- `world_inspect` reads the current loaded world only; unloaded World Partition cells remain unknown.
- Inspect does not write or save assets.
- Do not claim a validation pass from an inspection response.
- Keep existing chat streaming, cancellation, external-MCP safety, and approval behavior intact.
- Do not add a new top-level destination, specialist room, or full-page review.

## Review Focus

1. No open world or failed native command: show an actionable error, never fabricated metrics. Task 2 test.
2. World Partition enabled with unloaded cells: retain explicit unknown coverage. Task 2 test.
3. Repeated Inspect clicks: do not let an older response overwrite a newer one. Task 2 test.
4. Message with an attached legacy graph: do not show Preview/Create/Test buttons whose state cannot be established. Task 1 test.
5. Agent conversation already streaming: keep Inspect disabled or reject cleanly without disrupting that turn. Task 2 test.

---

### Task 1: Remove misleading legacy graph controls

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.h`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.cpp`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPAgentAffordanceTest.cpp`

**Interfaces:** Consumes existing `FHaybaMCPChatMessage`; produces no new public API. Activity-card approvals remain unchanged.

- [ ] **Step 1: Write a failing affordance test.** Add a focused automation test that reads `HaybaMCPChatPanel.cpp` from the plugin directory and asserts `BuildMessageRow` does not construct buttons with the legacy labels `PreviewBtn`, `CreateBtn`, or `TestBtn`. It also asserts `BuildActivityCard(Msg.ActivityId)` remains reachable from the message row.
- [ ] **Step 2: Run `Hayba.MCP.Agent.Affordances` and confirm failure.** After staging the worktree plugin into the disposable host, run `C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor-Cmd.exe D:\hayba-t3-native-20260922-1124\HostProject\HostProject.uproject -ExecCmds="Automation RunTests Hayba.MCP.Agent.Affordances; Quit" -unattended -nopause -nosplash -NullRHI -log`; inspect the host's `Saved/Logs/HostProject.log` for the test result.
- [ ] **Step 3: Delete the attached-graph action row** (`if (!Msg.bFromUser && Msg.bShowActions && Msg.AttachedGraph.IsValid())`) and the private handlers `OnApproveStepFromMessage`, `OnRedoStepFromMessage`, `OnPreviewGraphFromMessage`, `OnCreateInUEFromMessage`, `OnTestItFromMessage` if no other caller remains. Preserve the activity card and its exact-call approval path. Do not replace the removed row with placeholder copy.
- [ ] **Step 4: Run the focused affordance, workspace-review, and activity-model tests; then build the plugin.** Inspect the 460 px Agent screenshot to confirm messages wrap and activity approval remains usable.
- [ ] **Step 5: Commit** `feat(ui): remove misleading legacy graph actions`.

### Task 2: Read-only World Inspect inside the Agent conversation

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.h`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.cpp`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPWorldInspectSummary.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPWorldInspectSummary.cpp`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPWorldInspectSummaryTest.cpp`

**Interfaces:** `FHaybaWorldInspectSummary::FromResponse(bool bOk, const TSharedPtr<FJsonObject>& Data) -> FHaybaWorldInspectSummary` returns `bSuccess`, `LevelPackage`, `bPartitionEnabled`, `LoadedLandscapeCount`, `bSaveReady`, and `Error`. `ToConversationText()` returns a short factual summary. The Chat panel consumes that summary and never parses free-form tool prose.

- [ ] **Step 1: Write failing parser tests.** Test a valid response (`world.package=/Game/L_Clinic`, `partition.enabled=true`, one `landscape` entry, `save_ready=false`) and assert the summary names the package, one *loaded* landscape, partition state, limited save readiness, and unknown unloaded cells. Test missing `world`/`partition` and failed command with no false success. Add a small request-generation helper test proving request 1 is stale after request 2 begins, while request 2 remains current.
- [ ] **Step 2: Run `Hayba.MCP.World.InspectSummary` and confirm failure.**
- [ ] **Step 3: Implement `FHaybaWorldInspectSummary`** using `TryGetObjectField`, `TryGetArrayField`, `TryGetBoolField`; return a stable failure message if required fields are missing. Keep its text under six short lines and end successful results with `Coverage: loaded world only; unloaded partition cells not inspected.`
- [ ] **Step 4: Add an `Inspect world` button near the Agent task header.** Disable it while a chat turn or an inspect request is active. On click, increment `uint64 InspectGeneration`, call `Module->SendTcpCommand(TEXT("world_inspect"), MakeShared<FJsonObject>(), Callback)`, and append the parsed result as a system/tool result in the current conversation only if the widget and generation are still current. Increment the generation on new conversation and destruction so late callbacks cannot land in the wrong task. Do not send a model prompt or mutate the level.
- [ ] **Step 5: Run focused parser, chat/activity, and navigation tests; build the plugin.** In a disposable Unreal host, click Inspect with a loaded world and confirm the displayed map, partition, and landscape facts against the editor. Confirm no package dirty state or save dialog. Capture 460 px and 1000 px Agent views.
- [ ] **Step 6: Commit** `feat(ui): inspect loaded world from agent dock`.

## Integration verification

- [ ] Build the Unreal 5.8 plugin in the disposable host; run both new focused tests and existing workspace/activity tests.
- [ ] Confirm the editor's real Agent dock has no legacy Preview/Create/Test row and that Inspect produces a factual result without running the AI model.
- [ ] `git diff --check` and `git status --short`; record any skipped live-project installation because the Saskartarad editor holds the DLL.
- [ ] Do not call this the spatial-field release. The renderer, stable scene graph, PLUMB constraints, and draft placement need their own implementation plan and acceptance evidence.
