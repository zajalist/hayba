# Agent Activity Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chat the single operating surface by representing plans, tool calls, diffs, approvals, verdicts, and specialist work as one semantic activity stream.

**Architecture:** Normalize sidecar output into provider-neutral semantic events, persist redacted conversation/activity summaries, then render those events through a module-owned C++ model. Existing panels continue to compile until the new Agent surface has parity.

**Tech Stack:** TypeScript, Express/SSE, Vitest, Unreal Engine C++/Slate

**Spec:** `docs/superpowers/specs/2026-09-22-agent-workspace-world-tools-redesign.md`

## Global Constraints

- The C++ UI is a thin client; orchestration and persistence stay in TypeScript.
- The UI may not infer state by parsing human-readable tool output.
- Raw secrets and unredacted tool arguments may not be persisted.
- Specialist agents share one canonical tool catalog; they do not register parallel tools.
- Existing Plan Mode and cancellation behavior must remain functional throughout migration.

---

### Task 1: Semantic activity events

**Files:**
- Create: `mcp-tools/hayba-mcp/src/chat/activity-events.ts`
- Create: `mcp-tools/hayba-mcp/src/chat/activity-events.test.ts`
- Modify: `mcp-tools/hayba-mcp/src/chat/agent-loop.ts`

**Interfaces:**
- Produces: `ActivityEventSchema`, `ActivityState`, `AgentStreamEvent`, and `reduceActivity(state, event)`.
- Event kinds: `message_delta`, `activity_started`, `activity_step`, `approval_requested`, `artifact_proposed`, `verdict_emitted`, `activity_completed`, `error`.

- [ ] Write failing reducer tests for valid transitions, duplicate completion, approval resume, cancellation, and error termination.
- [ ] Run `npm test -- src/chat/activity-events.test.ts`; expect missing-module failure.
- [ ] Implement strict discriminated Zod event schemas and a pure reducer that rejects invalid transitions with stable error codes.
- [ ] Adapt `agent-loop.ts` to yield `AgentStreamEvent` without removing the old frame adapter yet.
- [ ] Run `npm test -- src/chat/activity-events.test.ts src/chat/agent-loop.test.ts && npm run typecheck`; expect PASS.
- [ ] Commit with `git commit -m "feat(chat): define semantic activity events"`.

### Task 2: Specialist routing over one catalog

**Files:**
- Create: `mcp-tools/hayba-mcp/src/agents/specialist-router.ts`
- Create: `mcp-tools/hayba-mcp/src/agents/specialist-router.test.ts`
- Modify: `mcp-tools/hayba-mcp/src/agents/agent-registry.ts`
- Modify: `mcp-tools/hayba-mcp/src/chat/agent-loop.ts`

**Interfaces:**
- Produces: `selectSpecialist(intent, manifest, availableTools, pinnedId?)` returning `{id, toolNames, reason}`.
- Consumes: existing archetype `tool_filter` globs and the canonical captured tool map.

- [ ] Write failing tests proving automatic selection, pinned `/agent` selection, unknown-agent errors, and intersection with enabled tools.
- [ ] Run the focused test and verify failure.
- [ ] Implement deterministic scoring based on declared capability tags/system guidance; ties fall back to the coordinator, never random choice.
- [ ] Emit specialist identity only on `activity_started` and expanded `activity_step` frames.
- [ ] Run agent registry, router, and loop tests plus typecheck.
- [ ] Commit with `git commit -m "feat(chat): route work through specialist profiles"`.

### Task 3: Redacted conversation persistence

**Files:**
- Create: `mcp-tools/hayba-mcp/src/chat/session-store.ts`
- Create: `mcp-tools/hayba-mcp/src/chat/session-store.test.ts`
- Modify: `mcp-tools/hayba-mcp/src/chat/chat-server.ts`
- Modify: `mcp-tools/hayba-mcp/src/chat/chat-server.redaction.test.ts`

**Interfaces:**
- Produces: `SessionStore.list()`, `load(id)`, `append(id, record)`, `create()`, and `remove(id)`.
- Persists messages, compact activity summaries, artifact references, and provider-neutral usage only.

- [ ] Write failing tests that round-trip a session and prove API keys, authorization headers, and raw tool arguments never reach disk.
- [ ] Run focused tests and verify failure.
- [ ] Implement atomic JSON session writes beneath the existing Hayba saved-data location, applying the central redactor before serialization.
- [ ] Add list/load/create/delete routes and make `/chat/stream` append semantic summaries.
- [ ] Run persistence, server, and redaction tests plus typecheck.
- [ ] Commit with `git commit -m "feat(chat): persist redacted agent sessions"`.

### Task 4: Module-owned C++ activity model

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPActivityModel.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPActivityModel.cpp`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Tests/HaybaMCPActivityModelTest.cpp`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaMCPModule.h`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPAgentClient.*`

**Interfaces:**
- Produces: `EHaybaActivityState`, `FHaybaActivityStep`, `FHaybaActivity`, and `FHaybaActivityModel::ApplyEvent(const FJsonObject&)`.
- Produces module access via `GetActivityModel()` and `OnActivityChanged`.

- [ ] Add failing automation tests for every state transition, reconnect-to-unknown, duplicate terminal events, and approval actions.
- [ ] Run focused Unreal automation test; expect missing model failure.
- [ ] Implement a plain model with no Slate dependencies and strict semantic-frame decoding in the agent client.
- [ ] Run focused automation test; expect PASS.
- [ ] Commit with `git commit -m "feat(ui): add module-owned agent activity model"`.

### Task 5: Agent activity cards and persistence UI

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.h`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.cpp`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slate/SHaybaActivityCard.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/Slate/SHaybaActivityCard.cpp`

**Interfaces:**
- Consumes: `FHaybaActivityModel` from Task 4.
- Produces: collapsed and expanded activity cards with approve/reject/cancel/retry/undo/save-as-recipe actions.

- [ ] Add a Slate automation test that constructs all five states and asserts visible labels/actions without parsing tool prose.
- [ ] Run the test and verify failure.
- [ ] Implement cards using model fields; keep raw payload/log display behind an expansion control.
- [ ] Replace chat's direct `OnToolCallRecorded` trace rendering with activity-model observation and wire recent-session loading.
- [ ] Verify streaming does not steal focus and pinned-scroll behavior remains intact.
- [ ] Build the plugin and run focused UI automation tests.
- [ ] Commit with `git commit -m "feat(ui): embed activity cards in agent chat"`.

### Task 6: Remove standalone activity ownership

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPPlanPanel.*`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPDiffPanel.*`
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPToolStreamPanel.*`
- Modify: `docs/wiki/UE-Plugin.md`

**Interfaces:**
- Consumes: activity-model parity from Task 5.
- Produces: no new interface; removes producer logic from panels before the shell deletes them.

- [ ] Add a repository assertion test/script proving Plan, Diff, and Tool Stream no longer own subscriptions or mutable state.
- [ ] Move any remaining producers into `FHaybaActivityModel`; retain temporary read-only adapters only if the old shell still requires compilation.
- [ ] Run MCP chat tests, plugin build, and the ownership assertion.
- [ ] Document Agent as the only plan/diff/tool-trace surface.
- [ ] Commit with `git commit -m "refactor(ui): consolidate execution state under Agent"`.
