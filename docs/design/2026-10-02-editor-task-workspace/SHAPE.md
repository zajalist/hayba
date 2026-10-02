# Hayba in-editor workspace — shape brief

Status: shaped direction for the full UI rebuild. This brief updates the September task-workspace proposal with the user's chat-first and scene-derived World requirements. It replaces the older five-section rail and 2D World-map assumptions; the logo and visual-system commitments remain in force.

## Job and proof

Hayba serves a game maker working inside Unreal Editor, often in a 350–500 px dock. The user should be able to ask for a game-making task, see what the agent understood, inspect its proposed actions and costs, approve the exact change, and understand the result without navigating between implementation screens. An external MCP orchestrator should be able to recognize the same warnings, constraints, and evidence through typed records.

The signature path is one task: **context → inspect → propose → preview → approve → execute → verify**. The conversation remains visible throughout. A warning or failed check stays attached to the affected task and artifact until it is addressed or explicitly left unresolved. A successful-looking response cannot hide incomplete coverage.

## Surface model

1. **Task dock is home.** Remove the permanent left rail and nested feature tabs. The top line shows the Hayba logo, current task title, and a few familiar actions. It has no permanent connection label, safety badge, level name, actor count, cell count, or context-chip row. Scope, selection, attached sources, and mode appear when the user opens context or when they affect an action. The central area is a real conversation with streaming text and compact, expandable records for tool work, approvals, warnings, diffs, and check results. The composer stays pinned at the bottom.
2. **World is a linked artifact.** Open a larger dockable 3D spatial field from the current task or context picker. It is generated from the actual loaded scene and selected scope, with observed mesh-derived samples at near zoom and stable object/region clusters at far zoom. A small number of visible clusters carry rich semantics, provenance, relationships, constraints, budget facts, and uncertainty. Selection cross-highlights Unreal actors and returns to the same task. The field has no permanent right text panel; selected detail is a compact in-scene card or expandable bottom sheet. Missing or unloaded regions remain visibly unknown.
3. **Context picker and task search replace destinations.** Assets, Profiles, Recipes, Rules, skills, and typed tools are searchable when needed. They enter as context, reusable actions, or evidence in the task. Settings opens from the task header. A command palette exposes expert actions and legacy screens during migration, with labels that state their purpose. There is no separate Activity/Plan/Diff/Validation home to hunt through.

The visual hierarchy is deliberately quiet, as in a focused agent workspace: conversation and the current decision lead; routine trace, inventory counts, and explanations stay collapsed behind consistent icons with tooltips and keyboard labels. Context is available on demand, never a permanent dashboard. A healthy connection has no visible status label. A connection failure or safety block appears beside the affected action with a clear recovery path. A warning earns visible space when it changes the next action or production verdict. The same interface expands to a wide editor tab and contracts to a narrow dock without inventing extra navigation.

The task record, not chat prose or tab state, owns stable task and artifact IDs, context snapshot, proposal version, exact target set, agent/tool actions, warnings, and check evidence. Chat and World render the same records. If target state or proposal version changes, approval becomes invalid and must be refreshed.

## Chat interaction

The composer supports normal multiline writing, Enter to send and Shift+Enter for a newline, an explicit Stop while streaming, and draft retention when a run or approval is pending. An attach/context affordance can add selected actors, assets, regions, captures, or files with clear provenance. A task switcher restores prior conversations and their linked artifacts. Tool and skill search should surface Hayba's typed operation before a generic Python escape hatch; each suggestion says what it does, prerequisites, and why it fits. Modes read **Inspect**, **Draft**, and **Production** and enforce their stated write/check contract in the backend.

Agent work reads as a coherent sequence of compact, expandable cards: what it is doing, what tool or specialist was used, which targets were read or changed, elapsed state, and any required human action. A proposal card shows exact creates/modifies/deletes, target packages or actors, save behavior, estimated performance/memory/streaming impact when measured or declared, and required checks. Approval is inline beside that proposal; it authorizes a frozen operation set. Progress and partial failures update the same card. The result card links changed objects, diff/undo where supported, World preview, and `passed` / `failed` / `not run` checks. Unsupported work remains visible rather than being silently recast as complete.

Safety and production warnings are first-class task events. A missing lease, Play veto, editor-unsafe state, read-only save, uncompiled Blueprint, absent performance measurement, texel-density concern, streaming uncertainty, or typography warning should name the affected target, consequence, available next action, and whether it blocks production. For example, a widget still using default Roboto is a visible UI-quality finding with a checked asset and unresolved/verified outcome; it is never lost because a crash investigation received higher priority. Multi-agent work shows owner, lease, wait/block reason, and handoff in the same task timeline.

## World interaction and truthful coverage

The World field starts with a scene-derived spatial overview, not a text report or decorative scatter. Near zoom shows actual geometric shape and density; far zoom aggregates by object, room, district, and streaming region as appropriate, with typed relationships such as visibility, adjacency, route, containment, and dependencies. Semantic color and shape distinguish observed, inferred, proposed, and unknown content. Filters can expose composition, traversal, streaming, memory, NPC/load assumptions, PCG-generated versus hero-placed content, and warnings without turning the field into a dashboard of labels.

Selecting a cluster reveals its source actors/assets, confidence and coverage, relevant dimensions and budgets, and task actions such as inspect, compare, propose a change, or focus in the editor. A proposed layout overlays the observed scene; its exact targets, checks, and approval live in the linked conversation, with no persistent World proposal ribbon. A comparison shows measured deltas and declared limits, keeps unlike capture conditions visibly incomparable, and does not convert an approximate visual judgement into a fake production score. The field must remain usable on dense worlds through hierarchical sampling and level-of-detail; it must never imply that unloaded World Partition cells were inspected.

## Visual and native rules

Preserve the existing Hayba logo exactly. Use a consistent warm-charcoal surface system across Slate and World; ochre signals active selection, pending approval, unsaved work, or attention, never decoration. Use licensed Noto Sans and sentence-case labels; no all-caps display treatment or generic AI ornament. Use one licensed, consistent vector icon family at 20 px for primary controls and 16–18 px for compact actions; verify legibility at narrow-dock and high-DPI sizes. Icons must carry familiar, named actions with tooltips, not replace comprehension with mystery glyphs. The conversation gets the strongest width and contrast, while metadata recedes without becoming unreadable. Keyboard focus, narrow-dock reflow, high-DPI scaling, screen-reader labels where Slate supports them, and actionable connection/error states are part of the design.

Native Slate should own the task dock and cards. The World field needs a performant Unreal 3D preview/picking adapter; a static browser illustration or endless spinner does not satisfy the task. The UI should not steal the editor's normal Outliner, Details, and viewport affordances. No raw project data or secret keys should be sent to an optional external decision service to make these interactions work.

## Required states and ranges

- First run: explain connection and credentials in place, allow an Inspect-only path where available, and show a recoverable setup action. No dead-end checklist or “coming soon” screen.
- Empty task: one useful first action and an available composer. If connection fails, show the failure and recovery action in place; a healthy connection needs no status copy.
- Running or waiting: streaming output, Stop, queued draft, ownership/lease state, and a visible reason when progress pauses.
- Approval: exact proposal and target version, Approve/Reject/Edit, and explicit invalidation on changed targets.
- Partial or failed result: list completed, failed, and unrun stages separately; keep a repair path without claiming rollback where none exists.
- Large project: thousands of scene instances may underlie the field, but visual grouping, search, and scoped inspection prevent an unreadable cloud or a wall of rows.

## Build order and acceptance

First replace the rail with the task dock and prove the full conversation loop at 420 px, including keyboard behavior, persistent task history, inline approvals, warnings, and evidence. Then connect typed task/artifact records and context search to existing safe native operations. Build the scene-derived World field, hierarchy, and selection bridge with one real compact scene before scaling to partitioned worlds. Keep approval in the linked task. Preserve existing operations behind adapters until their new workflow is verified; remove old tabs only when their useful behavior is reachable in the task.

The rebuild is ready for release only after a real user can complete a scoped task in a scratch Unreal project from context through verification without switching to a hidden feature tab, and can see any unresolved warning or unsupported check. The World proof must use actual scene data and support selecting a cluster back to Unreal. Review the narrow and wide native captures against the established palette, logo, icon family, and this brief. Keep private project observations out of public artifacts.
