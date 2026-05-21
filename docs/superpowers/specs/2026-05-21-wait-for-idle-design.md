# `wait_for_idle` — UE Subsystem Readiness Primitive

**Date:** 2026-05-21
**Status:** Design approved, ready for implementation plan
**Scope:** One new MCP tool (`wait_for_idle`) plus a C++ handler in the UE plugin. Folds the existing `wait_for_shaders` into a thin TS wrapper. Sibling spec to the upcoming `render_camera` consolidation (which will consume `wait_for_idle` internally).

## Problem

Per `.scratch/mcp-architectural-issues.md` #3, the single biggest source of UE crashes in the LostCity post-mortem session was **stacking heavy operations on top of asynchronous subsystems that hadn't finished**:

- `pcgc.generate(False)` returns immediately; content shows up asynchronously.
- `AssetTools.import_asset_tasks` returns immediately; files appear later.
- Destroying many actors triggers GC; doing heavy work right after has crashed UE twice.
- AssetRegistry scans are async.

The existing `wait_for_shaders` solves this for one subsystem. Everything else needs hand-rolled `time.sleep()` magic numbers. Without a generic "wait for editor idle" primitive, every Layer 2 abstraction we plan (composition primitives, PCG control, lighting presets) will rebuild the same scaffolding poorly.

## Goals

1. **Single MCP tool `wait_for_idle(subsystems?, timeout_s, …)`** that waits on any combination of the listed subsystems or all of them when `subsystems` is unset.
2. **Five v1 subsystems:** `shaders`, `assets`, `gc`, `pcg`, `world_tick`.
3. **PCG scoping:** optional `pcg_actors: string[]` restricts the PCG wait to specific PCGComponent owners; default = every PCGComponent in the active level.
4. **World tick:** optional `world_ticks: number` (default 1) — at least N world ticks past request start must elapse before `world_tick` reports idle.
5. **Structured response** distinguishes settled-in-time from timeout-per-subsystem: callers can see exactly which subsystems didn't settle and decide what to do.
6. **`wait_for_shaders` keeps working** — preserved as a thin TS wrapper that calls `wait_for_idle({subsystems:['shaders']})`, for callers wired to the old name.

## Non-goals

- Event-hook readiness (faster than 250ms polling). Polling is uniform across subsystems and good enough for v1.
- Per-subsystem progress reporting (% of shaders compiled, # of assets in registry). Useful but not load-bearing for the "don't crash UE" goal.
- A `render_camera` tool that consumes this. Separate sibling spec (next).
- Operation journal (#12 from architectural-issues). Separate spec.
- Out-of-process editor liveness probe (#16). Separate spec.

## Architecture

One TS-side meta-tool (`wait_for_idle`) routing to one C++ TCP handler. The C++ handler runs per-subsystem `IsBusy()` predicates on a fixed 250ms `FTSTicker` cadence, returns when *all requested subsystems* report idle in the same poll, or returns timeout when wall-clock exceeds `timeout_s`. No event hooks in v1.

Existing `wait_for_shaders` (TS) becomes a thin wrapper calling `wait_for_idle({subsystems:['shaders']})`. The C++ side keeps a dedicated `wait_for_shaders` handler for one release cycle (marked deprecated in code) so external callers caching the old command name keep working; removed thereafter.

**File layout**

New:
```
mcp-tools/hayba-mcp/src/tools/wait-for-idle.ts
mcp-tools/hayba-mcp/src/tools/wait-for-idle.test.ts
mcp-tools/hayba-mcp/tests/wait-for-idle-integration.test.ts
unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPIdleHandler.{h,cpp}
```

Modified:
```
mcp-tools/hayba-mcp/src/tools/wait-for-shaders.ts          (thin wrapper)
mcp-tools/hayba-mcp/src/tools/index.ts                     (register new tool; assigns to 'editor' pack)
mcp-tools/hayba-mcp/src/tools/routing/packs.yaml           (add wait_for_idle to editor pack)
unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp  (register handler)
mcp-tools/hayba-mcp/CHANGELOG.md                           (Unreleased entry)
```

## Components

### TS — `wait-for-idle.ts` (new)

```ts
export const schema = z.object({
  subsystems: z.array(z.enum(['shaders', 'assets', 'gc', 'pcg', 'world_tick'])).optional()
    .describe('Subsystems to wait on. Omit = wait for all five.'),
  timeout_s: z.number().int().min(1).max(600).default(60)
    .describe('Hard timeout in seconds.'),
  pcg_actors: z.array(z.string()).optional()
    .describe('Optional scope: only wait on these PCGComponent owners (full actor paths). Omit = all PCG actors in the active level.'),
  world_ticks: z.number().int().min(1).max(60).optional()
    .describe('When world_tick is in subsystems: wait at least N world ticks past request start. Default 1.'),
});
export type WaitForIdleParams = z.infer<typeof schema>;

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['wait'],
  pack: undefined,  // joins the 'editor' workflow pack via packs.yaml
  when: 'After mutating asset/PCG/level state, before reading back or rendering.',
  not_when: 'You did a pure read-only call; no state was mutated.',
};

export async function handleWaitForIdle(params: WaitForIdleParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  // TS-side socket timeout buffers UE-side timeout by 5s so UE responds first with structured data.
  const data = await executeCommand('wait_for_idle', parsed.data as Record<string, unknown>, {
    timeout: parsed.data.timeout_s * 1000 + 5000,
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
```

**Return shape (parsed from UE):**
```ts
interface WaitForIdleResult {
  ok: boolean;          // true iff every requested subsystem settled within timeout_s
  durationMs: number;   // wall-clock from request start to response
  settled: Record<'shaders'|'assets'|'gc'|'pcg'|'world_tick', {
    busyOnEntry: boolean;
    settledAtMs: number;  // ms from request start to when this subsystem first reported idle; equals durationMs if it never settled
  }>;
  timedOut?: string[];  // subsystems still busy at deadline; absent or [] when ok:true
}
```

### TS — `wait-for-shaders.ts` (modified — thin wrapper)

```ts
export async function handleWaitForShaders(params: { max_seconds?: number; poll_seconds?: number }) {
  if (params.poll_seconds !== undefined) {
    warnOnce('[wait-for-shaders] poll_seconds is ignored; UE-side polling is fixed at 250ms.');
  }
  // Delegate to wait_for_idle with shaders-only scope.
  const data = await executeCommand('wait_for_idle', {
    subsystems: ['shaders'],
    timeout_s: params.max_seconds ?? 60,
  }, { timeout: (params.max_seconds ?? 60) * 1000 + 5000 });
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
```

Existing `schema` and `meta` exports unchanged so registration in `tools/index.ts` is untouched.

### C++ — `HaybaMCPIdleHandler.{h,cpp}` (new)

```cpp
class FHaybaMCPIdleHandler {
public:
  static void HandleWaitForIdle(
    const TSharedPtr<FJsonObject>& Params,
    FHaybaMCPResponseCallback Done);

private:
  struct FWaitState {
    TSet<FString> Subsystems;           // requested subset
    TArray<FString> ScopedPcgActors;    // empty = all
    int32 WorldTicksRequired;           // default 1
    double T0Seconds;
    uint32 StartTickCount;
    TMap<FString, bool> BusyOnEntry;
    TMap<FString, double> SettledAtMs;  // missing key = not settled yet
    double TimeoutSeconds;
    FHaybaMCPResponseCallback Done;
    FTSTicker::FDelegateHandle TickHandle;
  };

  static bool Poll(FWaitState* State);
  static bool IsShadersBusy();
  static bool IsAssetsBusy();
  static bool IsGCBusy();
  static bool IsPCGBusy(const TArray<FString>& ScopedActors);
  static bool IsWorldTickPending(int32 TicksRequired, uint32 StartTickCount);
};
```

Per-subsystem predicates:
- `IsShadersBusy()` → `GShaderCompilingManager && GShaderCompilingManager->IsCompiling()`
- `IsAssetsBusy()` → `IAssetRegistry::Get().IsLoadingAssets()`
- `IsGCBusy()` → `IsGarbageCollecting() || IsIncrementalPurgePending()`
- `IsPCGBusy(scope)` → iterate `UPCGComponent` instances in `GEditor->GetEditorWorldContext().World()`; if `scope` non-empty, filter to those owners by full path; true if any has `IsGenerating()`. Components with no owner skipped.
- `IsWorldTickPending(N, start)` → `(GWorld->GetGameInstance() || GEditor->GetEditorWorldContext().World())->GetTickCount() - start < N`

`Poll` runs every 250ms via `FTSTicker::GetCoreTicker().AddTicker`. On each tick:
1. For each requested subsystem, evaluate `IsBusy()`. First idle observation records `SettledAtMs = (now - T0)*1000`.
2. If all requested subsystems have a `SettledAtMs`, build success response, unregister ticker, call `Done`.
3. If `now - T0 >= TimeoutSeconds`, build timeout response with `timedOut` populated, unregister, call `Done`.

Return false from ticker callback when complete (UE removes it automatically).

### `HaybaMCPModule.cpp` (modified)

Register the new handler alongside existing ones:
```cpp
RegisterHandler(TEXT("wait_for_idle"), &FHaybaMCPIdleHandler::HandleWaitForIdle);
// Existing wait_for_shaders handler stays one release for deprecation.
```

### `packs.yaml` (modified)

Add `wait_for_idle` to the `editor` workflow pack alongside `wait_for_shaders` (the existing entry stays as the backward-compat path is preserved).

## Data flow

**Happy path.**
1. LLM: `wait_for_idle({ subsystems: ['pcg', 'shaders'], timeout_s: 30, pcg_actors: ['/Game/Maps/L1.L1:PersistentLevel.PCGVolume_42'] })`.
2. TS validates schema, dispatches `executeCommand('wait_for_idle', params, {timeout: 35000})`.
3. C++ handler captures `t0`, evaluates `busyOnEntry` for both subsystems, registers 250ms ticker.
4. Each tick: re-evaluate predicates; record `settledAtMs` for the first idle observation per subsystem.
5. All requested subsystems idle in the same poll → build response, unregister, `Done({ok:true, durationMs, settled})`.
6. TS returns the parsed JSON to the LLM.

**Already-idle path.** First poll finds everything idle. `settled.X.settledAtMs == 0`. Returns within ~250ms.

**Partial timeout.** Some subsystems settle, others don't. `{ok:false, durationMs, settled, timedOut:['pcg']}`. LLM reads `timedOut`, can retry with a longer budget.

**Legacy `wait_for_shaders` call.** TS wrapper translates to `wait_for_idle({subsystems:['shaders'], timeout_s: max_seconds})`. UE-side handler is the same. `poll_seconds` parameter warns once and is ignored.

## Error handling

| Failure | Response |
|---|---|
| UE plugin doesn't know `wait_for_idle` (old plugin) | `UeToolError{code:'ue_error', uePayload:{error:'unknown_command'}}`. CHANGELOG documents the plugin update; meanwhile `wait_for_shaders` keeps working via its existing handler. |
| TCP transport error mid-wait | TS-side `UeToolError{code:'transport'}` with one retry via `tool-executor.executeCommand`. Both fail → surfaced cleanly. |
| `timeout_s` exceeded | `{ok:false, durationMs, settled, timedOut:[…]}` — structured response, not an MCP error. The LLM decides whether to retry. |
| Unknown subsystem name in request | Zod rejects at validation boundary → standard MCP `{kind:'validation'}` error. |
| `pcg_actors` references non-existent paths | Silently skipped UE-side; logged warning. Doesn't fail the request. |
| `world_ticks` set without `world_tick` in subsystems | Zod accepts (it's just data). UE side ignores it unless `world_tick` requested. Documented in field description. |
| UE editor crashes mid-wait | TCP socket closes → `UeToolError{code:'transport'}`. Standard handling. |
| Concurrent `wait_for_idle` calls | Each has its own ticker + response callback. UE subsystem state is shared, both observe the same `IsBusy()` results. No coordination needed. |

## Testing

### TS unit (`mcp-tools/hayba-mcp/src/tools/wait-for-idle.test.ts`)

- Schema validation: rejects unknown subsystem names; `timeout_s` bounds; `subsystems` optional; `world_ticks` independent of subsystem list.
- Handler dispatches to `executeCommand('wait_for_idle', params, {timeout: timeout_s*1000+5000})` via mocked sender (assert command name and timeout buffer).
- `wait-for-shaders.ts` wrapper: calls `wait_for_idle` with `subsystems:['shaders']`, translates `max_seconds`, warns exactly once on `poll_seconds` across multiple calls.

### TS integration (`mcp-tools/hayba-mcp/tests/wait-for-idle-integration.test.ts`)

- Mock sender returning canned response shapes:
  - `{ok:true, durationMs:42, settled:{shaders:{busyOnEntry:true, settledAtMs:30}}}` — assert TS unwraps cleanly.
  - `{ok:false, durationMs:30000, settled:{…}, timedOut:['pcg']}` — assert `timedOut` preserved in response.
- Assert TS does not interpret `{ok:false}` as a transport error (it's a normal structured response).

### C++ unit (UE plugin sub-PR)

- Each `IsBusy()` predicate isolated against a stub world.
- Ticker loop: mock four predicates with controllable boolean state; assert `Done` fires only when all idle, with correct `settledAtMs`; assert timeout fires at deadline with `timedOut` populated for still-busy subsystems.
- Concurrent waits: two handlers running simultaneously don't interfere.

### Smoke (manual, with UE running)

- After a PCG generate burst on a known PCGVolume: `wait_for_idle({subsystems:['pcg'], pcg_actors:[<path>]})` returns when that component finishes, not before.
- After destroying many actors: `wait_for_idle({subsystems:['gc']})` waits past the GC pass.
- After loading a fresh map: `wait_for_idle()` (all subsystems) sees asset registry scan + shader compile + first tick all complete.

## Risks & mitigations

- **UE plugin update lag.** Until the C++ handler ships, the new `wait_for_idle` tool returns `unknown_command`. Mitigation: existing `wait_for_shaders` keeps working via its dedicated C++ handler; the TS wrapper for `wait_for_shaders` falls back to the dedicated command if `wait_for_idle` returns `unknown_command` on first call (implemented as a process-local capability flag).
- **250ms poll granularity.** Subsystems that idle briefly between polls might be missed. Mitigation: predicates check *current* state; if the subsystem was busy, then idle, then busy again, the wait correctly continues (it's looking for "currently idle"). The edge case is "subsystem briefly idle right at the deadline" — acceptable, just times out, LLM retries.
- **`IsGenerating()` semantics across PCG versions.** PCG API has evolved; some versions don't expose this directly. Mitigation: implementation uses the `PCGComponent::GetGenerationStatus()` enum equivalent, with a compile-time fallback to `bGenerated == false && bGenerating == true` based on engine version.
- **GC predicate flakiness.** `IsGarbageCollecting()` is true only during the actual collection pass, which is very brief. The intent is "post-collection settled." Mitigation: `IsGCBusy()` also queues a no-op `CollectGarbage(GARBAGE_COLLECTION_KEEPFLAGS, false)` *once* at handler entry (only when `gc` is requested), so `IsBusy()` becomes "GC pass in progress OR my queued pass hasn't run yet."

## Out of scope

- `render_camera` consolidation (next sibling spec).
- Event-hook readiness in place of polling.
- Subsystem-specific progress reporting.
- `python_run` rework (#1).
- Plugin source duplication (#5).
- Operation journal (#12).
- Out-of-process editor liveness probe (#16).
