# Agent profiling — first measured slice

**Date:** 2026-09-24
**Status:** Proposed for written-spec review
**Scope:** Built-in Hayba Agent, UE 5.8 editor plugin, and MCP sidecar

## Intent and success

Users should be able to ask the in-editor Hayba Agent to profile a scene and receive a small, attributable baseline that distinguishes measurements from hypotheses. This is the first slice of the planned UE performance tooling, not a promise that Hayba can diagnose every GPU, streaming, PCG, or World Partition problem yet. No new top-level destination, profiling dashboard, or independent specialist chat room is added.

Success means that a request such as “profile this scene” routes to a focused profiling specialist, runs read-only native tools, and reports the capture context, sample window, measured numbers, source tools, and unknowns in the existing Agent conversation. A missing CVar must never appear as a real zero. A one-shot editor reading must never be described as packaged-game performance. The user can repeat the same capture after a separately approved change and compare like-for-like contexts.

## Existing system and selected approach

The plugin already has `editor_get_performance_stats`, which returns current average FPS/frame time and game/render-thread times, but not a bounded capture with context. The Python-backed `editor_cvar_get` and `editor_cvar_set` warn that nonexistent names can be indistinguishable from zero. The native `editor_run_console_command` writes output to the general log rather than returning scoped output. The `quality-reviewer` archetype can see `editor_get_*` tools, but its prompt and filter do not give it a reliable performance workflow.

We will add a narrow profiling specialist behind the existing chat router and two read-only native tools. The alternative of merely expanding Quality Reviewer would avoid one archetype but mix performance-specific measurement rules into general QA; exposing arbitrary console execution as the profiling primitive would be powerful but unnecessarily hard to constrain and audit. The profiler is an implementation detail of Agent, consistent with the approved workspace architecture. Quality Reviewer may use the same read-only tools when reviewing production readiness; it does not pretend to dispatch another agent.

## First-slice behavior

1. The user asks for a profile in Agent chat. Automatic routing recognizes profiling/performance intent, or the existing specialist pin can select the profiler. No new mode or navigation is introduced.
2. The profiler calls `performance_snapshot` and, when relevant, `cvar_query`. It may use `world_inspect` for loaded-world context. Its allowlist contains no setters, arbitrary console execution, Python escape hatch, or asset mutations.
3. The response has compact **Measured**, **Possible causes**, and **Not measured** sections. Every measured claim names the tool result and its context. Suspected GPU/streaming/PCG causes stay hypotheses until a later tool measures them. No optimization is applied in this slice.
4. A later user-approved change can be checked by a second snapshot. The agent compares only captures with compatible play state, map, sampling window, and camera/scene conditions; otherwise it explains why the comparison is inconclusive.

### `performance_snapshot`

Native, read-only, and bounded. The plugin records at most 600 recent per-tick samples over the last 5 seconds, clearing the window when the world or play state changes. A tool call reads that window without blocking the editor game thread to wait for frames. A measured response requires at least 10 samples spanning at least 1 second. The response includes:

- capture time, editor world package, `editor` or `PIE` context, sample count, elapsed window, and whether the viewport/PIE session was active;
- editor/PIE tick delta from `FApp::GetDeltaTime()` and game/render-thread cycle counters converted with `FPlatformTime::ToMilliseconds`, each summarized in milliseconds and explicitly named by source; FPS only as a derived/display value from the same tick window where valid;
- `status: measured | insufficient_samples | unavailable` plus a reason when no defensible window exists.

The implementation plan must verify those counters and choose the sampling hook against UE 5.8 headers. In particular, editor tick time must be labeled editor-process data, not game-only frame time. Per-thread counters that are unavailable or stale in a given context are omitted with a reason, never reported as real zeroes. No GPU time, VRAM, texture-pool, PCG cost, or CPU/GPU-bound verdict appears unless a verified source is added in a later slice. The finite sample cap and short retention keep overhead and memory bounded. The tool never saves an asset or starts/stops PIE.

### `cvar_query`

Native, read-only exact-name lookup through UE's console-variable registry. Accept 1–32 names per call; reject empty names and oversized requests before dispatch. Each result includes `name`, `exists`, and—only when found—string `value`, `default`, `lastSetBy`, `help`, and relevant flags. Missing names return `exists: false` with no synthetic numeric value. Output/help are bounded; any truncation is declared. The first slice does not support broad wildcard enumeration or promise a reliably inferred numeric type.

UE 5.8 exposes registry lookup, current/default string values, help text, flags, and the set-by priority through `IConsoleManager`/`IConsoleVariable`; the implementation must verify each returned field against that API rather than parse general log text. Existing Python CVar tools remain for compatibility but are not the profiler's evidence source. No CVar mutation is included here.

## Integration boundaries

- C++ handlers own native data collection and truthful failure responses; they do not generate narrative diagnoses.
- TypeScript tool descriptors own schema, metadata, capability discovery, and `executeCommand` dispatch. Existing tool routing/disabled-tool controls continue to apply.
- `hayba.agents.json` defines `performance-profiler` with performance intent keywords and a read-only tool filter. Adjust overlapping Quality Reviewer keywords so performance requests select the profiler deterministically without degrading general QA requests. The agent loop retains its current “one specialist per turn” behavior.
- Existing Agent activity/tool traces supply provenance. No special result card is required in this slice; chat copy can make the profile readable without inventing measurements.
- The C++ plugin remains the authority on command availability and project state. A disconnected editor, inactive/insufficient sample window, missing CVar, or disabled tool yields an explicit unknown/error rather than a guessed value.

## Safety and interpretation

The profiler never changes CVars or runs arbitrary console commands. It must not recommend globally disabling deformable-shadow invalidation or claim that `foliage.MaxEndCullDistance` constrains plain PCG ISM/Nanite. It must distinguish configured pool/budget ceilings from observed usage. Those anti-rules come from the linked handoff and remain relevant when later diagnostic tools arrive.

The result is a baseline, not a complete bottleneck attribution. Unreal Insights remains the deeper per-frame CPU/GPU investigation path; Epic's [profiling introduction](https://dev.epicgames.com/documentation/unreal-engine/introduction-to-performance-profiling-and-configuration-in-unreal-engine) and [Timing Insights documentation](https://dev.epicgames.com/documentation/unreal-engine/timing-insights-in-unreal-engine) describe why frame time alone cannot identify the cause.

## Acceptance evidence

- Native tests exercise exact existing/missing CVar names, real zero versus absent, defaults and set-by provenance, input bounds, and no world/package dirtying.
- A native test records a bounded snapshot in the disposable UE host and checks units, context, finite values, sample count, and explicit insufficient-sample behavior. If headless rendering cannot provide a defensible timing window, the test asserts `unavailable` rather than fabricating one.
- Sidecar tests show both tools are discoverable, disabled-tool filtering still works, performance wording routes to the profiler, and unrelated QA wording remains with Quality Reviewer or the coordinator.
- A real Agent turn in a disposable editor shows tool provenance and a measured-versus-unknown summary. The live Saskartarad plugin is installed and verified only after the user closes that editor; no locked DLL is overwritten.
- Build and focused tests pass; the full native suite's existing failures are named separately rather than hidden in a “green” claim.

## Deferred work

Captured `console_exec` output, verified `cvar_set`, PCG descriptor audit and mutation, crash-report parsing, texture/GPU memory reports, World Partition region loading, Nanite asset audits, and production-grade trace comparison remain separate slices in the handoff. They are not advertised as available by this first profiling specialist.
