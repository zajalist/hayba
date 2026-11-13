# UE 5.9 editor workflow research — 2026-11-13

Research-only findings from current source, including the uncommitted HTML chat/media/subagent work. No live provider calls, desktop control, native compilation, or editor mutation during research. Recommendations are engineering inferences, not verified runtime behavior.

## Verified engine baseline

Public [UE 5.9 Preview release notes](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-5-9-release-notes) exist and were last updated November 9, 2026. They describe expanded Python/editor scripting, Unreal Canvas, native toolsets and Toolset Registry, and MCP configuration. Treat this installation as **5.9 Preview**, not a claimed final release. Local `C:/Program Files/Epic Games/UE_5.9/Engine/Build/Build.version` reports 5.9.0, CL 60351404, `++UE5+Release-5.9`.

Local engine headers, rather than assumptions about previous versions, establish these usable APIs:

- `Engine/Plugins/Editor/DataValidation/Source/DataValidation/Public/EditorValidatorSubsystem.h`: per-asset results; requested/checked/skipped/unable counters; `bWasCancelled`; `bAssetLimitReached`; `MaxAssetsToValidate`; silent progress and message-log settings. Existing Hayba validation already uses this subsystem.
- `Engine/Source/Runtime/AssetRegistry/Public/AssetRegistry/IAssetRegistry.h`: `EnumerateAssets(FARFilter, callback)` can stop enumeration via the callback. Use bounded enumeration before loading folder contents.
- `Engine/Plugins/Chooser/Source/ChooserEditor/Public/ChooserTableEditorLibrary.h`: discover available column/result types, inspect rows/columns/bindings and edit them using native transaction-aware APIs. Header states unsuccessful edits leave assets untouched. This is a specific, small net-new domain opportunity after reliability fixes.
- `Engine/Plugins/Experimental/ToolsetRegistry/Source/ToolsetRegistryEditor/Public/ToolsetRegistry/ToolsetRegistrySubsystem.h`: subsystem is a compatibility facade; its comment directs new code to `UE::ToolsetRegistry::FToolsetRegistry::Get()`. Do not build a second Hayba protocol around that facade merely because 5.9 ships it.
- `Engine/Plugins/GaussianSplat/Source/GaussianSplatEditor/Private/GaussianSplatFactory.cpp:805`: installed factory advertises PLY and SPZ. This advances the feasibility of a future explicit splat import, but does not prove downloaded provider assets safe, imported, correctly scaled, or rendered. Preserve the existing guarded import boundary; do not automatically load remote files in process.

## What already exists — avoid duplicating

`docs/design/2026-11-12-agentic-editor-research.md` already establishes task navigation, media connections, contextual references and honest recovery. Current `Resources/chat/workspace.js` implements thread/turn/agent navigation, captured selection references, media jobs and provider state. `HaybaMCPChatPresentation.cpp` projects activities and step input/result JSON into the HTML transcript.

Backend capabilities already include `editor_get_state` (PIE ownership, compile/shader/save activity, health, optional dirty-package walk), `checkUeStatus` (connection/process/sidecar health), `copilot_health`, `asset_validate`, `content_validate`, output log streaming, plugin listing, asset dependencies, scene exports, camera/viewport tools and a substantial searchable tool catalog. The initial batch should connect and correct these instead of adding synonymous tools.

## Ranked changes

### 1. Make asset validation truthful and bounded — immediate

**Evidence:** `Private/handlers/HaybaMCPAssetHandler.cpp:2332` sets `valid` solely from `Results.NumInvalid == 0`. All-skipped/all-unable/cancelled validation can therefore look successful. The same function recursively materializes an entire folder through `GetAssetsByPath` and leaves engine `MaxAssetsToValidate` at its effectively unlimited default. `src/tools/asset-graph/asset-validate.ts` exposes only `path`; `src/tools/index.ts:3094` documents fewer counters than the native handler actually supplies.

**Small batch:** preserve existing fields, tighten `valid` to mean the requested scope was actually validated without failures, and add explicit status/coverage, cancellation and limit metadata. Introduce a bounded optional `max_assets`; reject an oversized folder before loading/validation, with a narrower-path hint. Keep genuine invalid results separate from “not validated.” Use the engine limit for validator-discovered additions; never silently return a passed prefix. Account for the engine setting `bAssetLimitReached` even when exactly the limit was checked—surface the raw flag and avoid claiming incomplete work solely from that flag when coverage is demonstrably complete.

**Checks:** pure native result shaping tests for all-skipped, no validator, partial coverage, cancellation, limit, warnings-only and invalid results; TS invalid-budget rejection/forwarding; native preflight refusal for oversized input; a disposable editor test with an unsupported asset and a known valid asset. No new generic validation service.

### 2. Show authoritative editor health beside chat recovery — next

**Evidence:** `HaybaMCPChatPresentation.cpp::UpdateWebTranscript` projects model credentials, busy/review state, media connections and job state, but not the existing editor health snapshot. `workspace.js::connections` is specifically for paid media providers. A user cannot diagnose an unsafe editor or bridge failure from that surface. `src/tools/check-ue-status.ts` already has structured `editor_restart_required` and safe-save distinctions. Its process recommendations can suggest killing a headless process based on presence rather than exact listener ownership—do not promote these strings into one-click destructive actions.

**Small batch:** expose a compact read-only status and an explicit refresh, showing local editor, bridge/sidecar, active project, last observation and relevant recovery action independently. Reuse `editor_get_state` with `include_dirty:false` for routine probes; only collect dirty packages on demand. Preserve drafts. Show “restart required” for sticky native faults and the existing no-save warning for stranded saves; never make an automatic restart/replay feature.

**Checks:** unavailable sidecar while editor is healthy; unsafe editor while TCP still answers; expired observation; failed refresh retains last state with stale marker; no credentials in copied diagnostic summary; duplicate processes must remain ambiguous until socket identity is established.

### 3. Make tool discovery report availability and expected proof — next

**Evidence:** `src/tools/routing/tool-index.ts::SearchHit` returns name/summary/packs/score only. `search-tools.ts` searches a static tool index. Native plugin availability and editor state already exist elsewhere, so a high search score is not evidence a dependency is enabled or a tool safe to run now.

**Small batch:** enrich signature/discovery responses with existing effect/cost metadata and a bounded capability snapshot when requested. Clearly distinguish registered, dependency unavailable, unprobed, and blocked by current editor state. Start with common native prerequisites and do not fetch status for every indexed tool or expand every schema into the prompt. Add natural-language search cases for “why can't the editor save,” “verify imported asset,” and “validate only these assets.”

**Checks:** optional plugin absent; disconnected editor; status observation stale; read-only subagent receives truthful unavailable capabilities. Preserve the current Code Mode interface.

### 4. Close scene/asset iteration with explicit evidence — next small workflow

**Evidence:** existing activity projection already exposes each tool's input/result, but typed asset targets and validation status are flattened into generic step JSON and verdict strings. Existing import-vetting, mesh-LOD and texture-memory workflow skills already call `asset_validate` after mutations.

**Small batch:** link the exact changed asset/actor from an activity step, show the existing returned before/after/readback and distinguish validation “not run,” “partial,” and “passed.” Add an explicit “inspect result” action that uses the existing resolve/show-asset route. Continue to distinguish dirty-in-memory from saved and imported from downloaded. A fixed-camera capture comparison can use existing tools; do not introduce universal rewind.

### 5. Add a bounded Chooser inspection tool before broad UE5.9 tool expansion

**Evidence:** no Chooser/StateTree tools appeared in the current production TS tool source search. The 5.9 Chooser editor scripting header supplies purpose-built introspection without manually decoding instanced structs.

**Small batch:** `chooser_inspect` returning signature, bounded row/column pages, types and bindings; only later add one set-cell operation with before/after readback, native transaction and explicit save. Probe Chooser availability and handle no-validation/failed API results honestly. Do not simultaneously implement arbitrary Blueprint, StateTree, Dataflow and toolset-registry forwarding.

## Agentic UX evidence and implications

[Claude Code subagents](https://code.claude.com/docs/en/sub-agents) documents independent context and permissions, constrained tools, and returning results to the parent. Hayba already has child task work in progress, so the next value is verifiable result handoff and honest terminal/cancelled states rather than another agent sidebar. Preserve read-only child defaults until shared-editor mutation ownership is demonstrably enforced.

[Claude Code in VS Code](https://code.claude.com/docs/en/vs-code) documents selection context, resumable conversations, interrupted-step handling and background work. Hayba's captured selection and thread navigation already pursue those workflows; recovery should preserve context and identify which failed action is safe to repeat.

[OpenAI's Codex app introduction](https://openai.com/index/introducing-the-codex-app/) documents project threads, review of changes inside the thread and isolated worktrees. For Unreal, the transferable principle is reviewing concrete effects in the conversation. Worktree isolation does not isolate a shared running editor: Hayba's native leases and approval identity must remain authoritative.

## Recommended achievable first batch

1. Correct and bound `asset_validate`, with focused native and TS tests.
2. Add one read-only editor diagnostics projection and Refresh action using current health APIs.
3. Display validation coverage and exact asset links on existing activity cards.

Then evaluate Chooser inspection as the first new UE5.9-specific tool. Reuse existing schemas, dispatcher, provider vault, transport, transaction and evidence mechanisms. No new UI framework, semantic World map, transport, service, paid-provider job, or wholesale native toolset mirror is needed.

Verification boundary: source and documentation research only. Local engine source establishes API presence, not loaded-plugin availability. The browser-harness skill path supplied in global instructions was absent; no browser/desktop automation was required. Implementation and runtime evidence belong in a separate handoff.
