# Production Chat: one agent workspace inside Unreal

Status: implementation brief and release contract, 2026-10-02. This is a target, **not a claim that the current plugin has shipped these behaviors**. It implements the chat-first direction in [the editor task workspace shape](../2026-10-02-editor-task-workspace/SHAPE.md) and the [spatial-field blueprint](../2026-09-22-editor-workspace/editor-workspace-blueprint.md). If a detail here conflicts with those documents' task-centered surface or visual identity, their locked direction wins.

## Job and product truth

The user is making a game inside Unreal, often with a narrow 350–500 px dock beside the editor. They need to tell Hayba what to do, understand which world and assets it actually observed, steer a capable agent, inspect exact proposed edits, authorize them, and see measured or explicitly unrun checks. A conversation alone is insufficient. The entire interaction must remain one task, with World and native Unreal panels opening the same objects, proposals, warnings, and evidence.

**Primary outcome:** a user can complete a real task from context through verification in a scratch project without guessing which tab owns the work, without a silent non-reply, and without trusting an unverified production claim. This is an Operate surface: conversation and the current decision lead; metadata appears at the moment it helps a decision. The bar is a full agent workspace with the fluency of mature coding agents, adapted to native editor work and Hayba's safety model.

The signature sequence is **ask → ground → inspect → propose → preview → approve → act → verify → continue**. The user can interrupt, revise, or reject at every meaningful boundary. A task may skip proposal or approval only for read-only work; it cannot skip them because a UI mode looks permissive.

## One state model, multiple views

The task record is the source of truth. The dock, spatial field, Content Browser and Outliner links, tool activity, validation, and external MCP observation are projections of the same records. No tab keeps a separate plan, warning list, selection, or notion of completion. Opening World does not create another conversation; returning to Chat preserves selection, context, and the artifact under review.

Minimum stable identities and relationships:

```text
Task        { taskId, title, scope, state, currentRunId, contextId, artifactIds[] }
Run         { runId, taskId, requestId, origin, modelChoice, effort, access, state }
Event       { eventId, taskId, runId?, sequence, type, source, occurredAt, payload }
Context     { contextId, taskId, capturedAt, loadedScope, selectionRefs[], sourceRefs[] }
Artifact    { artifactId, taskId, kind, version, sourceEventIds[], targetRefs[], state }
Proposal    { proposalId, artifactId, artifactVersion, targetFingerprint,
              operationDigest, operations[], requiredChecks[], expiry, state }
Approval    { approvalId, proposalId, decision, decider, decidedAt, policyVersion }
Evidence    { evidenceId, taskId, artifactId?, targetRefs[], check, status,
              coverage, method, measuredAt, sourceRef? }
Warning     { warningId, taskId, targetRefs[], consequence, severity,
              blocking, state, evidenceIds[], nextAction? }
```

The event stream is durable, ordered per task, replayable, and idempotent by event or request ID. Append before fan-out. Session restore and SSE resume rebuild the same projection without duplicated cards or re-executed tools. A command refers to immutable IDs and expected versions, never to the currently highlighted row or a parsed sentence. Credentials, raw authorization headers, and unrestricted tool payloads are absent from durable events. Local artifacts have bounded size, retention, and deletion rules; only explicit selected context is sent to a provider.

The existing sidecar already has chat SSE, replay sequence IDs, cancellation, approval requests, a session store, and a live model-discovery endpoint. These are foundations, not the target task model. Stored messages are currently a text projection and activity/artifact records are thin; the visible editor work mode and approval UI do not yet implement this complete contract. Migration must retain readable old conversations without treating their prose as exact approval or verification evidence.

## The dock's interaction architecture

The task header holds the logo, current task switcher, search/new task, and a restrained overflow for settings. A healthy connection consumes no permanent status line. The central scroll area is a readable conversation. One compact composer stays at the bottom with attachment/context, model, effort, and access controls; send becomes Stop during an active run. At narrow width, controls collapse into familiar icon buttons and a single intentional menu, with named tooltips and keyboard labels. At wide width, they may gain text, but must not create a second navigation architecture.

Routine tool calls appear as a grouped, collapsed work record. Expand to see the tool's name, why it was chosen, source/owner, inputs safe to display, targets, elapsed state, and result. Important failures and decisions break out at their chronological point. The agent's final answer remains readable prose; inline artifacts provide evidence without making the answer a wall of machine metadata. No raw JSON is the default user view.

Every substantive object has one place in the task timeline:

| Object | Default presentation | Expanded action |
| --- | --- | --- |
| Context snapshot | Small attached-source summary only when relevant | Inspect exact selected actors, assets, region, capture scope, and attachment provenance |
| Running work | One concise progress row; Stop available | See specialists, typed tool calls, wait/lease reason, and target list |
| Proposal | Scope and consequence, with Approve / Edit / Reject | Exact operations, targets, expected save behavior, checks, cost/uncertainty, diff or spatial overlay |
| Warning | Visible if it blocks or changes the next decision | Evidence, affected target, consequence, owner, and resolution path |
| Result | What changed and check coverage | Open native targets, compare before/after, inspect partial work, start scoped repair |
| World artifact | A preview/link in the same task | Open the large spatial field with the same artifact ID and selection |

The first-run state leads to a working connection and an Inspect request. The empty state offers one credible starter task and the composer. Offline, authentication, incompatible-model, denied-access, interrupted-stream, and provider-protocol errors appear inline at the failed action with a concrete retry or settings path; the draft stays editable. A timeout or empty provider response is an error, never a completed empty assistant turn. Do not render a permanent “connected,” “editor safe,” scan count, or other status decoration while no decision depends on it.

## Controls that actually change behavior

**Model.** The composer shows the chosen provider and exact model ID. The list comes from a provider's live catalog when available, with source and freshness shown in its menu. A cached or manually entered model is labeled as such. An automatic recommendation selects only among models whose availability and required capabilities were verified for this account; it resolves to an exact model ID recorded on the run. Never silently switch a running task's model, infer that a marketing alias is available, or send a key to a different provider. Unsupported or offline catalogs offer an honest manual choice and explicit validation on send.

**Effort.** Effort is a per-model capability, not a universal cosmetic slider. A capability registry maps supported values to each provider's actual request fields and rejects unsupported combinations before starting a run. The chosen effective value is recorded with the run and can be inspected afterward. Providers without an effort control show none. Changing model reconciles effort to a supported value with an explicit indication, never a hidden downgrade.

**Access.** One task-level selector exposes **Inspect**, **Draft**, and **Production**, with concise contracts. Inspect reads only. Draft can produce editable proposals but cannot mutate the project without a separate exact approval; Production can execute approved native actions and must run or explicitly mark required checks. The selector is backed by server tool dispatch and Unreal's native router, including indirect paths such as Python; it does not merely alter a prompt. The existing lease, PIE, editor-unsafe, asset-busy, save/read-only, and approval safeguards remain independent hard stops. A user cannot grant access by editing a message or by changing a visible label. Show the specific gate only when it blocks an action.

Controls are frozen for a run once it starts. Changing them while work is active sets up the next run or requires Stop and retry. Settings hold credentials, endpoint configuration, account state, and advanced policy; the everyday choice of model, effort, and access belongs at the composer. An access or model choice made in Chat must be reflected in the exact request and the task record, and be recoverable after restart.

## Grounded context and tool choice

`@` and the attachment control search selected actors, assets, loaded regions, project files/captures, Hayba skills, and typed tools. Suggestions have a one-line purpose, supported scope, prerequisites, and consequence. A source chip states whether it was user-attached, selected in Unreal, read by a tool, or inferred; a broader project search result is never presented as user-provided context. Selection references are stable Unreal identifiers plus a snapshot/fingerprint, not display names alone. The task remembers the scope used for each run; current editor selection may change without silently rewriting the old evidence.

The tool router first considers Hayba's typed operation and the relevant skill, compares prerequisites and limitations, and records why it chose a method. Generic Python is an explicitly constrained fallback, not the default way to do a supported native operation. For production tasks, the choice record can compare manual placement, PCG, PCG extensions, and hybrid methods against editability, performance, memory, streaming, and project policy where relevant; it must distinguish measured budgets from assumptions. The UI shows this reasoning only when the choice affects approval, cost, or a reported result. Warning review is a required task event before claiming completion when warnings are present; unresolved visual-quality findings remain visible even if a crash check took priority.

Attachments have explicit consent and a preview of what will be sent to a remote model. File size/type limits, image downsampling, secret redaction, and source deletion are enforced by the transport. A model cannot read the whole project merely because a context picker can search it. Loaded-world inspection must state unloaded or unavailable coverage.

### Decision and spatial reasoning behind the same task

The visible Chat is backed by distinct, typed services rather than a single prompt that guesses what the world contains:

```text
SceneObservation  → SpatialIndex → SemanticRelations → ContextQuery
        │                                  │                 │
        └────────→ Coverage/Provenance ────┴───────────────→ DecisionRecord
Tool/SkillRegistry → CandidateMethods → Preconditions ───→ DecisionRecord
BudgetLedger ─────→ Constraints/Measurements ─────────────→ DecisionRecord
DecisionRecord ───→ Proposal → NativeGuard/Execution → Evidence/Warnings
```

`SceneObservation` uses Unreal's actor, component, mesh, PCG, level, and partition records as the canonical object inventory. View/depth samples are valuable observed-view geometry and occlusion evidence, with camera pose, timestamp, range, and coverage; they do not prove that unloaded or hidden objects were observed. A spatial index aggregates dense samples through object, cluster, room/area, and streaming-region levels of detail. A semantic graph records typed relations and their source/confidence separately from geometry. Queries can ask for containment, adjacency, visibility, route, free space, placement constraints, and cross-scale composition; they return source objects and coverage gaps, not just a natural-language guess. The World field renders this evidence, and Chat uses the same query result IDs.

`Tool/SkillRegistry` describes each available native tool, PCG or PCG extension operation, asset workflow, and specialist skill by supported inputs, preconditions, effects, reversibility, expected cost, failure modes, and documented pros/cons. Versioned examples and provider documentation may inform candidate generation, but a retrieved example does not authorize a write. `CandidateMethods` can include manual hero placement, a reusable actor assembly, PCG, a mixed method, or no change. It checks preconditions against the actual project before presenting an option. A cheap classifier or structured extraction model may tag intent, retrieve the right tools and skills, and rank candidates for attention; it cannot be the sole authority for a budget verdict, exact operation, or safety gate. The user-facing task still works when that optional service is unavailable.

`BudgetLedger` holds explicit targets and observations for frame time, memory, draw/instance cost, streaming transitions, NPC load, navigation, texture memory and texel density, and any task-specific quality constraint. Each entry is marked **measured**, **estimated with method**, **declared by user/project**, or **unknown**; it records hardware/build/scenario and timestamp. For UE 5.8, use Unreal Insights and World Partition streaming traces for per-cell time/memory evidence and PCG profiling for generation cost where supported; a still image is not a performance measurement. Scene alternatives are compared on an explainable scorecard: hard constraints first, then several named objectives and uncertainty ranges. Do not collapse unlike scenarios into a single magical score. A city view, for example, must compare the approach, center, and exit with likely loaded cells and NPC activity, rather than quote one empty-viewport frame. The agent can propose occlusion, street shape, streaming transition, density, or tool-choice changes, but should validate each against the project's actual constraints.

`DecisionRecord` binds query results, candidate methods, measured/assumed budgets, tool versions, rejected alternatives, tradeoffs, and the next verification step. It is versioned with the task artifact, so a new scan or budget reading can invalidate a stale proposal. The normal Chat view shows only the recommended action and material tradeoff; expanding exposes the comparison and its evidence. This makes the assistant systematic without turning the dock into a production dashboard. Existing research systems for hierarchical 3D query, point-cloud structure, placement reasoning, and cost-aware planning are evaluation references for these interfaces, not dependencies chosen without an Unreal-specific benchmark.

Evaluated references and their boundaries:

| Reference | Useful idea for Hayba | Limit before adoption |
| --- | --- | --- |
| [ReLaGS](https://dfki-av.github.io/ReLaGS/) | Hierarchical semantic scene graph and relational open-vocabulary queries over 3D structure | Its pipeline begins with a reconstructed Gaussian scene; Hayba already has native meshes, actor IDs, and depth, so training/reconstructing Gaussian splats from photographs is not the default ingestion path. Benchmark its query ideas against Unreal-native indexing. |
| [SpatialLM](https://github.com/manycore-research/SpatialLM) | Structure from point clouds, especially rooms, walls, doors, and object bounds | Its published model emphasizes indoor, axis-aligned point clouds. It is a candidate for bounded interior inference, not a universal outdoor/world-partition oracle. |
| [PlaceIt3D](https://nianticlabs.github.io/placeit3d/) | Placement queries must consider free space and multiple valid geometric relationships | A research benchmark and baseline, not an Unreal editing or approval engine. Use its evaluation framing for ambiguous placement tasks. |
| [Agent JIT Planning](https://mast.stanford.edu/pubs/jit_planner/) | Validate candidate plans against tool specifications, preconditions and postconditions, then compare scheduling cost | Demonstrated on web agents. Adopt the invariant/checking principle only after validating native editor side effects and lease constraints. |
| [GLiNER2.5-Decide](https://fastino.ai/blog/gliner-2-5-decide-open-weight-decision-model) | A small local schema-based classifier can tag task intent, relevant tools/skills, warning categories, and routing candidates before an expensive general model turn | Its published benchmark is internal and cross-domain, not a game-production or exact tool-choice validation. Confidence is a routing signal, not authority. Benchmark it against deterministic retrieval and ordinary model selection. |
| [GLiDE](https://fastino.ai/blog/introducing-glide-the-first-thinking-decision-model) | An optional structured choice model can compare a bounded set of already-eligible methods or next steps when tool dependencies and tradeoffs make a simple classifier uncertain | It is hosted via Fastino's API and its reported benchmark advantage is vendor-reported. Send only a consented, redacted abstract state; hard preconditions, safety and budget checks remain native. Measure its cost, latency and error rate against a simpler route. |
| [Unreal World Partition Insights](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes?lang=en-US) and [PCG profiling](https://dev.epicgames.com/documentation/unreal-engine/pcg-runtime-generation-debugging-in-unreal-engine) | Per-cell streaming traces and PCG node cost provide production evidence for the BudgetLedger | Some 5.8 features are experimental; availability, capture conditions and missing coverage must be recorded rather than inferred. |

The task API should expose the same warnings, coverage, candidate method and evidence IDs to an external orchestrator that the dock shows to a person. A tool call that detects a warning returns its stable `warningId` and affected targets; a completion/verdict request checks the warning ledger and required evidence. This prevents an orchestrator from overlooking UI-quality findings merely because another, more urgent issue dominated its prose summary.

## Native actions, approvals, and evidence

A proposal is an immutable, versioned operation set. Its compact card shows affected actors/assets, create/modify/delete counts, save behavior, expected performance or memory effects where known, unsupported steps, and required checks. Expanding gives exact targets and operations. Approval binds `proposalId + artifactVersion + targetFingerprint + operationDigest + policyVersion` and is consumed once. A changed target, policy, proposal, or expired lease invalidates it. Rejecting or editing produces an event and a new proposal version; no stale pending command can survive a new conversation turn. External MCP actions must pass the same native gates and may require their own source-labeled proposal; the UI must never call a broad “approve next command” an exact approval.

Execution updates the proposal/result card rather than spawning disconnected pages. The user sees partial success, failure, cancellation, and any operation that cannot be rolled back. Native transaction/undo appears only for an operation whose inverse is known and still applicable. Verification records each required check as `passed`, `failed`, or `not_run`, with scope, method, timestamp, and evidence link. A lack of findings is not validation. “Production ready” is unavailable when required checks fail, are unsupported, or have not run. A warning ledger keeps unresolved issues attached to the task and target until a recorded resolution or explicit accepted limitation.

The World field opens on the same `taskId` and `artifactId`. Its scene-derived samples, object/region hierarchy, coverage, and semantics link back to stable target references. Selecting a cluster highlights the corresponding Unreal object and moves task focus to the same evidence or proposal; selecting an inline artifact opens that cluster. World is a larger 3D field, never a miniature text-heavy panel inside the narrow dock. Unknown and unloaded geometry remain visibly unknown. Any scene comparison is conditional on matching capture scope and measurement method. The field and Chat share the visual system, warning vocabulary, and source provenance.

## External hosts and multi-agent work

The best shared experience is one Hayba **task timeline** containing in-editor turns and Hayba-observed work from external MCP hosts. The in-editor Chat shows the full turns started there. For an external host, Hayba can show only the tool requests, proposals, edits, warnings, and checks that passed through Hayba, grouped under a source label and task ID. It must not fabricate the host's private conversation, hidden reasoning, or unrelated filesystem work. External events join a task only through an explicit task/correlation ID or a user-approved link; unlinked events remain discoverable in a separate recent-activity search, not silently merged into a conversation.

Multi-agent runs group child work by task, owner, target scope, lease, and dependency. The timeline names waiting, conflict, handoff, and completion states only when they affect progress or review. Independent agents can work concurrently on separate targets. Shared target writes honor the native lease/asset-busy policy; a successful UI handoff cannot override a refused write. Source labels are based on a verified connection identity when one exists, otherwise an honest “External MCP client” label.

## Craft and operational quality

Keep the approved Hayba logo, licensed Noto Sans, sentence-case copy, warm-charcoal surface, restrained ochre attention color, rounded but precise controls, and one consistent licensed icon family. Icon-only controls need visible keyboard focus, accessible names, and tooltips. Native Slate widgets and popups use the same tokens and states; stock dropdowns and all-caps display labels break the surface. Material warnings have clear contrast; routine traces recede. Avoid decorative motion, status-chip strips, duplicated headings, and dashboard counts with no immediate utility.

The dock must support keyboard-only send, multiline entry, Stop, task switching, search, menus, proposal review, and focus return. Screen-reader semantics should be attached wherever Slate supports them; status changes need an accessible announcement equivalent. Test narrow and wide dock widths, high-DPI, long names, long streams, hundreds of activity events, and reduced-motion preferences. Virtualize the timeline and World detail lists; cap rendered point budgets and keep heavy scene sampling away from input-frame work. A run's local UI should remain responsive while the model or editor is busy. Errors and tool results remain distinguishable without color alone.

## Build sequence to the complete target

The stages are implementation boundaries, **not a reduced final promise**. Keep old behavior reachable until the corresponding task flow passes parity checks; then remove the obsolete destination rather than preserving a second source of state.

1. **Reliable conversation foundation.** Fix the no-reply path, robustly surface provider/auth/protocol errors, preserve drafts, and verify send/stream/Stop/retry/resume in a scratch editor with mock and real configured providers. Replace any completion state that can succeed with no assistant text or useful action.
2. **Canonical task and event store.** Introduce stable IDs, versioned artifacts, ordered durable events, deduplicated replay, migration from text sessions, and shared projections for Slate and World. Define the schema and bounded/redacted storage before new cards depend on it.
3. **Real composer controls and context.** Connect live model discovery, verified automatic recommendation, provider capability/effort mapping, access enforcement, context capture, attachments, and skill/tool search end to end. Test rejection of unsupported combinations and indirect-write paths.
4. **Inline review and execution.** Render typed work, exact proposals, warnings, partial results, diffs where real, and check evidence. Replace broad approvals with version-bound authorization in the backend and native router. Make cancellation and invalidation unambiguous.
5. **External and parallel continuity.** Correlate Hayba-observed MCP events by task, label provenance, show owner/lease dependencies, and verify concurrent independent work versus conflicting writes. Preserve transcript privacy boundaries.
6. **Linked World and production workflows.** Bind scene-derived hierarchy, selections, warnings, and spatial proposals to the same task artifacts; complete representative safe native workflows and their budget/quality checks. Validate dense scenes and unloaded-world honesty.
7. **Finish and migration.** Review real narrow/wide editor captures and keyboard behavior; correct popup/icon/type/color inconsistencies in one system pass. Remove Activity/Plan/Diff/Validation/Library tab islands only when their useful operations are available from Chat, context search, or the linked World field. Benchmark performance and run full UE, Node, and scratch live gates before release.

## Release acceptance

The complete experience is ready only when all of these are demonstrated in a scratch Unreal project and recorded as evidence:

- A user sends a simple message to a configured provider and receives visible streamed content or a specific recoverable error. A provider returning empty/unterminated output cannot look successful. Restart restores the exact task, draft where appropriate, timeline, artifacts, warnings, and selected model/access; SSE reconnect neither duplicates output nor repeats a tool.
- Switching provider/model/effort from the composer changes the actual next request. The UI refuses an unsupported effort, labels stale catalog data, and never moves credentials across providers. Inspect, Draft, and Production each receive native/backend enforcement tests, including a generic execution fallback.
- A selected actor/asset/region enters the task as explicit context; the agent's observation records loaded-world coverage. Searching and attaching context does not imply blanket provider access to the project.
- A representative edit has an exact, inspectable, versioned proposal. Editing a target after preview invalidates approval. Approve executes only the frozen operations once. Reject, Stop, disconnect, and partial execution leave an accurate task state and recovery path.
- Required validation and warning review are visible in the same task. A failed, unsupported, or unrun check prevents a production-ready claim. An unresolved UI-quality warning remains visible beside other safety findings.
- Opening a World artifact preserves the task and selected object; selecting its spatial cluster returns to the same target and evidence in Chat and Unreal. Dense-scene interaction remains within a measured UI frame and memory budget, and unloaded scope is not represented as observed.
- An external MCP action appears only as a Hayba-observed, source-labeled event; its host transcript is not invented. Two agents can work on independent assets, while a conflicting write is refused and explained. Secrets and private project material do not appear in public fixtures, logs, captures, or release assets.
- The 350–500 px dock, wide view, popups, icons, and all material states pass a visual and keyboard review against the approved identity. Obsolete tabs have no unique required action trapped inside them.

This release contract does not waive separate safety-train manual editor checks. A human observation remains pending until the person actually performs it.
