# Phase 0/1 Foundation — Implementation Plan

Executes Phases 0 (stop lying / stop freezing) and 1 (add-a-tool refactor) from
`docs/plans/2026-06-28-mcp-supertooling-roadmap.md`. These two phases are the
gates the roadmap mandates before any tool blitz.

## Global Constraints (binding — reviewers use as attention lens)

- **No false advertising.** The advertised tool catalog must match what actually
  works. A tool that returns `not_implemented_in_v1` must not appear as a usable
  command in `list_tool_categories` without a clear stub marker.
- **Prefer python_run-backed TS.** New tools that UE Python can do ship as TS
  wrappers (no C++ rebuild). Reserve C++ for what reflection can't reach.
- **TS verification gate:** every TS task ends with `npx tsc --noEmit` clean AND
  `npx vitest run` green (run in `mcp-tools/hayba-mcp`). No task is complete
  without both. New behavior gets a unit test.
- **C++ verification gate:** this environment cannot compile UE C++. C++ tasks
  are gated by **code review against the cited audit `file:line` + fix**, commit
  message tagged `[needs-rebuild]`, and an in-editor smoke step deferred to the
  user. C++ tasks must NOT claim runtime verification.
- **Do not regress** the shipped crash guards / SEH (`HaybaSeh::RunGuarded`),
  the game-thread dispatch model (`HaybaMCPTcpServer.cpp:133` marshals every
  command to the game thread — handlers run ON the game thread), or the
  Code-Mode/deferred-routing registration.
- **Match existing patterns:** TS registration via `STANDARD_DESCRIPTORS` +
  `registerTool` + `recordEagerSchemas` + `appendMeta` + `remember` + `reg`;
  commit messages omit the `Co-Authored-By: Claude` trailer.
- **Idempotency matters:** never silently retry a non-idempotent UE command.

## Reference docs
- `docs/audit/2026-06-22-crash-and-architecture-audit.md` — C++ crash fixes (file:line).
- `docs/audit/2026-06-22-mcp-async-command-conversions.md` — async job-envelope plan.
- `docs/plans/2026-06-28-mcp-competitive-and-audit-appendix.md` — internal audit.

---

## Task 1 — Chore: gitignore the runtime DB + prune dead packs.yaml refs  [TS]

**Files:** `mcp-tools/hayba-mcp/.gitignore` (create or edit), `mcp-tools/hayba-mcp/src/tools/routing/packs.yaml`, plus whatever lists packs' tool names.

**Change:**
1. Ensure `hayba-memory.db` (and `*.db` runtime artifacts, `.scratch/`) are git-ignored under `mcp-tools/hayba-mcp/`. If the file is tracked, `git rm --cached` it.
2. In `packs.yaml`, find any tool names referenced that are NOT registered anywhere in `src/tools/index.ts` (grep each pack entry against registered tool names) and remove the dead references. List what was removed in the task report.

**Acceptance:** `git status` shows no runtime `.db`; `packs.yaml` references only real, registered tools. `npx tsc --noEmit` clean; `npx vitest run` green (any packs-loading test still passes).

---

## Task 2 — Catalog honesty: stop advertising the blueprint_add_node stub  [TS]

**Files:** `mcp-tools/hayba-mcp/src/tools/code-mode/list-tool-categories.ts` (and any catalog source it reads).

**Current:** `blueprint_add_node` is advertised but the handler returns
`not_implemented_in_v1` (grep `not_implemented_in_v1`). Internal audit calls this
"partly false advertising."

**Change:** Either (a) remove `blueprint_add_node` from the advertised catalog, or
(b) keep it but clearly mark it as a stub/not-implemented in the category listing
so an agent won't pick it expecting it to work. Prefer (b) with an explicit
`status: "stub"` / "(not implemented)" suffix if the catalog structure supports a
note; otherwise (a). Do the same for any other command that is advertised but
returns a not-implemented sentinel (grep for the sentinel across handlers).

**Acceptance:** `list_tool_categories` no longer presents a not-implemented command
as usable. A unit test asserts the stub is absent or marked. tsc clean; vitest green.

---

## Task 3 — Align executor timeouts to UE ceilings + idempotent-only retry  [TS]

**Files:** `mcp-tools/hayba-mcp/src/tools/tool-executor.ts`.

**Current:** `COST_TIMEOUTS_MS = { low:2_000, medium:10_000, high:60_000 }`, far
below UE ceilings (build 300s, test 120s, render/idle ~60-90s) → premature TS
timeout while UE is still working. And `executeCommand` does a single **blind
retry on transport failure** for ALL commands — duplicating non-idempotent ops
(`actor_spawn`, `actor_delete`).

**Change:**
1. Raise the `high` cost timeout to comfortably exceed UE ceilings (e.g. 120_000;
   leave low/medium). Document the mapping in a comment. (Long-running commands
   like build/test will move to the async job envelope in Task 9; until then they
   must not time out before UE returns.)
2. Add an idempotency notion: a `NON_IDEMPOTENT` set (or a per-command flag) of
   commands that must NOT be auto-retried (`actor_spawn`, `actor_delete`,
   `asset_delete`, `actor_duplicate`, any create/spawn/delete). In
   `executeCommand`, only perform the transport-failure retry when the command is
   idempotent; otherwise surface the transport error without retrying.

**Acceptance:** unit tests: (a) a non-idempotent command does NOT retry on transport
failure (sender called once, error surfaced); (b) an idempotent command DOES retry
once; (c) timeout for `high` cost ≥ UE ceiling. tsc clean; vitest green.

---

## Task 4 — Transport resilience: reconnect + backoff + port re-discovery  [TS]

**Files:** `mcp-tools/hayba-mcp/src/tcp-client.ts`.

**Current:** `ensureConnected` connects once; on socket close, pending requests
reject and the singleton stays "disconnected" with a stale port. No reconnect, no
backoff. Port is discovered once in `getUEClient`.

**Change:**
1. In `ensureConnected`, if not connected, attempt connect with a small bounded
   retry + backoff (e.g. 3 attempts, 200/400/800ms) before throwing.
2. On reconnect, **re-discover the port** (the editor may have restarted on a new
   port) — re-run `discoverPortFromInstanceRegistry()` and update the client's
   target before reconnecting, rather than reusing the stale port. Keep
   `UE_TCP_PORT` env override authoritative when set.
3. Keep the existing `on('error')` no-op guard and pending-request rejection on
   close. Do not change the wire framing.

**Acceptance:** unit tests (mock `net`/socket or factor the connect/discovery into
testable units): (a) reconnect retries with backoff then succeeds; (b) on a fresh
connect the port is re-read from the registry; (c) env override wins. tsc clean;
vitest green.

---

## Task 5 — Unify the error envelope across tool wrappers  [TS]

**Files:** a new `mcp-tools/hayba-mcp/src/tools/tool-result.ts` (shared helpers) +
adopt in the wrappers that hand-roll inconsistent error shapes (audit calls out
render/build escaping the one-failure-shape invariant; check `render-camera.ts`,
build wrappers, `python-run.ts`, the index.ts inline try/catch wrappers).

**Change:**
1. Add `okResult(data)` and `errorResult(message, extra?)` helpers returning the
   canonical `{ content:[{type:'text', text}], isError }` shape, where errors
   serialize `{ ok:false, error, ...extra }` consistently.
2. Adopt them in the wrappers that currently differ (do NOT churn every handler —
   only the ones whose error shape diverges from the canonical one). Keep image
   content blocks (capture) intact.

**Acceptance:** unit test asserting `errorResult` shape; the adopted wrappers
return the canonical shape on failure. tsc clean; vitest green.

---

## Task 6 — Phase 1: python_run-backed tool factory (`pyTemplate`)  [TS]

**Files:** new `mcp-tools/hayba-mcp/src/tools/py-tool-factory.ts`; builds on
`src/tools/ue-python.ts` (`runUePythonJson`, `PY_PREAMBLE`, `pyStr`).

**Goal:** make a python-backed tool *data declared once*. A descriptor:
```
{ name, description, cost, returns, schema (ZodRawShape),
  buildScript: (params) => string,   // returns python body that calls _emit/_err
  meta?: HaybaToolMeta }
```
produces: (a) a handler `(params)=>Promise<ToolResult>` that validates via the
schema, runs `runUePythonJson(buildScript(params))`, and returns the canonical
result (Task 5 helpers); (b) a registration helper that does `server.tool` +
`appendMeta` + `remember` + `reg` from the same descriptor. The factory is the
mechanism the roadmap's hundreds of python-backed tools ship through.

**Acceptance:** unit tests with a mocked sender (see `ue-python.test.ts` pattern):
a factory-made tool validates params, runs its script, parses the HAYBA_JSON
result, and errors cleanly on bad params / missing marker. tsc clean; vitest green.

---

## Task 7 — Phase 1: single-source tool descriptor (kill schema 4×-drift)  [TS]

**Files:** `mcp-tools/hayba-mcp/src/tools/index.ts`, `register-tool.ts`,
`schema-registry.ts`.

**Current:** `STANDARD_DESCRIPTORS` already unifies registration + schema-recording
for standard tools, but the hand-written tools (editor/fab/pcgex/plumb/etc.)
declare their schema TWICE — once in the eager `server.tool(...)` call and again
in `recordEagerSchemas`'s `reg(...)`. These drift.

**Change:** Extend the single-source pattern so a hand-written tool's schema is
declared once and consumed by BOTH the eager registration AND the schema registry
(`get_tool_signature`). Concretely: move the new ergonomics tools
(`hayba_introspect`, `pcg_*`) and as many hand-written tools as is low-risk into a
descriptor list (or a shared `const` schema object referenced by both sites), so
`reg(...)` no longer re-declares shapes that already exist. Do not change tool
behavior or names. Prefer a mechanical, reviewable migration over a big-bang
rewrite; migrate at least the Phase-0/1-touched tools and document the pattern for
the rest.

**Acceptance:** no schema is declared twice for the migrated tools; `get_tool_signature`
still returns correct schemas for them (unit test). tsc clean; vitest green; tool
count unchanged.

---

## Task 8 — Phase 1: migrate introspect + PCG primitives onto the factory  [TS]

**Files:** `src/tools/introspect/hayba-introspect.ts`, `src/tools/pcg/pcg-primitives.ts`,
`src/tools/pcg/pcg-cook-and-wait.ts`, `index.ts`.

**Change:** Re-express these python-backed tools using the Task 6 factory +
Task 7 single-source descriptor, as the proof that the factory carries real tools
and removes boilerplate. Behavior, names, params, and the live-validated Python
must be byte-identical in effect (the UE 5.7-validated accessors: `g.nodes`,
`node.node_title`, `pin.properties.label`, enum E-strip, transient-graph pin read).

**Acceptance:** the migrated tools behave identically; existing tests still pass;
new factory-level tests cover them. tsc clean; vitest green.

---

## Task 9 — C++: async-job registry + build_*/test_run job envelope  [C++ needs-rebuild]

**Files:** `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPBuildHandler.cpp`
(`RunOrBackground` ~215-248, the 300s `Future.WaitFor`),
`HaybaMCPTestHandler.cpp` (~221 busy-sleep), a new shared async-job registry, and a
new `build_status`/`job_status` reader command + TS wrappers/docs.

**Spec:** Per `docs/audit/2026-06-22-mcp-async-command-conversions.md` Task 1 + Shared
note: a process-global `TMap<FString,FJobState>` guarded by `FCriticalSection`;
`build_*`/`test_run` allocate a job id, kick the subprocess on a background
`AsyncTask`, return `{job_id,status:"running"}` immediately (NO `WaitFor` on the
game thread); the background task writes `{status:"done",exitCode,output}` under the
lock + appends to the operation journal; `build_status {job_id}` reads it. Update tool
descriptions to state the job-envelope contract.

**Acceptance (deferred, in-editor):** `build_project` returns immediately, editor
responsive; `build_status` reports `done` with exit code; parallel command not
blocked. **This task's gate is code-review against the audit spec; commit tagged
[needs-rebuild].**

---

## Task 10 — C++: IsInGameThread inline guards for the deadlock handlers  [C++ needs-rebuild]

**Files & sites (from crash audit):**
- `HaybaMCPCommandHandler.cpp:226` (Critical) — `CaptureBeforeState` AsyncTask(GameThread)+Wait→UAF: run the capture body inline when `IsInGameThread()`.
- `HaybaMCPIdleHandler.cpp:248` — inline the GC nudge/BusyOnEntry/AddTicker (already on game thread); replace blocking Wait per audit fix (cooperative tick loop or defer). Coordinate with Task 9's job registry per the async doc Task 2.
- `HaybaMCPRenderHandler.cpp:470` (and 309) — `IsInGameThread()` branch: call `RunOnGameThread(S)` inline, skip the FEvent Wait.

**Spec:** apply the audit's fixes verbatim (each entry has an exact fix). The
unifying rule: never `AsyncTask(GameThread)+Wait`/`FEvent::Wait` while already on
the game thread — run inline. Do not break the existing `HaybaGameThread::RunSync`
seam.

**Acceptance (deferred, in-editor):** `actor_delete`/`wait_for_idle`/`render_camera`
do not freeze the editor. **Gate: code-review vs audit; commit [needs-rebuild].**

---

## Task 11 — C++: input-validation guards for the assert/OOB crashes  [C++ needs-rebuild]

**Files & sites (from crash audit):**
- `HaybaMCPSplineHandler.cpp:159` (+ remove path ~184) — range-check `Index` vs `GetNumberOfSplinePoints()`.
- `HaybaMCPBehaviorTreeHandler.cpp` (`BTConnect` ~264 / `FindNodeByGuidRecursive` ~43) — reject cycles (Parent reachable from Child) or add a visited-set.
- `HaybaMCPPIEHandler.cpp:325` — clamp `TimeoutMs = FMath::Clamp(TimeoutMs, 0, 30000)`.
- `HaybaMCPEditorHandler.cpp:105` (+161, +453) — type-check before `StaticCast<FEditorViewportClient*>` (use `IsA` or `GetFirstLevelEditor()->GetActiveViewportClient()`); returns null during PIE.
- `HaybaMCPIdleHandler.cpp:269` — clamp `TimeoutSeconds` to [0,3600] before the uint32 cast.
- `HaybaMCPEditorHandler.cpp:319` — StreamLog: read only the tail (seek to `Size - 64MB`), fixes freeze + int64→int32 narrowing.

**Spec:** apply each audit fix verbatim. These are independent small guards.

**Acceptance (deferred, in-editor):** the cited malformed inputs return errors
instead of crashing. **Gate: code-review vs audit; commit [needs-rebuild].**

---

## Task 12 — C++: extend the SEH guard to the ProcessCommand seam  [C++ needs-rebuild]

**Files:** the `ProcessCommand` dispatch seam (per audit/memory near
`HaybaMCPCommandHandler.cpp` ProcessCommand ~664 and the TcpServer dispatch at
`HaybaMCPTcpServer.cpp:133`), `HaybaSeh::RunGuarded` (existing reusable guard).

**Current:** SEH (`HaybaSeh::RunGuarded`) wraps only the python and material
handlers → 31 of 33 handlers are unrecoverable on a structured exception.

**Change:** wrap the single `ProcessCommand` handler-dispatch call in
`HaybaSeh::RunGuarded` so ANY handler that hits an SEH exception returns a clean
error envelope instead of taking down the editor — making the whole 33-handler
surface recoverable. Preserve existing per-handler guards (no double-guard harm,
but avoid redundant nesting where trivial). Ensure the guarded path still returns
the correct `FHaybaHandlerResult`/error envelope.

**Acceptance (deferred, in-editor):** a deliberately crashing handler returns an
error, editor survives. **Gate: code-review vs audit; commit [needs-rebuild].**

---

## Execution order
TS first (build confidence, keep tests green): 1, 2, 3, 4, 5, 6, 7, 8.
Then C++ (committed `[needs-rebuild]`, in-editor smoke deferred): 9, 10, 11, 12.
