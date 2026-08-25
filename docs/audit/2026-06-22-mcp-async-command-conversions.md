# MCP Async Command Conversions — Implementation Plan

> Status: **both tasks implemented** (verified 2026-08-25, reading the code
> rather than the status line this replaces).
>
> - Task 1 — `HaybaMCPBuildHandler` allocates through `FHaybaMCPJobRegistry`
>   and returns `{job_id, status:"running"}` immediately; `build_status` reads
>   the result back.
> - Task 2 — `HaybaMCPIdleHandler` runs on `FTSTicker` and contains no
>   `FPlatformProcess::Sleep`.
>
> This header said "planned, not implemented" long after both landed, which is
> a worse failure than being out of date: anyone deciding whether the editor
> still freezes on a build would have got the wrong answer from the document
> written to tell them.
>
> **One instance of the pattern is left**, and it is not covered by either task
> above: `HaybaMCPRenderHandler.cpp` still calls `FPlatformProcess::Sleep` in
> its wait phase (line ~325), on the game thread, with a 30-second default
> timeout. See "Remaining: render_camera" at the end.
>
> The original caution still applies to that one: it changes a command
> contract and needs a running editor to smoke-test, so it is not something to
> merge on compile-verification alone.

**Goal:** Stop `wait_for_idle`/`wait_for_shaders`, `build_*`, and `test_run` from freezing the editor's game thread. All three run on the game thread (TcpServer marshals every command there — see `project_haybamcp_gamethread_dispatch`), so they cannot both occupy the game thread AND let it tick to make progress. The fix is to make them non-blocking / cooperative.

## Why these need in-editor smoke (not compile-only)
Each changes observable behavior: a previously-synchronous command becomes asynchronous, or its wait semantics change. Only a running editor confirms (a) the editor no longer freezes, (b) the command still returns correct results, and (c) the agent/TS side handles the new shape. The rest of this session's fixes were correctness/relocation that compile-verification covers; these are not.

---

## Task 1: `build_*` and `test_run` — return a job envelope instead of blocking

**Files:** `unreal/.../handlers/HaybaMCPBuildHandler.cpp` (`RunOrBackground`, ~line 215-248), `unreal/.../handlers/HaybaMCPTestHandler.cpp` (~line 221), plus a new `build_status`/`job_status` read command, and the TS wrappers + tool docs.

**Current:** `RunOrBackground` fires a background `AsyncTask` to run the subprocess, then `Future.WaitFor(FTimespan::FromSeconds(300))` **on the game thread** → editor frozen up to 5 min. `test_run` busy-sleeps the game thread up to 120s.

**Change:**
1. On the game thread, do NOT `WaitFor`. Allocate a job id, store `{id, status:"running", startedAt}` in a process-global `TMap<FString, FJobState>` guarded by a `FCriticalSection` (it is touched by the game thread that starts it and the background task that completes it — genuinely cross-thread, so the lock is required).
2. The background `AsyncTask` runs the subprocess, then writes `{status:"done", exitCode, output}` into the job entry under the lock and appends to the operation journal.
3. Return `{ job_id, status:"running" }` immediately.
4. New command `build_status { job_id }` (and reuse for tests) reads the job entry under the lock and returns status/result. The agent polls it (or reads `hayba_journal_tail`).
5. Update the `build_*`/`test_run` tool descriptions to state they return a job envelope and that results come from `build_status`/the journal.

**Acceptance (in-editor):** run `build_project` → returns immediately, editor stays responsive; `build_status` eventually reports `done` with the exit code; a parallel command during the build is not blocked.

---

## Task 2: `wait_for_idle` / `wait_for_shaders` — cooperative or deferred

**Files:** `unreal/.../handlers/HaybaMCPIdleHandler.cpp` (`Handle` ~234-300, `PollOnce`).

**Current:** registers a `FTSTicker` then blocks on `FEvent::Wait` — but the ticker fires on game-thread ticks, which can't happen while the handler blocks the game thread → 61s freeze, always returns `bAllSettled:false`.

**Two options — pick during in-editor work:**
- **(A) Cooperative inline (smaller):** run the GC nudge + `BusyOnEntry` capture inline (already on the game thread), then a bounded loop that calls the idle predicates directly and `FShaderCompilingManager` / async-loading progress checks, yielding with a short sleep, until settled or timeout. Note: sleeping the game thread does **not** tick the world, so `world_tick`/async-load subsystems may not progress — validate which subsystems actually settle this way; drop or document the ones that don't.
- **(B) Deferred response (correct, larger):** return immediately with a pending token; let the existing ticker run on real game-thread ticks; deliver the result via a follow-up `idle_status { token }` or a pushed message. This is the architecturally-correct fix and composes with Task 1's job-status mechanism.

**Recommendation:** reuse Task 1's job-status infrastructure for both, so idle and build share one async-job seam (ties into architecture candidate "ProcessCommand threading contract").

**Acceptance (in-editor):** `wait_for_idle` does not freeze the editor; after shaders/assets actually settle, the status reports `bAllSettled:true` with a real duration.

---

## Shared note
Tasks 1 and 2 both want a small **async-job registry** (`TMap<FString,FJobState>` + `FCriticalSection` + a `*_status` reader). Build it once and share it — that is the deepening that makes "long-running command" a first-class, non-freezing concept in the plugin.

---

## Remaining: `render_camera`

`HaybaMCPRenderHandler::RunOnGameThread` waits for shaders/assets to settle by
polling in a loop with `FPlatformProcess::Sleep(POLL_INTERVAL_SECONDS)`. Its
own comment states the constraint plainly: *"RunOnGameThread always executes on
the game thread"*. So the editor is frozen for as long as the wait takes, up to
`TimeoutSeconds`, which defaults to **30**.

The code already works around one consequence rather than fixing it: it removes
`world_tick` from the wait set when running inline, because a blocked game
thread cannot advance `GFrameCounter`, so that predicate could never settle.
The capability is silently dropped — you cannot wait for a world tick before a
render, and nothing says so.

**Why a ticker alone does not fix it.** `Handle()` is synchronous and already on
the game thread. Anywhere it waits, it waits on the game thread. Making the
wait cooperative requires the command to stop being synchronous.

**The seam already exists, and has two precedents.** `FHaybaMCPJobRegistry`
says in its own header that it is "shared on purpose" for exactly this, and
both `build_*` (background worker) and `test_run` (deferred game-thread ticker
pump) use it. `render_camera` would follow the `test_run` shape: return
`{job_id, status:"running"}`, pump the settle-predicates on a ticker, capture
and write on a later tick, publish the result to the registry.

**Why it is not done here.** It changes what every existing caller receives —
the TS wrapper, the reel runbook and the workflow skills all expect a
synchronous image path. That is a deliberate product decision about the command
surface, not a refactor, and this document's own guidance is that such changes
are not auto-merged.
