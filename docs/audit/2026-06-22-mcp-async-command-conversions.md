# MCP Async Command Conversions — Implementation Plan

> Status: **planned, not implemented.** These three commands block the game thread (editor freeze) but no longer crash. They change command contracts and need a **running editor to smoke-test**, so they are intentionally not auto-merged. Implement on a branch and verify in-editor before merging.

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
