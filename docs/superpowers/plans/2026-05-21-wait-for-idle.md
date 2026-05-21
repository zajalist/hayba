# `wait_for_idle` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development.

**Goal:** Ship one MCP tool `wait_for_idle(subsystems?, timeout_s, pcg_actors?, world_ticks?)` plus its C++ UE handler, consolidating subsystem-readiness waits behind one primitive. Fold `wait_for_shaders` into a thin TS wrapper.

**Architecture:** TS tool dispatches via `executeCommand('wait_for_idle', ...)`. C++ handler polls per-subsystem `IsBusy()` predicates at 250ms cadence via `FTSTicker`, resolves response when all settled or on timeout. Structured `{ok, durationMs, settled, timedOut?}` response.

**Tech Stack:** TypeScript + vitest + zod (TS); C++ + UE 5.7 (HaybaMCPToolkit plugin).

**Spec:** `docs/superpowers/specs/2026-05-21-wait-for-idle-design.md`

---

### Task 1: TS tool — `wait-for-idle.ts` + schema test

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/wait-for-idle.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/wait-for-idle.test.ts`

- [ ] **Step 1: Write failing test**

`wait-for-idle.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { schema, handleWaitForIdle } from './wait-for-idle.js';
import { setDefaultSender } from './tool-executor.js';

describe('wait-for-idle schema', () => {
  it('accepts a subset of subsystems', () => {
    expect(z.object(schema.shape).parse({ subsystems: ['pcg', 'shaders'], timeout_s: 30 }).subsystems)
      .toEqual(['pcg', 'shaders']);
  });
  it('subsystems is optional (means wait for all)', () => {
    const parsed = z.object(schema.shape).parse({ timeout_s: 10 });
    expect(parsed.subsystems).toBeUndefined();
  });
  it('rejects unknown subsystem names', () => {
    expect(() => z.object(schema.shape).parse({ subsystems: ['typo'], timeout_s: 10 }))
      .toThrow();
  });
  it('timeout_s default = 60', () => {
    expect(z.object(schema.shape).parse({}).timeout_s).toBe(60);
  });
  it('timeout_s bounds [1, 600]', () => {
    expect(() => z.object(schema.shape).parse({ timeout_s: 0 })).toThrow();
    expect(() => z.object(schema.shape).parse({ timeout_s: 601 })).toThrow();
  });
  it('pcg_actors + world_ticks accepted', () => {
    const parsed = z.object(schema.shape).parse({
      subsystems: ['pcg', 'world_tick'], timeout_s: 5, pcg_actors: ['/Game/X'], world_ticks: 3,
    });
    expect(parsed.pcg_actors).toEqual(['/Game/X']);
    expect(parsed.world_ticks).toBe(3);
  });
});

describe('handleWaitForIdle', () => {
  it('dispatches wait_for_idle with timeout_s*1000 + 5000ms socket timeout', async () => {
    const sender = vi.fn(async (cmd: string, params: Record<string, unknown>, timeout: number) => ({
      ok: true,
      data: { ok: true, durationMs: 42, settled: { shaders: { busyOnEntry: true, settledAtMs: 30 } } },
    }));
    setDefaultSender(sender as never);
    const res = await handleWaitForIdle({ subsystems: ['shaders'], timeout_s: 10 });
    expect(sender).toHaveBeenCalledWith('wait_for_idle', expect.objectContaining({ subsystems: ['shaders'], timeout_s: 10 }), 15000);
    expect(res.content[0].text).toContain('"ok": true');
  });
});
```

- [ ] **Step 2: Confirm failure**

`cd mcp-tools/hayba-mcp; npx vitest run src/tools/wait-for-idle.test.ts`
Expect: FAIL.

- [ ] **Step 3: Implement**

`wait-for-idle.ts`:
```ts
import { z } from 'zod';
import type { HaybaToolMeta } from './hayba-tool-meta.js';
import { executeCommand } from './tool-executor.js';

const SUBSYSTEMS = ['shaders', 'assets', 'gc', 'pcg', 'world_tick'] as const;

export const schema = z.object({
  subsystems: z.array(z.enum(SUBSYSTEMS)).optional()
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
  when: 'After mutating asset/PCG/level state, before reading back or rendering.',
  not_when: 'You did a pure read-only call; no state was mutated.',
};

export async function handleWaitForIdle(params: WaitForIdleParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  const data = await executeCommand('wait_for_idle', parsed.data as Record<string, unknown>, {
    timeout: parsed.data.timeout_s * 1000 + 5000,
  });
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
```

- [ ] **Step 4: Verify pass + commit**

```
cd mcp-tools/hayba-mcp; npx vitest run src/tools/wait-for-idle.test.ts
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/wait-for-idle.ts mcp-tools/hayba-mcp/src/tools/wait-for-idle.test.ts; git commit -m "feat(wait-for-idle): TS tool + schema validation"
```

---

### Task 2: `wait-for-shaders.ts` becomes thin wrapper

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/wait-for-shaders.ts`

- [ ] **Step 1: Modify**

Replace the body of `handleWaitForShaders`:
```ts
import { z } from 'zod';
import { executeCommand } from './tool-executor.js';
import type { HaybaToolMeta } from './hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: [],
  when: 'waiting for UE shader compilation to settle before taking a screenshot or executing a graph that touches new materials',
  not_when: 'you do not actually care if shaders are still compiling (most read-only tools)',
};

export const schema = z.object({
  max_seconds: z.number().int().min(1).max(600).default(60),
  poll_seconds: z.number().min(0.05).max(10).default(1),
});

export type WaitForShadersParams = z.infer<typeof schema>;

let pollWarned = false;

export async function handleWaitForShaders(params: WaitForShadersParams) {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { content: [{ type: 'text' as const, text: 'Invalid params: ' + parsed.error.message }], isError: true };
  }
  if (params.poll_seconds !== undefined && !pollWarned) {
    pollWarned = true;
    console.warn('[wait-for-shaders] poll_seconds is ignored; UE-side polling is fixed at 250ms.');
  }
  const data = await executeCommand('wait_for_idle', {
    subsystems: ['shaders'],
    timeout_s: parsed.data.max_seconds,
  }, { timeout: parsed.data.max_seconds * 1000 + 5000 });
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
```

- [ ] **Step 2: Run existing wait-for-shaders tests if any + commit**

```
cd mcp-tools/hayba-mcp; npx vitest run src/tools/ 2>&1 | tail -5
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/wait-for-shaders.ts; git commit -m "refactor(wait-for-shaders): become thin wrapper around wait_for_idle"
```

---

### Task 3: Register `wait_for_idle` in `tools/index.ts` + packs.yaml

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/index.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/routing/packs.yaml`

- [ ] **Step 1: Add import + registration to index.ts**

Near top, add:
```ts
import { handleWaitForIdle, meta as waitForIdleMeta, schema as waitForIdleSchema } from './wait-for-idle.js';
```

In `registerToolsCore`, where existing tool registrations live (search for `wait_for_shaders` registration as anchor), add:
```ts
  server.tool(
    'wait_for_idle',
    appendMeta('Wait for UE subsystems (shaders/assets/gc/pcg/world_tick) to settle before reading back or rendering. Default = all five.', waitForIdleMeta),
    waitForIdleSchema.shape,
    async (params) => handleWaitForIdle(params as never),
  );
  remember('wait_for_idle', waitForIdleMeta);
```

- [ ] **Step 2: Add to editor workflow pack in packs.yaml**

Find the `editor` pack entry, add `wait_for_idle` to its tools list:
```yaml
  - name: editor
    kind: workflow
    description: Live UE editor introspection and PIE control.
    autoLoadOn: ue_connected
    tools:
      - editor_capture_viewport
      - editor_stream_log
      - editor_start_pie
      - wait_for_shaders
      - wait_for_idle   # added
```

- [ ] **Step 3: Typecheck + commit**

```
cd mcp-tools/hayba-mcp; npm run typecheck
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/index.ts mcp-tools/hayba-mcp/src/tools/routing/packs.yaml; git commit -m "feat(wait-for-idle): register tool in index.ts + add to editor pack"
```

---

### Task 4: Integration test (TS, mocked UE)

**Files:**
- Create: `mcp-tools/hayba-mcp/tests/wait-for-idle-integration.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setDefaultSender, type Sender } from '../src/tools/tool-executor.js';
import { handleWaitForIdle } from '../src/tools/wait-for-idle.js';
import { handleWaitForShaders } from '../src/tools/wait-for-shaders.js';

describe('wait-for-idle integration', () => {
  let sender: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    sender = vi.fn(async (_cmd, _params, _timeout) => ({
      ok: true,
      data: { ok: true, durationMs: 12, settled: { shaders: { busyOnEntry: true, settledAtMs: 8 } } },
    }));
    setDefaultSender(sender as unknown as Sender);
  });

  it('returns the unwrapped UE response shape', async () => {
    const res = await handleWaitForIdle({ subsystems: ['shaders'], timeout_s: 5 });
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.settled.shaders.busyOnEntry).toBe(true);
  });

  it('preserves timedOut on partial timeout', async () => {
    sender.mockResolvedValueOnce({
      ok: true,
      data: { ok: false, durationMs: 5000, settled: { pcg: { busyOnEntry: true, settledAtMs: 5000 } }, timedOut: ['pcg'] },
    });
    const res = await handleWaitForIdle({ subsystems: ['pcg'], timeout_s: 5 });
    const body = JSON.parse(res.content[0].text);
    expect(body.ok).toBe(false);
    expect(body.timedOut).toEqual(['pcg']);
  });

  it('wait-for-shaders wrapper delegates to wait_for_idle', async () => {
    await handleWaitForShaders({ max_seconds: 30, poll_seconds: 1 });
    expect(sender).toHaveBeenCalledWith(
      'wait_for_idle',
      expect.objectContaining({ subsystems: ['shaders'], timeout_s: 30 }),
      35000,
    );
  });
});
```

- [ ] **Step 2: Run + commit**

```
cd mcp-tools/hayba-mcp; npx vitest run tests/wait-for-idle-integration.test.ts
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/tests/wait-for-idle-integration.test.ts; git commit -m "test(wait-for-idle): integration — unwrap, partial timeout, wait-for-shaders wrapper"
```

---

### Task 5: C++ handler — `HaybaMCPIdleHandler.{h,cpp}`

**Files:**
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPIdleHandler.h`
- Create: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPIdleHandler.cpp`

- [ ] **Step 1: Write `HaybaMCPIdleHandler.h`**

```cpp
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

// Forward decl matching the existing handler signature pattern.
using FHaybaMCPResponseCallback = TFunction<void(const TSharedPtr<FJsonObject>& Response, bool bSuccess)>;

class FHaybaMCPIdleHandler {
public:
  static void HandleWaitForIdle(
    const TSharedPtr<FJsonObject>& Params,
    FHaybaMCPResponseCallback Done);
};
```

- [ ] **Step 2: Write `HaybaMCPIdleHandler.cpp`**

```cpp
#include "HaybaMCPIdleHandler.h"

#include "Containers/Ticker.h"
#include "Editor.h"
#include "Editor/EditorEngine.h"
#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "ShaderCompiler.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/GarbageCollection.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "PCGComponent.h"

namespace {

constexpr double POLL_INTERVAL_SECONDS = 0.25;

bool IsShadersBusyImpl() {
  return GShaderCompilingManager && GShaderCompilingManager->IsCompiling();
}

bool IsAssetsBusyImpl() {
  FAssetRegistryModule& Mod = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
  return Mod.Get().IsLoadingAssets();
}

bool IsGCBusyImpl() {
  return IsGarbageCollecting() || IsIncrementalPurgePending();
}

UWorld* ActiveEditorWorld() {
  if (GEditor) {
    if (FWorldContext* Ctx = GEditor->GetEditorWorldContext().World() ? &GEditor->GetEditorWorldContext() : nullptr) {
      return Ctx->World();
    }
  }
  return GWorld;
}

bool IsPCGBusyImpl(const TSet<FString>& ScopedActorPaths) {
  UWorld* World = ActiveEditorWorld();
  if (!World) return false;
  for (TObjectIterator<UPCGComponent> It; It; ++It) {
    UPCGComponent* Comp = *It;
    if (!Comp || Comp->GetWorld() != World) continue;
    AActor* Owner = Comp->GetOwner();
    if (!Owner) continue;
    if (ScopedActorPaths.Num() > 0) {
      const FString Path = Owner->GetPathName();
      if (!ScopedActorPaths.Contains(Path)) continue;
    }
    if (Comp->IsGenerating()) return true;
  }
  return false;
}

bool IsWorldTickPendingImpl(int32 TicksRequired, uint64 StartTickCount) {
  UWorld* World = ActiveEditorWorld();
  if (!World) return false;
  const uint64 Now = (uint64)World->GetTimeSeconds();  // fallback if GetTickCount unavailable; see note
  // UE's UWorld does not directly expose a "tick count" — use frame counter.
  return (uint64)GFrameCounter - StartTickCount < (uint64)TicksRequired;
}

struct FWaitState {
  TSet<FString> Subsystems;
  TSet<FString> ScopedPcgActors;
  int32 WorldTicksRequired = 1;
  uint64 StartFrameCounter = 0;
  double T0Seconds = 0.0;
  double TimeoutSeconds = 60.0;
  TMap<FString, bool> BusyOnEntry;
  TMap<FString, double> SettledAtMs;
  FHaybaMCPResponseCallback Done;
  FTSTicker::FDelegateHandle TickHandle;
};

bool IsBusy(const FString& Subsystem, const FWaitState& State) {
  if (Subsystem == TEXT("shaders"))    return IsShadersBusyImpl();
  if (Subsystem == TEXT("assets"))     return IsAssetsBusyImpl();
  if (Subsystem == TEXT("gc"))         return IsGCBusyImpl();
  if (Subsystem == TEXT("pcg"))        return IsPCGBusyImpl(State.ScopedPcgActors);
  if (Subsystem == TEXT("world_tick")) return IsWorldTickPendingImpl(State.WorldTicksRequired, State.StartFrameCounter);
  return false;
}

TSharedPtr<FJsonObject> BuildResponse(const FWaitState& State, bool bOk, double DurationMs) {
  TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
  Out->SetBoolField(TEXT("ok"), bOk);
  Out->SetNumberField(TEXT("durationMs"), DurationMs);

  TSharedPtr<FJsonObject> Settled = MakeShared<FJsonObject>();
  for (const FString& S : State.Subsystems) {
    TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
    Entry->SetBoolField(TEXT("busyOnEntry"), State.BusyOnEntry.FindRef(S));
    const double* Settled_ms = State.SettledAtMs.Find(S);
    Entry->SetNumberField(TEXT("settledAtMs"), Settled_ms ? *Settled_ms : DurationMs);
    Settled->SetObjectField(S, Entry);
  }
  Out->SetObjectField(TEXT("settled"), Settled);

  if (!bOk) {
    TArray<TSharedPtr<FJsonValue>> TimedOut;
    for (const FString& S : State.Subsystems) {
      if (!State.SettledAtMs.Contains(S)) {
        TimedOut.Add(MakeShared<FJsonValueString>(S));
      }
    }
    Out->SetArrayField(TEXT("timedOut"), TimedOut);
  }
  return Out;
}

bool PollOnce(float /*DeltaTime*/, FWaitState* State) {
  const double Now = FPlatformTime::Seconds();
  const double DurationMs = (Now - State->T0Seconds) * 1000.0;

  for (const FString& S : State->Subsystems) {
    if (State->SettledAtMs.Contains(S)) continue;
    if (!IsBusy(S, *State)) {
      State->SettledAtMs.Add(S, DurationMs);
    }
  }

  const bool bAllSettled = State->SettledAtMs.Num() == State->Subsystems.Num();
  const bool bTimedOut = (Now - State->T0Seconds) >= State->TimeoutSeconds;

  if (bAllSettled || bTimedOut) {
    TSharedPtr<FJsonObject> Resp = BuildResponse(*State, bAllSettled, DurationMs);
    if (State->Done) State->Done(Resp, true);
    delete State;
    return false; // unregister ticker
  }
  return true;
}

} // namespace

void FHaybaMCPIdleHandler::HandleWaitForIdle(
    const TSharedPtr<FJsonObject>& Params,
    FHaybaMCPResponseCallback Done)
{
  FWaitState* State = new FWaitState();
  State->T0Seconds = FPlatformTime::Seconds();
  State->StartFrameCounter = GFrameCounter;
  State->Done = MoveTemp(Done);
  State->TimeoutSeconds = Params.IsValid() && Params->HasField(TEXT("timeout_s"))
    ? Params->GetNumberField(TEXT("timeout_s"))
    : 60.0;

  // Parse subsystems
  if (Params.IsValid() && Params->HasField(TEXT("subsystems"))) {
    const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
    if (Params->TryGetArrayField(TEXT("subsystems"), Arr) && Arr) {
      for (const TSharedPtr<FJsonValue>& V : *Arr) {
        State->Subsystems.Add(V->AsString());
      }
    }
  }
  if (State->Subsystems.Num() == 0) {
    State->Subsystems = { TEXT("shaders"), TEXT("assets"), TEXT("gc"), TEXT("pcg"), TEXT("world_tick") };
  }

  // Parse pcg_actors
  if (Params.IsValid() && Params->HasField(TEXT("pcg_actors"))) {
    const TArray<TSharedPtr<FJsonValue>>* Arr = nullptr;
    if (Params->TryGetArrayField(TEXT("pcg_actors"), Arr) && Arr) {
      for (const TSharedPtr<FJsonValue>& V : *Arr) {
        State->ScopedPcgActors.Add(V->AsString());
      }
    }
  }

  if (Params.IsValid() && Params->HasField(TEXT("world_ticks"))) {
    State->WorldTicksRequired = (int32)Params->GetNumberField(TEXT("world_ticks"));
  }

  // GC nudge: when gc requested, queue a non-blocking collect so IsBusy goes true once and then settles.
  if (State->Subsystems.Contains(TEXT("gc"))) {
    GEngine->ForceGarbageCollection(true);
  }

  // Capture busyOnEntry
  for (const FString& S : State->Subsystems) {
    State->BusyOnEntry.Add(S, IsBusy(S, *State));
  }

  // Register ticker
  State->TickHandle = FTSTicker::GetCoreTicker().AddTicker(
    FTickerDelegate::CreateLambda([State](float Dt) { return PollOnce(Dt, State); }),
    POLL_INTERVAL_SECONDS);
}
```

- [ ] **Step 3: Commit**

```
cd D:/Hackathons/hayba; git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPIdleHandler.h unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPIdleHandler.cpp; git commit -m "feat(wait-for-idle): C++ handler — per-subsystem IsBusy polling at 250ms"
```

---

### Task 6: Register handler in `HaybaMCPModule.cpp`

**Files:**
- Modify: `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp`

- [ ] **Step 1: Add include + registration**

Find where other handlers are registered (search for `wait_for_shaders` as anchor). Add:
```cpp
#include "handlers/HaybaMCPIdleHandler.h"
// ...
// In the handler-registration section:
RegisterHandler(TEXT("wait_for_idle"), &FHaybaMCPIdleHandler::HandleWaitForIdle);
```

(Exact signature of `RegisterHandler` to follow the existing convention. If `RegisterHandler` doesn't exist as a function and dispatch is via a string→function map, follow that pattern instead.)

- [ ] **Step 2: Commit**

```
cd D:/Hackathons/hayba; git add unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp; git commit -m "feat(wait-for-idle): register C++ handler in HaybaMCPModule"
```

---

### Task 7: CHANGELOG + run full suite + push + PR

**Files:**
- Modify: `mcp-tools/hayba-mcp/CHANGELOG.md`

- [ ] **Step 1: CHANGELOG entry**

Under `## Unreleased`:
```markdown
### wait_for_idle (UE subsystem readiness)

- New `wait_for_idle(subsystems?, timeout_s, pcg_actors?, world_ticks?)` MCP tool covering `shaders`, `assets`, `gc`, `pcg`, `world_tick`. Default `subsystems` unset = wait for all five. Structured `{ok, durationMs, settled, timedOut?}` response distinguishes settled-in-time vs. partial-timeout per subsystem.
- `wait_for_shaders` now delegates to `wait_for_idle({subsystems:['shaders']})`. `poll_seconds` parameter is ignored (UE-side polling is fixed at 250ms); a one-time warning is logged. Existing callers keep working.
- Closes `.scratch/mcp-architectural-issues.md` #3.
- Pending: ship the C++ `HaybaMCPIdleHandler` to the live plugin location (`D:/UnrealEngine/geoforge/Plugins/HaybaMCPToolkit/`) alongside this repo's `unreal/HaybaMCPToolkit/`.
```

- [ ] **Step 2: Run full suite**

```
cd mcp-tools/hayba-mcp; npm test 2>&1 | tail -5
```

Expect: existing pass count + ~10 new tests pass; 26 pre-existing TCP-sender failures unchanged.

- [ ] **Step 3: Commit + push + PR**

```
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/CHANGELOG.md; git commit -m "docs(wait-for-idle): CHANGELOG entry"
git push -u origin spec/wait-for-idle
gh pr create --title "wait_for_idle — UE subsystem readiness primitive" --body "$(cat <<'EOF'
## Summary
- Single MCP tool wait_for_idle(subsystems?, timeout_s, pcg_actors?, world_ticks?) covering shaders/assets/gc/pcg/world_tick
- Default subsystems unset = wait for all five
- C++ handler polls IsBusy() predicates at 250ms cadence via FTSTicker
- Structured {ok, durationMs, settled, timedOut?} response
- wait_for_shaders becomes a thin TS wrapper around wait_for_idle (backward compat preserved)
- Closes .scratch/mcp-architectural-issues.md #3

## Spec / Plan
- docs/superpowers/specs/2026-05-21-wait-for-idle-design.md
- docs/superpowers/plans/2026-05-21-wait-for-idle.md

## Test plan
- [x] TS unit (schema, dispatch)
- [x] TS integration (unwrap, partial timeout, wait-for-shaders wrapper)
- [ ] C++ unit (UE-side, follow-up sub-PR)
- [ ] Manual smoke against live UE: wait_for_idle({subsystems:['pcg']}) settles after generate burst, wait_for_idle({subsystems:['gc']}) waits past GC pass

## UE plugin follow-up
The C++ handler ships in this PR under unreal/HaybaMCPToolkit/. To take effect in the live editor, sync to the dev plugin directory (D:/UnrealEngine/geoforge/Plugins/HaybaMCPToolkit/) — see mcp-architectural-issues #5 for the long-term dedup plan.
EOF
)"
```
