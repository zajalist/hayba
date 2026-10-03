# Production Chat implementation plan

Authority: [production-chat-brief.md](production-chat-brief.md), [editor task-workspace shape](../2026-10-02-editor-task-workspace/SHAPE.md), and the reviewed P0 safety rulings. This plan is sequenced for review; independent files may be developed in parallel. A stage is complete only when its behavior is demonstrated in the scratch editor, not when a control merely appears.

Global constraints: Public files contain no private game material. Do not manipulate the user's active game editor. Preserve native lease, PIE, unsafe-editor, asset-busy, save, and approval gates. Scratch builds use `-NoHotReloadFromIDE`. Never claim human P0 checks or a real provider reply without evidence. Keep the task dock minimal and World a larger linked surface.

## Task 1 — Reliable conversation foundation

Trace a single message through Slate HTTP callback, sidecar SSE, provider adapter, session store, and recovered turn. Make empty/unterminated/auth failures visible and recoverable, preserve drafts, and ensure a semantic terminal event before a turn is called complete. Cover send/Stop/retry and callback deferral with focused tests and a scratch editor run. Existing fixes on the integration branch are the starting point; review and complete them, do not reimplement them.

## Task 2 — Exact native approval

Replace the external approval's broad task prose with a view of the actual pending native operation, stable target references, source identity, version/fingerprint, and consequences. Bind approve/reject to that exact operation; stale or changed operations must refuse. Give the native Chat card proper review controls and hide the empty welcome prompt while approval is pending. Preserve the reviewed P0 lease and plan rulings. Test an edited target, a stale proposal, reject, and double approval.

## Task 3 — Readable conversation and typed work

Render assistant prose, paragraphs, lists, code/copy, object links, tool progress, warnings, and results with one restrained message system at 360–500 px. Store typed events rather than parsing final prose for actions. Collapse routine trace and keep consequential failures or approvals inline. Verify long output, streamed updates, keyboard navigation, and text selection/copy in scratch captures.

## Task 4 — World states and spatial field

Make loading, no level, no renderable geometry, partial coverage, and failure distinguishable with one useful next action each. Complete the scene-derived dense sampled field, object/region hierarchy, semantic/provenance lookup, adaptive LOD, and selection bridge without claiming unseen/unloaded geometry. Measure sampling latency and frame/memory cost. Validate on a synthetic dense scratch scene and capture the rendered field at narrow and wide widths.

## Task 5 — Model and effort controls

Expose provider/model in the composer from live discovered catalogs with honest freshness/manual states. Reconcile key configuration before first discovery. Map effort only for models/providers that support it and validate the wire request; unsupported effort cannot look selected. Freeze effective provider/model/effort per run and restore it with the task. Test current official and custom/local providers without assuming a model alias exists.

## Task 6 — Enforced access and tool choice

Give Inspect, Draft, and Production one per-run access contract enforced in Node and the native router, including indirect Python paths and external MCP. Integrate a typed Tool/Skill Registry with preconditions, effects, pros/cons, and provenance; prioritize native operations before generic execution. An optional Fastino decision adapter may rank eligible candidates but cannot override native safety or budget rules. Verify denial and approval paths with adversarial tests.

## Task 7 — Durable task/event store

Create one bounded, redacted, replayable Task/Run/Event/Context/Artifact/Proposal/Evidence model. Use stable IDs and idempotent sequence/reconnect handling so restoring a session reproduces cards and warnings without repeating tools. Migrate older text sessions as text-only history. Test crash/restart, duplicate SSE, resume gaps, and active-run uncertainty.

## Task 8 — Grounded context and attachments

Add `@` and attachment search for selected actors, assets, loaded regions, captures, skills, and typed tools. Preserve stable object references, observed/inferred/unknown provenance, size limits, redaction and explicit remote-egress preview. Scope each run to a captured context snapshot; an editor selection change cannot rewrite prior evidence. Test asset/folder lookup, unloaded scope, long names, and rejected secret/oversize payloads.

## Task 9 — Inline artifacts, checks, and external continuity

Project exact proposals, changes, diffs where transaction-bound, warning review, `passed`/`failed`/`not_run` checks, and partial results into the originating task. Correlate external MCP events only when Hayba observes and links them; label source honestly, never invent a host transcript. Show multi-agent owner, lease and waiting reasons when material. Test two independent writers, one conflict, an unresolved warning, and a failed check.

## Task 10 — Production scene decision workflow

Connect SceneObservation, SpatialIndex, SemanticRelations, ContextQuery, Tool/SkillRegistry, BudgetLedger and versioned DecisionRecord. Compare viable manual, reusable assembly, PCG/PCG extension and hybrid methods against actual project preconditions. Distinguish measured, estimated, declared and unknown frame, memory, streaming, NPC, texel-density and quality constraints. Use Unreal profiling and world-partition evidence where available; optional lightweight decision agents route/rank but do not certify. Demonstrate a real scratch composition task with two alternatives and an explainable, non-fabricated scorecard.

## Task 11 — Finish integrated visual system and release gate

Unify verified icons, rounded controls, dropdowns, typography, keyboard focus and accessible names across Chat, World, Settings and contextual detail. Remove old tab destinations only after their useful actions are reachable from the task. Run independent Impeccable critiques on fresh current Slate captures after material fixes, address P1 findings, and rescore. Gate on scratch full UE/Node/live checks, CI/CodeQL, public privacy scan, and still-pending human P0 checks before `v0.4.0` main release.
