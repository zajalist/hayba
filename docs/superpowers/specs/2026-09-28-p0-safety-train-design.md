# P0 safety train: design spec

- **Date:** 2026-09-28
- **Branch:** `fix/p0-safety` (worktree `.worktrees/p0-safety`), based on `feat/multi-agent-leases` at `d5a1a205`.
- **Status:** design approved for implementation planning. Maintainer decisions D1, D2 and D5 are binding (section 2). D7 is open and must be decided before Deploy B (§2.3). Revised after critic round 1; Appendix B lists what was merged or rejected.
- **Source:** the first consumer project's postmortem, `docs/postmortems/2026-09-28-consumer.md`. It is currently untracked in the main checkout, and this spec calls it "the postmortem". Its incidents are cited as I-1 … I-10 and its recommendations as P0-1 … P0-5.
- **Conventions:**
  - `P` = `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit`.
  - Line numbers are at `d5a1a205` unless a line says otherwise.
  - "Router" means `FHaybaMCPCommandHandler::ProcessCommandInContext` (`P/Private/HaybaMCPCommandHandler.cpp:1237`).
  - Items keep the numbers they had in the item designs (01–06). Tasks (T1–T10) are the delivery order.

| Item | Postmortem | What it fixes | Effort |
|---|---|---|---|
| 04 | P0-3 | Sticky `editor_unsafe`: stop working after a contained native fault, and warn the user | M+ |
| 06 | P0-2 | Editor state, `pie_active` and `asset_busy` refusals | M+ |
| 01 | P0-1, the handle | `lease_id`: a lease handle that survives redaction | S |
| 05 | P0-4 | Save sites: no `appError`, and a `package_read_only` refusal | M |
| 03 | P0-5 | `EnforcedForWrites` default, `owner_required`, rate-limited warnings | S |
| 02 | P0-1, the binding | Lease lifetime and owner binding: renew by owner, orphan grace, `lease_adopt` | M |

---

## 1. Intent and success metrics

**Intent.** Three editor crashes in nine hours (I-3, I-4, I-6) and 39 PIE sessions with agent mutations inside them (I-7) share one cause. Hayba had no server-side safety state: it answered after a fault as if nothing had happened, and it let any caller mutate during PIE or another owner's build. Its lease system never worked, because Hayba redacted its own handle (I-5). This train makes the editor refuse unsafe work itself, gives clients a lease handle they can actually use, and removes the save path that turned a read-only file into a crash. Clients no longer need to be careful for the editor to stay safe.

**What T1 can and cannot do.** Refusing agent commands after a contained native fault stops *agent* follow-on work. It does not by itself prevent the crash that follows a Python fault. The engine calls into Python on every garbage collection: `FPythonScriptPlugin::OnPreGarbageCollect` is bound to the pre-GC delegate (UE 5.8 `PythonScriptPlugin.cpp:1397`, `:2175`) and runs Python's `gc.collect` inside the damaged interpreter. GC runs after every Blueprint compile (`BlueprintCompilationManager.cpp:426`) and about every 61 s from `UWorld::Tick` (`LevelTick.cpp:1970`). In I-6 there was no GC between the 02:10:01 fault and 02:10:13; the crash came in frame 886, the frame of `Compiling BP_Consumer_Pawn before play`, with a `python311 ← PythonScriptPlugin ← CoreUObject` stack. So after a Python fault, the user's own Compile or Play, or the next periodic GC, still crashes the editor, typically within about a minute. T1 therefore also (a) tells the person at the editor within one frame, with a persistent notification that says what to do, (b) unhooks Python from the pre-GC delegate to buy time, and (c) with T2, vetoes the user's Play button while unsafe. **Success for a fault means the user was warned in time to save, not that the crash never comes.**

**Success metrics.** The metrics and baselines come from postmortem §10. They are measured on the consumer's editor logs over the 7 days after Deploy B (section 7), and are normalised by the number of `Processing command` lines.

| # | Metric | Baseline | Target | How it is measured | Moved by |
|---|---|---|---|---|---|
| M1 | Lease handles rejected as unknown, per issued lease | 27,423 / 134 acquires | < 1 % | Numerator: `lease_conflict` refusals and `lease_warning` lines with reason `lease_unknown`, **including the suppressed counts** in rate-limited lines (M2). Denominator: granted `lease_acquire`. | T4, T7 |
| M2 | Lease warnings per hour | ≈ 12,900 | < 50 | `LogHaybaMCPLease` Warning lines per hour. Once T6 lands, lines are rate-limited, so also sum `(+N identical …)` and `repeated N more times` so that suppression does not hide a regression. | T4, T6, T8 |
| M3 | `editor_batch` jobs completed | 0 (1 refused) | P0 acceptance: at least 1 end-to-end job on the consumer's editor after Deploy B. Steady state: every World Partition bulk edit | `batch_status` reaching `succeeded`, or the batch job's completion log line | T4, T7 |
| M4 | Commands accepted after an `HCR-NATIVE-*` fault, before a refusal | ≥ 3 in the postmortem table; I-6 shows 15 (14 `python_run` plus `editor_start_pie`) | 0 accepted outside the unsafe allowlist | Commands dispatched after the `editor_unsafe: native fault` Error line whose name is not in `CommandsAllowedWhileUnsafe(cause)` | T1 |
| M5 | PIE sessions with accepted mutations | 39 of 53 | 0 | Within each PIE window (from `Creating play world package` to end of PIE), dispatched commands whose PIE rule is `Refuse` | T2 |
| M6a | Agent-started PIE pre-play compiles of an asset under an open build | 2 (02:04:03, 02:10:13) | 0 | `Compiling <asset> before play` for an asset listed in `editor_get_state.building`, where an `editor_start_pie` was dispatched in the previous 5 s | T3 plus the §5.1 bpgraph lease step (Deploy A) |
| M6b | User-Play pre-play compiles of an asset under an open build | 4 (22:13:46, 22:15:43, 22:25:42, 23:56:26: no `editor_start_pie` in the log, so the user's Play button) | 0 if D7 is approved; not moved in P0 if D7 is declined | the same line with no `editor_start_pie` in the previous 5 s | T10 (Deploy B, only if D7 is approved) |
| M7 | Editor crashes with a Hayba command in the last 10 s, per 10 k commands | 3 in ≈ 68 k (≈ 0.44) | < 0.05 | Crash dumps under `Saved/Crashes` checked against the log. Needs a rolling window of at least 60 k commands before it means anything. A crash that follows a contained fault still counts, even when the user was warned (M8) | T1 (GC unhook, Play veto with T2), T2, T3, T5 |
| M8 | Contained faults that warned the user within one frame | 0 (no warning existed; I-6's only trace was an agent reply) | 100 % | Every `editor_unsafe: native fault` Error line is followed by the `editor_unsafe: user notified` line with a `frame` value at most one greater (both lines carry `GFrameCounter`) | T1 |

Secondary: `read_only` save crashes (I-3 class) = 0, and `package_read_only` refusals carry a hint 100 % of the time (T5).

---

## 2. Decisions

### 2.1 Binding maintainer decisions

- **D1: lease enforcement defaults to `EnforcedForWrites`.**
  - Reads are free and conflicting writes are refused.
  - It is deployed in the same change as the `lease_id` fix (T4), never before it. Before T4, every handle arrives as `[REDACTED:token]`, so enforcing would turn the 27,423 warnings into 27,423 refusals.
  - In this train the flip is T8, and T8 ships only in the same deploy as T4.
- **D2: `editor_unsafe` refuses writes, Python, saves, compiles and PIE.**
  - Reads stay allowed.
  - Only an editor restart clears it. A clear path may exist for automation tests only; this design uses a test-only override and has no clear command at all.
  - This spec applies D2's "refuses PIE" to the user's Play button too (T2 design 9), and narrows "reads" to status commands after a fault that stranded a package save (T1 design 2), because object lookups are themselves fatal in that state.
- **D5: a build marks itself busy by holding `asset:<path>` X leases.**
  - `build_begin` / `build_end` are at most thin wrappers over `lease_acquire` / `lease_release`, and are not part of P0.
- **Branch.** Work lands on `fix/p0-safety`. It is later merged into:
  - `<deploy-branch>`, the consumer hotfix;
  - `feat/hayba-brain-client`, the trunk (called `bc` below).
- **Consumer priority:**
  1. sticky `editor_unsafe`, plus `editor_get_state` with `pie_active` / `asset_busy` refusals;
  2. `lease_id`;
  3. the save-site fix.

  Section 3 orders the tasks this way wherever dependencies allow.
- **Compatibility.** The consumer's `editor_gate.py` reads the lease handle under `token`. This spec defines the transition (§4.4) and the host changes (§5).

### 2.2 Decisions this spec makes to reconcile the item designs

The six item designs were written in parallel and disagree in a few places. These rulings are final for implementation; Appendix A lists every override.

- **R1. `token` is never emitted again.** Output carries `lease_id` only (item 01).
  - Items 02, 04 and 06 assumed the editor would keep sending a redacted `token` during the transition. That is superseded.
  - `token` survives only as a deprecated **input** alias on `lease_renew` / `lease_release`.
  - The consequence is a hard deploy precondition: the migrated gate must be installed before Deploy B (§5.2). Recovery, if an old gate slips through, is `lease_release {all:true}` sent with the lease's owner (T7).
- **R2. One gate order, one refusal builder.** Router refusals are built by a single file-static `MakeGateRefusal` with explicit advisory signals, never through `SignalsForError` substring matching. The order is fixed in §4.1.
- **R3. No new field on `FHaybaHandlerResult`.** Item 02 proposed a `Code` field on the public struct. Satellites build against `Public/IHaybaMCPHandler.h`, so this is rejected. Handler-level codes use one of two channels (§4.2):
  - a structured `Ok(Data{ok:false, code, …})` refusal, promoted to a top-level `code` by `IsWireRefusalCode` (item 05's channel);
  - a bracketed `[code]` prefix in the error text (item 01's channel).
- **R4. A dead lease handle on a write is refused as `lease_conflict` with `lease.reason: "lease_unknown"`** (item 03). There is no separate top-level `lease_unknown` code (item 02 proposed one). The handler-level code for an unknown id is `[lease_id_unknown]`.
- **R5. Redaction markers.**
  - A `[REDACTED:…]` value in the envelope `lease` counts as **absent** for enforcement, with a rate-limited `lease_warning` reason `lease_handle_redacted`.
  - A marker under the deprecated `token` param of `lease_renew` becomes renew **by owner** (item 02's shim). Under `lease_release` it releases only the owner's legacy gate leases (label `editor_gate:<owner>`, not yieldable batch leases); anything else answers `[lease_id_redacted]` with a hint to send `all:true` (T7 design 4).
  - A marker under the canonical `lease_id` param is an error, `[lease_id_redacted]` (item 01).
- **R6. `lease_renew` with no id renews by owner** once T7 lands (item 02). Before T7 it answers `[lease_id_required]`. `lease_release` always needs exactly one of `lease_id` (or `token`), `ticket` or `all:true`.
- **R7. Health field names come from item 04.** `editor_get_state` and `ping` report `editor_unsafe`, `python_unhealthy` and `health{}`. Item 06's `python` / `unsafe` / `unsafe_detail` are not added.
- **R8. ADR numbering.** ADR-0011 is sticky `editor_unsafe` (T1). ADR-0012 is editor-state guards (T2, and D7 if approved).
- **R9. Node lease environment.** The Node MCP server seeds its envelope `lease` only from `HAYBA_LEASE_ID`, an explicit opt-in. It never reads `HAYBA_LEASE` (the helper-process variable the gate prints) or `HAYBA_LEASE_TOKEN`; if either is set it logs one `console.error` saying it is ignored. A marker value is ignored with a warning. When a reply reports `lease.reason: "lease_unknown"` (or `[lease_id_unknown]`) for the env-seeded lease, Node clears it (`setLease(null)`) and logs once. The owner match already covers a lane's own gate lease, so an inherited lease adds only risk: after a release, re-grant or editor restart it would make every write from that server a `lease_conflict` for the rest of the session.
- **R10. Asset-busy precedes the lease gate.** An `editor_start_pie` against another owner's asset build answers `asset_busy`, not `lease_conflict`.
- **R11. Files carrying uncommitted work in the main checkout.** The main checkout `D:/Hackathons/hayba` is on `feat/multi-agent-leases` at `d5a1a205`, which is `fix/p0-safety`'s own base (not on `bc`). Someone else's uncommitted work there touches these files:
  - `Public/HaybaMCPAssetGuard.h`, `handlers/HaybaMCPAssetHandler.cpp`;
  - `src/tools/tool-executor.test.ts`, `src/tools/heavy-ops.ts`, `src/tools/index.ts`, `src/tools/asset/asset-delete*`.

  It collides with `fix/p0-safety` as soon as its owner commits it on the base branch, not only at the `bc` merge. New TS tests go in new files; the item designs' cases for `tool-executor.test.ts` move to `src/tools/ue-refusal-codes.test.ts`. The only permitted `index.ts` edit is T2's `editor_get_state` descriptor block, kept to one hunk.
- **R12. One command-set header.** `P/Private/HaybaMCPCommandSets.h` (pure, built in T1) owns the named command sets: `StatusOnlyCommands()` (never resolve a UObject), `ControlPlaneCommands()`, `ReadCommands()` and `PieObservationCommands()`. The unsafe allowlist (T1), the PieSafe rule (T2) and write detection (T8) are all built from these sets, so there is one read list, not three.
- **R13. PIE commands authorized by slot 2 skip the lease gate.** A drive command from the PIE's owner, or `editor_stop_pie` of an agent PIE, is authorized by the PIE state and never goes through slot 4. Otherwise any other owner's global or world X lease (acquired during the PIE, since `lease_acquire` is PieSafe) would deadlock the PIE owner (T8 design 5).
- **R14. A contained fault warns the human, not only the agents.** Every cause posts a persistent editor notification (T1 design 11). Agent refusals alone do not protect unsaved work.

### 2.3 Open decision

- **D7: veto the user's Play button through `IPIEAuthorizer` while another owner holds an asset build lease** (item 06c).
  - The roadmap assumption behind D5, that "PreBeginPIE cannot veto", is correct. However, `IPIEAuthorizer` (a modular feature) can veto, and it runs before the pre-play Blueprint compile.
  - **D7 must be decided before the Deploy B build window.** Four of the six recorded pre-play compiles under an open build came from the user's Play button (M6b), which nothing else in P0 stops.
  - If D7 is approved, T10 ships in Deploy B with at least mode 1 (veto with a double-press override); it needs only T3 and T2's authorizer.
  - If D7 is declined, M6 stays split (M6a moved by T3, M6b not moved in P0), and T10 ships with mode 0 (notification only) or is dropped.
  - The **unsafe** Play veto is not part of D7. D2 already says unsafe refuses PIE, so it ships in Deploy A as T2 design 9.

---

## 3. Tasks in delivery order

| Task | Item / slice | Effort | Depends on | Deploy | Rebuild |
|---|---|---|---|---|---|
| T1 | 04: sticky `editor_unsafe`, user notification, Python GC unhook, batch pump stop | M+ | none | A | full |
| T2 | 06a: editor state, eager PIE hooks, `pie_active`, pause-aware batch hold, unsafe Play veto, `pie_blocked` | M+ | T1 (gate slot, health fields, command sets, limiter) | A | full |
| T3 | 06b + S1: `asset_busy`, asset-write seam | S | T2 | A | full |
| T4 | 01: `lease_id` | M | none (host gate first) | B | full |
| T5 | 05: save sites, plus `python_run` unattended | M | T1 (Python guard site) | B | full, including the MetaSound satellite |
| T6 | 03 c1+c2: enforcement policy, owner in the log line, lease-warning rate limit | S | T1 (limiter) | B | full |
| T7 | 02a: lease lifetime: idempotent acquire, renew by owner, release all, touch-on-use, orphan grace, marker shim | M | T4 | B | full |
| T8 | 03 c3 + 06d: `EnforcedForWrites` default, `owner_required`, fail-closed write detection, PIE reclassification | M | T4, T6, T7 (D1) | B | full |
| T9 | 02b: owner-first identity, reserved owners, `lease_adopt` | M | T7, T8, host `HAYBA_AGENT_ID` step | C | full |
| T10 | 06c: user Play veto for builds | S | D7 sign-off, T2 (authorizer), T3 | B if D7 is approved before the Deploy B window; otherwise later | full |

Notes on the order:
- **Parallel development.** Tasks can be developed on sub-branches in parallel, but they land on `fix/p0-safety` in this order. Each task is one or more commits that build and pass the suites on their own.
- **Deploy A** (T1–T3) is consumer priority 1. It needs no host change to be safe. M6a moves only once the §5.1 bpgraph lease step is installed on the host.
- **Deploy B** (T4–T8) is priority 2 then 3, plus everything D1 ties to `lease_id`.
  - Cut line: if time runs short, T4 to T6 can ship without T7/T8, and enforcement then stays Advisory. **T8 must never ship without T4.**
- **One window.** If the consumer prefers a single build window, A and B ship together.

### 3.0 Shared seams (built once, by the first task that needs them)

| Seam | Built in | Reused by |
|---|---|---|
| Gate block after auth, in the §4.1 order | T1 | T2, T3, T8, T9 |
| `MakeGateRefusal(Id, Cmd, const FGateRefusal&)`: a file-static in the router that sets top-level `code`, one detail object and explicit advisory signals, and serializes once through `JsonToString` | T1 | T2, T3, T8, T9 |
| `P/Private/HaybaMCPCommandSets.h` (R12): pure named command sets | T1 | T2, T8 |
| `P/Private/HaybaMCPWarningLimiter.h`: pure `FWarningLimiter` (30 s window, at most 512 keys, `DrainExpired`, `conn:<n>` collapsed to `conn:*`, injected clock). Every refusal Warning log goes through it from Deploy A on | T1 | T2 (`pie_active`), T3 (`asset_busy`), T6 (lease warnings) |
| `FHaybaPIEAuthorizer : IPIEAuthorizer`, registered in `FHaybaMCPEditorState::Startup` | T2 (unsafe branch) | T10 (build branch) |
| Batch `Pump` preamble, in this order: unsafe stop (T1), lease keep-alive, PIE hold (T2), `Machine->Tick` | T1, T2 | T4, T7 |
| `IsWireRefusalCode(const FString&)`: a file-static fixed set. `ShapeOkResponse` promotes `data.code` to top-level `code` when `!bOperationSucceeded` and the code is in the set | T5 | T5 only in P0 |
| `UeToolErrorCode` / `KNOWN_UE_CODES` (`src/tools/tool-executor.ts:6-31`), `TcpResponse` fields (`src/tcp-client.ts:20-33`) | T1 | T2, T3, T5, T8, T9 |
| `AssetPackageKey`, and `AssetWriteCommands` with blueprint and UI rows | T3 (S1) | T3, T8, T10 |
| Rebuild rule: every task is a **full editor rebuild with the editor closed** (layout changes, new translation units, UENUM changes). Live Coding is for iterating on handler bodies during development only. | all | all |

---

### T1: Sticky `editor_unsafe` (item 04; postmortem P0-3; I-3, I-6)

**Current state**
- There are two `__except` blocks:
  - `HaybaSeh::RunGuardedRaw` (`P/Private/HaybaMCPSeh.cpp:19-33`), used by the dispatch guard (`HaybaMCPCommandHandler.cpp:1546-1575`) and by three MaterialHandler sites;
  - `ExecPythonGuardedRaw` (`handlers/HaybaMCPPythonHandler.cpp:1761-1784`).

  Neither records anything.
- `HCR-NATIVE-002` has five early returns (`PythonHandler.cpp:2180-2277`) with no `UE_LOG`. That is why the 02:10:01 fault left no line in the editor log. Their text says "kept alive" and tells the user to "restart the disposable editor".
- `SignalsForError` (`:337-362`) decides `session_suspect` by searching the message for "seh". Two consequences:
  - "Property 'BaseHealth' not found" is flagged suspect, a false positive;
  - the four post-execution texts fall into the `hcr-` branch and are labelled `policy_blocked` / `not_started`, although the script already ran.
- No state survives a fault. In I-6, 14 `python_run` calls and one `editor_start_pie` were accepted afterwards.
- `EXCEPTION_EXECUTE_HANDLER` also swallows `appError`'s 0x4000 (UE 5.8 `WindowsPlatformCrashContext.cpp:109`), which strands save scopes (I-3).
- TS side:
  - `python-run.ts:268-290` drops `advisory` and labels every HCR code `retry_unchanged: forbidden` with no `mutation_status`.
  - `src/tools/__tests__/seh-postprocessing-gate.test.ts:33-36` pins the old wording.

**Design**
1. **Health state.** New files `P/Private/HaybaMCPEditorHealth.h/.cpp` define `FHaybaEditorHealth`, a process-wide, sticky, game-thread object.
   - Flags: `IsUnsafe()` and `IsPythonUnhealthy()`, both seq_cst `std::atomic<bool>`; `FaultSequence()`, a uint64.
   - Methods: `RecordCaughtFault()`, `NoteRefusal()`, `Snapshot()`, `WriteJson()`, and `FScopedDispatchNote(Cmd, Id, Owner)`, which stores pointers and does not allocate.
   - Under `WITH_DEV_AUTOMATION_TESTS` only: `FScopedOverrideForTests` and `IsTestOverrideActive()`. There is no production clear.
   - `RecordCaughtFault` runs in ordinary code after the guard has returned (never inside the `__except` filter), on the game thread, in this order:
     1. Flip the atomics first.
     2. Gather `GIsCriticalError`, `UE::IsSavingPackage(nullptr)`, `FDebug::HasAsserted()`, and the first line of `GErrorHist` (≤ 512 chars).
     3. Copy the dispatch note (each field ≤ 128 chars) and keep the first fault.
     4. Log **one** Error line in `LogHaybaMCPHealth`, with the frame number:
        `[<fault_code>] editor_unsafe: native fault <0xCODE> contained in '<cmd>' (id <id>, owner <owner>, site <site>, cause <cause>, frame <GFrameCounter>). Fault contained; restart the editor before further work. Until restart Hayba refuses writes, Python, saves, compiles and PIE (editor_unsafe_restart_required); <tail>.`
        The tail is `reads still answer` for `python_native_fault` and `native_fault`, and `only status commands answer` for `engine_fatal_swallowed` and `stranded_package_save` (design 2).
     5. For `python_native_fault` only: unhook Python from the pre-GC delegate (design 12).
     6. On the first fault only: schedule the user notification (design 11).
2. **Pure policy** in a new header, `P/Private/HaybaMCPHealthPolicy.h`.
   - `ClassifyCaughtFault(Site, Code, bCriticalError, bSavingPackage)` returns one of these causes:
     - `engine_fatal_swallowed` for 0x4000, 0xC000 or 0x8000, or when `GIsCriticalError` is set;
     - `stranded_package_save` when a package save was in progress;
     - `python_native_fault` when the site is Python;
     - `native_fault` otherwise.
   - Fault codes:
     - `HCR-NATIVE-002` for Python (existing);
     - `HCR-NATIVE-003` for native_fault (new);
     - `HCR-NATIVE-004` for engine_fatal_swallowed and stranded_package_save (new).
   - The allowlist depends on the cause. `CommandsAllowedWhileUnsafe(ECause)` returns the set (M4 and `AllowlistDrift` read it), and `IsCommandAllowedWhileUnsafe(Cmd, Cause)` tests membership. Both are built from the R12 sets in `HaybaMCPCommandSets.h` and fail closed: an unlisted command is refused. The gate uses the most severe cause seen so far, so a later HCR-NATIVE-004 fault narrows the list even though the health record keeps the first fault's details.
     - **Status only** (`StatusOnlyCommands()`, commands that never resolve a UObject): ping, editor_get_state (dirty walk skipped), editor_get_output_log, editor_stream_log, lease_status, lease_release, batch_status, build_status, test_get_log, get_setting, ui_tool_stream, ui_tool_stream_new_turn. **This is the whole allowlist after `engine_fatal_swallowed` or `stranded_package_save` (HCR-NATIVE-004).** A stranded save leaves `GIsSavingPackage` set, because SEH unwinding skipped the save scope's destructor, and `StaticFindObjectFast` is then fatal (UE 5.8 `UObjectGlobals.cpp:535`, "Illegal call to StaticFindObjectFast() while serializing object data!"), which is I-3's next-frame crash. Every object-path read would take that path.
     - **After `python_native_fault` or `native_fault`**, the status set plus:
       - control plane: test_list, test_cancel, ui_memory_set;
       - reads (`UnsafeReads`, asserted to be a subset of `ReadCommands()`): project_get_info, level_get_info, level_list, actor_list, actor_get_properties, actor_get_components, object_get_property, asset_get_info, asset_search, asset_browse, asset_registry_query, asset_get_dependencies, asset_get_referencers, asset_get_references, blueprint_get_info, blueprint_inspect_graph, material_get_info, material_list, mesh_get_info, mesh_list, texture_get_info, texture_list, wp_get_cells, wp_get_streaming_state, docs_search, docs_lookup_api, docs_lookup_class.
     - **Refused, including:** python_run at every tier; every editor_pie_* and editor_start_pie / editor_stop_pie; every *_compile and *save*; captures and renders; lease_acquire, lease_renew, lease_adopt (T9) and editor_batch; test_run and wait_for_*; editor_run_console_command and editor_live_compile.
3. **One guard that always records.**
   - `Public/HaybaMCPSeh.h` gains `enum class EHaybaFaultSite {Dispatch, Python, HandlerInner, TestInjection}` and `RunGuardedAt(Site, fn, ctx, bCrashed)`. `RunGuarded` forwards to it with `HandlerInner`.
   - `RunGuardedRaw` captures the exception code: `__except (OutCode = GetExceptionCode(), EXCEPTION_EXECUTE_HANDLER)`.
   - `RunGuardedAt` then repairs the world switch and calls `RecordCaughtFault`.
   - `ExecPythonGuardedRaw` and `<excpt.h>` are deleted. Python goes through `RunGuardedAt(Python, …)` with a captureless lambda and a POD context (C2712-safe).
   - Result: **exactly one `__except` in the toolkit.**
4. **Refusal gate** in the router, after the auth gate (`:1299`) and before the lease gate (`:1301`). It is the §4.1 slot 1. Routed batch steps (`ProcessBatchStep`) and in-process callers take the same path. The batch pump's own native work does not go through the router; design 13 covers it.
   - The first refusal logs at Error. Later ones log at Warning through `FWarningLimiter` (built here, in `HaybaMCPWarningLimiter.h`, §3.0): at most once per command every 30 s, with the suppressed count.
5. **The command that faulted.**
   - `FaultSequence()` is read before dispatch.
   - If the dispatch guard crashed, or if the sequence changed (an inner Python or material guard caught the fault, even when the handler then returned `Ok`), the router returns `native_fault_contained` and skips panels and diff.
   - `FHaybaMCPAdvisorySignals` gains `bEditorUnsafe`, which gives `session_health: "restart_required"`, `retryable: false` and a mandatory recovery line.
6. **`SignalsForError`** stops inferring anything from prose. A command is suspect when `bSessionSuspect` is set or the text contains `[hcr-native-002|003|004]`. Those codes are excluded from the `hcr-` policy branch.
7. **Python fault results.** The five `HCR-NATIVE-002` returns become `MakeNativeFaultResult(rule, bPostExecution)`, which returns `Ok(Data{ok:false, policy_code, matched_rule, execution_phase, phase, mutation_status:"unknown", may_have_executed:true, session_suspect:true})`.
   - The wording drops "kept alive" and "disposable". The MaterialHandler texts (`:3099-3100`, `:3177-3178`, `:3259-3263`) change the same way.
   - **Corruption without a caught fault.** An interpreter can be damaged without an SEH catch (a native callback outside the guard, or a script that corrupts memory without faulting). Later scripts then fail with CPython-internal errors, as the 14 `SystemError: unknown opcode` lines at 02:10:12-13 did, and today those are reported as ordinary script errors. After execution, the `python_run` handler scans the captured LogPython and exception text for these markers: `SystemError: unknown opcode`, `bad argument to internal function`, `error return without exception set`, `Fatal Python error`. On a match it calls `RecordCaughtFault(Python, 0, …)` with cause `python_native_fault` and `HCR-NATIVE-002`, and the reply is `native_fault_contained`. The marker list is a `static const` array in `HaybaMCPHealthPolicy.h` (`IsPythonCorruptionMarker(Text)`), so it is testable without Python.
8. **Reporting.**
   - `editor_get_state` writes the health fields first. After `engine_fatal_swallowed` or `stranded_package_save` it skips the dirty-package walk (`dirty_packages_skipped: "editor_unsafe"`).
   - `ping` carries the same health fields plus `capabilities.editor_health: true`.
   - `HaybaMCPResponseBuilder.h` `NeverDropTopLevelFields` gains `editor_unsafe`, `python_unhealthy`, `health` and `may_have_executed`.
9. **Fault injection** (test only). `test_inject_native_fault` lives in `HaybaMCPTestHandler.cpp` and is compiled only under `WITH_DEV_AUTOMATION_TESTS && PLATFORM_WINDOWS`.
   - It refuses unless all three hold: a health override is active, `ConnId == 0`, and `GIsAutomationTesting`.
   - Params: `kind` is `access_violation` or `engine_assert`; `site` is `dispatch`, `python` or `handler_inner`.
   - It is not in `sidecar.json`, not agent-callable, and has no TS wrapper.
10. **TS.**
    - `nativeFailureFacts(uePayload, nativeError, allowUnsafe)` in `python-run.ts` maps, in this order:
      - `editor_unsafe_restart_required` → `not_started`, `may_have_executed:false`, `retry_unchanged:"forbidden_until_restart"`;
      - `native_fault_contained`, `HCR-NATIVE-00x` or advisory `session_suspect` → `mutation_status:"unknown"`, `may_have_executed:true`, `retry_unchanged:"forbidden"`. This overrides a stale `policy_blocked` / `not_started`;
      - tier-3 and other HCR codes → as today, plus `not_started`;
      - anything else → the advisory is passed through.
    - `check-ue-status.ts` turns `ping.editor_unsafe` into a restart diagnostic.
11. **User notification** (R14). Agent refusals do not reach the person at the editor, and in I-6 that person lost unsaved work 12 s after the fault.
    - `RecordCaughtFault` schedules a one-shot `FTSTicker` delegate (never from inside the `__except` path, and never synchronously inside the faulting handler's stack). On the next tick, on the game thread, it posts a **persistent, non-modal** `FSlateNotificationManager` notification: `FNotificationInfo` with `bFireAndForget = false`, `ExpireDuration = 0`, `bUseSuccessFailIcons`, and a Dismiss button. It then logs `editor_unsafe: user notified (cause <cause>, frame <GFrameCounter>)` at Log level (M8).
    - Text by cause:
      - `python_native_fault` / `native_fault`: `Hayba contained a native fault in '<cmd>'. Save now (File > Save All) and restart the editor. Do not compile, press Play or load a map before restarting.`
      - `stranded_package_save` / `engine_fatal_swallowed`: `Hayba contained an engine fatal error in '<cmd>' during a package save. Do not save; restart the editor now. Saving in this state can crash the editor or write a corrupt package.`
    - It is raised at most once per process; a later fault only updates the log.
    - Under `IsTestOverrideActive()` nothing is posted; the poster is replaced by a counter that tests read.
    - Unattended processes (`FApp::IsUnattended()`, commandlets) skip it and log only.
12. **Python GC unhook** (`python_native_fault` only). `RecordCaughtFault` calls `FCoreUObjectDelegates::GetPreGarbageCollectDelegate().RemoveAll(IPythonScriptPlugin::Get())` when the plugin pointer is non-null. The engine binds `AddRaw(this, &FPythonScriptPlugin::OnPreGarbageCollect)`, and `IPythonScriptPlugin` is `FPythonScriptPlugin`'s first base, so the pointer matches the bound object.
    - This stops every later UObject GC (after a compile, or the periodic GC) from running `gc.collect` inside the damaged interpreter. It **buys time; it does not guarantee survival**: GC still reads the C++ side of Python-wrapped objects, and host scripts may have registered Slate or editor tick callbacks in Python. The notification (design 11) is what protects the work.
    - The unhook is logged once. Python's own garbage is no longer collected until restart, which does not matter because Python is refused.
    - Under the test override, the unhook goes through a seam that records the call instead of removing the real binding, so the test process keeps its Python.
13. **Batch pump while unsafe.** Two paths in `editor_batch` skip slot 1: `wp_region_load` / `wp_region_unload` steps run in-process through `RunRegionLoad` / `RunRegionUnload` (`HaybaMCPBatchHandler.cpp:378-386`), and the pump itself runs `UnloadAll` (cleanup), `CollectGarbage` (GC fences) and `Finalize`'s `ReleaseAll` (`:548-560`, `:571-640`). After a fault, a refused step drives the machine into cleanup, which would then unload World Partition regions and force a GC on a process that cannot be trusted; the forced GC is exactly the call that enters a damaged interpreter.
    - At the top of `Pump`, after the `bFinalized` / `bInPump` checks and **before** the lease keep-alive and `Machine->Tick`, check `FHaybaEditorHealth::IsUnsafe()`. If set, call `FinalizeUnsafe(S)` and return false.
    - `FinalizeUnsafe` finishes the job as failed with code `editor_unsafe_restart_required` (`SetDone(…, 1, …)`, with the code in the status), logs `batch <job8>: editor unsafe; N region(s) left loaded, the restart discards them`, calls `EndYield` and `SetYieldable(false)`, releases the batch's lease-table entry (a pure table operation, allowed while unsafe like `lease_release`), removes the ticker and the active entry. It never calls `ReleaseAll`, `UnloadAll`, `CollectGarbage` or `RunStep`.
    - `RunRegionLoad` / `RunRegionUnload` also check `IsUnsafe()` first and fail the step with `editor_unsafe_restart_required`, as defence in depth for a fault inside the same pump call.
    - This is the first entry of the pump preamble (§3.0); T2's PIE hold comes after the keep-alive.

**Wire**
```json
{ "id": "lane5_134212", "ok": false,
  "code": "editor_unsafe_restart_required",
  "error": "editor_unsafe_restart_required: 'editor_start_pie' was not run. A native fault was contained at 2026-09-28T02:10:01Z in 'python_run' (python_native_fault, HCR-NATIVE-002); the editor process can no longer be trusted. Fault contained; restart the editor before further work. Reads such as editor_get_state, ping and lease_status still answer.",
  "editor_health": { "editor_unsafe": true, "python_unhealthy": true, "restart_required": true,
    "cause": "python_native_fault", "fault_code": "HCR-NATIVE-002", "site": "python",
    "exception_code": "0xC0000005", "faulted_command": "python_run",
    "faulted_request_id": "apply_look_129156", "faulted_owner": "LANE4",
    "faulted_at_utc": "2026-09-28T02:10:01Z", "fault_count": 1, "refused_count": 15,
    "critical_error": false, "saving_package_stranded": false, "world_switch_repaired": false },
  "advisory": { "state": "policy_blocked", "code": "editor_unsafe_restart_required",
    "mutation_status": "not_started", "may_have_mutated": false, "retryable": false,
    "session_health": "restart_required",
    "mandatory_recovery": ["Fault contained; restart the editor before further work."] } }
```
The faulting command's own reply has `code: "native_fault_contained"`, error `native_fault_contained [HCR-NATIVE-003]: '<cmd>' raised native fault <code> (<cause>); its outcome is unknown …`, `editor_health`, `data` when there is any, and an advisory of `session_suspect` / `unknown` / `may_have_mutated: true` / `restart_required`.

After an HCR-NATIVE-004 cause, the last sentence of the refusal reads `Only status commands such as editor_get_state, ping and lease_status answer.`

No refusal text contains the word "token", so neither redaction layer can mangle it.

**Files**
- New:
  - `P/Private/HaybaMCPHealthPolicy.h`
  - `P/Private/HaybaMCPCommandSets.h` (R12)
  - `P/Private/HaybaMCPWarningLimiter.h`
  - `P/Private/HaybaMCPEditorHealth.h/.cpp` (including the notification and GC-unhook seams)
  - `P/Private/Tests/HaybaMCPEditorHealthTest.cpp`
  - `src/tools/__tests__/editor-health-contract.test.ts`
  - `docs/adr/0011-sticky-editor-unsafe.md`
- Modified, C++:
  - `Public/HaybaMCPSeh.h`, `P/Private/HaybaMCPSeh.cpp`
  - `handlers/HaybaMCPPythonHandler.cpp`
  - `HaybaMCPCommandHandler.cpp`: gate, `MakeGateRefusal`, fault branch, `SignalsForError`
  - `HaybaMCPAdvisory.h/.cpp`
  - `handlers/HaybaMCPMaterialHandler.cpp` (wording only)
  - `handlers/HaybaMCPEditorHandler.cpp` (`GetState`)
  - `handlers/HaybaMCPLegacyHandler.cpp` (`ping`)
  - `handlers/HaybaMCPTestHandler.cpp`
  - `handlers/HaybaMCPBatchHandler.cpp` (`FinalizeUnsafe`, pump preamble, region-step checks)
  - `HaybaMCPResponseBuilder.h`
  - `HaybaMCPToolkit.Build.cs`: `Slate`, `SlateCore` (notification) and `PythonScriptPlugin` (the `IPythonScriptPlugin` interface) if not already dependencies
  - `Tests/HaybaMCPAdvisoryBoundaryTest.cpp`, `Tests/HaybaMCPAdvisoryTest.cpp`
- Modified, TS:
  - `python-run.ts`, `tool-executor.ts`, `tcp-client.ts`, `check-ue-status.ts`
  - `python-run.test.ts`, `check-ue-status.test.ts`, `__tests__/seh-postprocessing-gate.test.ts`
  - new `ue-refusal-codes.test.ts` (R11)

**Tests** (C++, filter `Hayba`)
- `Hayba.MCP.Health.ClassifyCaughtFault`
- `Hayba.MCP.Health.UnsafeGatePolicy`: includes the HCR-NATIVE-004 case, where `blueprint_get_info`, `asset_get_info` and `object_get_property` are refused and only `StatusOnlyCommands()` answer.
- `Hayba.MCP.Health.AllowlistDrift`: every allowlisted name is registered or router-inline, and `UnsafeReads` ⊂ `ReadCommands()`.
- `Hayba.MCP.Health.DispatchFaultIsSticky`: expects the Error line exactly once, then refuses `python_run`, `editor_start_pie` (no PIE request queued), `blueprint_compile`, `ui_save_widget`, `audio_asset_save`, `level_save`, `editor_batch` and `lease_acquire`, while `editor_get_state`, `ping` and `lease_status` still answer. (`asset_save` is a TS python-factory tool, not a registered command, so it would prove nothing.)
- `Hayba.MCP.Health.PythonGuardFaultSetsPythonUnhealthy`: includes the corruption-marker case (a captured `SystemError: unknown opcode` with no SEH catch sets the flag and replies `native_fault_contained`).
- `Hayba.MCP.Health.InnerGuardOkResultIsForcedToFault`
- `Hayba.MCP.Health.EngineAssertCodeIsEngineFatal`
- `Hayba.MCP.Health.FaultInjectionIsGuarded`
- `Hayba.MCP.Lease.WarningLimiter` (the pure limiter; T6 extends it)
- `Hayba.MCP.Health.UserNotifiedOnce`: two injected faults raise the notification seam exactly once, with the cause-specific text; nothing is posted to Slate under the override.
- `Hayba.MCP.Health.PythonFaultUnhooksPreGc`: the unhook seam is called once for `python_native_fault` and never for `native_fault`.
- `Hayba.MCP.Health.BatchStepRefusedWhileUnsafe`
- `Hayba.MCP.Health.BatchPumpStopsWhileUnsafe`: a batch of `[wp_region_load, fault-injected step, wp_region_unload]` with a `gc` fence. After the fault, the pump finishes the job as failed with `editor_unsafe_restart_required`, and the seams record no `ReleaseEditorLoaderAdapter`, no `UnloadAll` and no `CollectGarbage`. The batch handler gains a test-only action recorder under `WITH_DEV_AUTOMATION_TESTS`; the test runs as an owned child because it loads a World Partition region.
- Extended: `Hayba.MCP.Advisory.ResponseBoundary` (the "BaseHealth" false positive, and a post-execution text that is never `not_started`) and `Hayba.MCP.Advisory.AllStates` (the `bEditorUnsafe` case, next to "caught SEH makes session suspect").
- `Hayba.MCP.Seh.WorldSwitchDriftClassification` must stay green.

**Tests** (TS)
- `python-run.test.ts`: the native advisory for each of the 5 matched rules, including a stale-binary payload.
- `ue-refusal-codes.test.ts`: the two new codes.
- `check-ue-status.test.ts`: the restart diagnostic.
- `seh-postprocessing-gate.test.ts`: no "kept alive" or "disposable editor".
- `editor-health-contract.test.ts`:
  - exactly one `__except`: strip `//` and `/* */` comments first, then match `__except\s*\(`; assert the count is 1 and the file is `Private/HaybaMCPSeh.cpp`. (A bare-token scan fails closed on the prose in `HaybaMCPSeh.h:26`, `:41` and `Tests/HaybaMCPSehWorldSwitchTest.cpp:5`.) It also matches the `RunGuarded(` form, per ADR-0007;
  - the unsafe gate precedes the lease gate; no prose inference;
  - the injection command is guarded and absent from sidecar and TS;
  - the allowlist never admits Python, PIE, save or compile; there is no production clear;
  - `RecordCaughtFault` is never called from inside an `__except` filter expression, and the notification is posted only from the ticker delegate;
  - the batch `Pump` checks `IsUnsafe()` before `Renew` and before `Machine->Tick`.

**Done when:** `DispatchFaultIsSticky`, `UserNotifiedOnce` and `BatchPumpStopsWhileUnsafe` pass headless, and the contract test proves a single `__except`.

---

### T2: Editor state, eager PIE hooks, `pie_active`, batch hold (item 06a; postmortem P0-2; I-6, I-7)

**Current state**
- `editor_get_state` (`handlers/HaybaMCPEditorHandler.cpp:197-217`) returns only `pie_running` and the dirty packages, and walks every `UPackage` on each call. That cost is why `apply_look.py` scans the log for PIE instead of asking the editor.
- `editor_start_pie` (`:172-183`) calls `RequestPlaySession` unconditionally.
  - With the user's PIE running, that ends the user's session (UE 5.8 `PlayLevel.cpp:1124`).
  - The pre-play compile (`:2654-2656`) is the I-6 fatal path.
- PIE hooks are bound lazily, on the first `editor_pie_*` command (`handlers/HaybaMCPPIEHandler.cpp:110-127`). Agents never sent one, so the hooks were never bound.
- Nothing in the router refuses anything during PIE. The batch `Pump` keeps running steps and GC fences during PIE.
- `IsDestructiveCommand` misses many writers (for example blueprint_compile, ui_set_variable and material_set_param), so a guard keyed on access class would fail open.
- Engine facts (UE 5.7 and 5.8): the order is PreBeginPIE (`:2584`), then the `IPIEAuthorizer` loop, then BeginPIE, then the pre-play compile. `IsPlayingSessionInEditor` may stay set after a Standalone launch (unverified).
- A loaded Blueprint in `BS_Error` with `bDisplayCompilePIEWarning`, or one that needs a prompted recompile, makes the queued PIE open a **modal dialog** on the next editor tick (UE 5.8 `PlayLevel.cpp:1313` compile prompt, `:1498` `ShowCompilationErrorsDialog`). Slate's modal loop does not tick `FTSTicker`, so the Hayba command drain and every batch pump hang until a human answers.
- The batch machine times fences against wall time (`HaybaMCPBatchPolicy.h:382`, `:474`: `In.Now - FenceStartedAt > FenceTimeoutSeconds`, default 120 s), and the batch lease is kept alive only inside `Pump` (`HaybaMCPBatchHandler.cpp:584-596`, renew at `:593`, TTL 90 s).

**Design**
1. **Pure policy header** `P/Private/HaybaMCPEditorStatePolicy.h` (namespace `HaybaMCPState`, no `GEditor`).
   - `FPieState {Kind: None/User/Agent, Phase: None/Queued/Starting/Running, Owner, bSimulating, Since}` and `LexPie()`, which returns `none`, `user` or `agent:<owner>`.
   - `FPieTracker` with `NoteAgentRequest`, `OnPreBegin`, `OnBegin`, `OnSwitchSimulate` and `OnEnd`.
     - The session is attributed to the agent only when its `editor_start_pie` request came within 5 s; otherwise it is the user's.
     - `EndSerial` increments on every end.
   - `ResolvePie(tracker, PlayWorld != nullptr, IsPlaySessionRequestQueued(), Now)` backstops a missed hook. It deliberately does not use `IsPlayingSessionInEditor`.
   - `PieRuleFor(Cmd)` returns `Safe`, `PieOwner` or `Refuse`. **The default is Refuse**, so unknown commands fail closed. The Safe set is the union of R12 sets (`ControlPlaneCommands()`, `PieObservationCommands()`, `ReadCommands()`) plus the PIE-specific control entries below; the lists below are the contents those sets must have, not a separate table.
     - **PieSafe**, state and control: ping, editor_get_state, lease_acquire, lease_renew, lease_release, lease_status, batch_status, get_setting, copilot_key_status.
     - **PieSafe**, router-inline: hayba_propose_plan, ui_memory_set, ui_tool_stream, ui_tool_stream_new_turn.
     - **PieSafe**, logs and performance: editor_get_output_log, editor_stream_log, editor_get_performance_stats, editor_get_perf_stats.
     - **PieSafe**, PIE observation: editor_pie_assert, editor_pie_wait_for, editor_pie_screenshot, editor_pie_widget_tree, editor_pie_actor_list, editor_pie_actor_inspect, editor_pie_project_world.
     - **PieSafe**, docs and the asset registry: docs_*, asset_search, asset_registry_query, asset_get_info, asset_get_dependencies, asset_get_referencers, asset_get_references.
     - **PieSafe**, plain reads: actor_list, actor_get_properties, actor_get_components, object_get_property, blueprint_get_info, blueprint_inspect_graph, anim_blueprint_get_info, bt_get_info, material_get_info, material_list, data_get, level_get_info, level_list, level_get_spatial_index, scene_get_actor_relations, spline_get_info, texture_get_info, texture_list, mesh_get_info, mesh_list, ui_query, ui_list_widget_types, ui_list_widget_blueprints, ui_report_findings, audio_list, audio_active_sounds, audio_asset_inspect, audio_meter_read, wp_get_cells, wp_get_streaming_state, project_get_info, project_get_settings, project_list_plugins, test_list, test_get_log, build_status, foliage_list_types, pcg_list_assets, list_pcg_assets, pcg_list_node_classes, list_node_classes, pcg_get_node_details, get_node_details.
     - **PieOwner**, drive commands: editor_pie_press_key, editor_pie_mouse, editor_pie_type_text, editor_pie_axis, editor_pie_click_widget, editor_pie_set_text, editor_pie_click_actor, editor_stop_pie.
   - `CheckPie` allows a command when there is no PIE or its rule is Safe. It allows a PieOwner drive command only from the agent that owns the PIE session. **Nobody drives or stops the user's PIE.** There is no `during_pie` escape in P0.
   - **`editor_stop_pie` of an agent PIE is allowed from any caller.** The recorded owner can become unmatchable: an owner-less raw client that opens one connection per call is `conn:<n>`, and a restarted Node server gets a new `node-<pid>-<rand>`. If only the owner could stop, every lane's mutations would get `pie_active` until a human pressed Stop, overnight included. A stop from a non-owner is logged at Warning with both owners. Drive commands stay owner-only.
   - A command slot 2 authorized as a PIE command (a drive command from the owner, or `editor_stop_pie` of an agent PIE) skips slot 4 (R13).
2. **Runtime singleton** `P/Private/HaybaMCPEditorState.h/.cpp`, `FHaybaMCPEditorState`, game thread only.
   - `Startup()` binds PreBeginPIE, BeginPIE, EndPIE, CancelPIE, ShutdownPIE and OnSwitchBeginPIEAndSIE with captureless lambdas that call `Get()`. If PIE is already running, it seeds the state as user / running.
   - `StartupModule` calls it after handler registration (`HaybaMCPModule.cpp:211`) and before `StartTcpServer` (`:265`), so no request can arrive before the hooks exist. `ShutdownModule` calls `Shutdown()` in the callback-revoke block.
   - `FHaybaMCPModule` gets no new member.
   - `FHaybaMCPPIEHandler`'s lazy hooks, handles and `bCancelPending` are deleted. Its wait at `:385` uses `IsPieActiveOrQueued()`.
   - Test seam: `FScopedPieOverride`, under `WITH_DEV_AUTOMATION_TESTS`.
3. **Router guard** in §4.1 slot 2, via `MakeGateRefusal`.
   - The refusal detail is `pie: {pie, phase, simulating, since_s, command, caller_owner, rule}`, and the advisory is `retryable_failure`, `preflight`, `not_started` and `retry_unchanged_safe: true`.
   - Its Warning log goes through T1's `FWarningLimiter` from Deploy A on. A user PIE during a bpgraph build (25–35 calls/s) would otherwise log thousands of `pie_active` lines per play session, the same flood class as the 35k lease warnings.
   - A queued PIE request counts as PIE.
   - The per-handler `level_*` and `save_all` checks stay, as defence in depth.
4. **`editor_start_pie`** calls `NoteAgentPieRequest(EffectiveOwner())` before `RequestPlaySession`. It returns `pie_requested: true`, `pie_owner: "agent:<owner>"` and a hint. `pie_started` is kept for compatibility.
   - **Modal preflight.** Before queueing, it scans loaded `UBlueprint`s for `Status == BS_Error` with `bDisplayCompilePIEWarning`, and for `BS_Dirty` when the editor is configured to prompt for a recompile before play (the condition `PlayLevel.cpp:1313` tests). On any match it queues nothing and refuses with the top-level code `pie_blocked`: `pie_blocked: 'editor_start_pie' was not run: <n> Blueprint(s) would open a modal dialog before play (<asset> is <status>). Compile or fix them first.` The detail lists up to 16 assets with their status. Advisory: `retryable_failure` / `not_started`.
5. **Batch hold.** The hold must neither let the batch lease lapse nor spend the fence clock.
   - In `Pump`, the PIE check comes **after** the lease keep-alive block (§3.0 preamble), so the batch lease keeps renewing through PIE.
   - The pure machine becomes pause-aware: `FInputs` gains `bHeld`. While it is set, `Tick` returns `Wait` without evaluating any phase and accumulates the held span; on the first unheld tick it shifts `FenceStartedAt` and `YieldStartedAt` forward by that span, so held time never counts against `FenceTimeoutSeconds` or the yield timeout.
   - `Pump` sets `In.bHeld = true`, `LastBusy = "pie"` while PIE is active or queued, and `BusySubsystems` reports `pie`. A running batch pauses through PIE of any length and resumes afterwards. A lease request queued behind the batch waits until PIE ends; it could not write during PIE anyway.
   - A new `editor_batch` is refused during PIE (rule `Refuse`).
   - `ValidateSteps` rejects `editor_start_pie`, `editor_stop_pie` and every `editor_pie_*` step: `PIE cannot run inside a batch; batches pause during PIE`. A batch that started PIE would pause itself before its own stop step, while renewing its lease and never yielding.
6. **`editor_get_state` shape.** A new optional param, `include_dirty` (default true), lets a host skip the package walk.
   ```text
   { ok, map, selection_count, caller_owner,
     pie: "none" | "user" | "agent:<owner>", pie_running, pie_phase, pie_since_s, pie_simulating,
     compiling (Live Coding only), shader_jobs, saving (normally false at a request boundary),
     building: [ {asset, owner, label, lane, held_s, since, expires_in_s} ],   // from T3; [] until then
     editor_unsafe, python_unhealthy, health{…},                                // from T1 (R7)
     dirty_packages?, dirty_count?, dirty_packages_skipped? }
   ```
   It never includes a lease handle, and no key ends in a secret word.
7. **TS.**
   - `pie_active` and `pie_blocked` join `UeToolErrorCode` / `KNOWN_UE_CODES`, and `TcpResponse` gains `pie?`.
   - `editor-get-state.ts` takes `{include_dirty?: boolean}`.
   - The `index.ts` descriptor text is updated in one hunk (R11).
8. **ADR-0012** covers editor-state guards: PIE is a state, not a lock; the allowlist fails closed; PIE commands authorized by the PIE state skip the lease gate (R13).
9. **Unsafe Play veto** (D2 applied to the user's Play button; not part of D7). `FHaybaPIEAuthorizer : IPIEAuthorizer` is registered in `FHaybaMCPEditorState::Startup` and unregistered in `Shutdown`. In T2 it has one branch: while `FHaybaEditorHealth::IsUnsafe()`, deny.
   - **5.8:** `IsPIEAuthorizedInternal` always allows, so the Play button is never greyed. `RequestPIEPermissionInternal` returns `MakeError(FText)` with `Hayba: the editor is unsafe after a contained native fault. Save your work and restart; Play would compile Blueprints and run garbage collection in a damaged process.` The engine then cancels the request itself (`PlayLevel.cpp:2616-2632`). Hayba never calls `CancelRequestPlaySession` from inside the authorizer: that would broadcast CancelPIE twice (T2's tracker would count two ends) and reset `PlaySessionRequest` while `StartPlayInEditorSession` still holds `InRequestParams`, a reference into it (`PlayLevel.cpp:1197`).
   - **5.7:** the override is `RequestPIEPermission(bool, FString&)`; it returns false with `OutReason`, plus Hayba's own notification.
   - There is no override press for the unsafe veto. Agent requests never reach it, because slot 1 already refused them.
   - The pure decision is `DecideUserPlay(busy, kind, mode, bUnsafe, lastVeto, now)` in `HaybaMCPEditorStatePolicy.h`; T2 implements only the `bUnsafe` branch, and T10 adds the build branch.

**Files**
- New:
  - `P/Private/HaybaMCPEditorStatePolicy.h`
  - `P/Private/HaybaMCPEditorState.h/.cpp` (including `FHaybaPIEAuthorizer`)
  - `Tests/HaybaMCPEditorStatePolicyTest.cpp`, `Tests/HaybaMCPEditorStateRouterTest.cpp`
  - `src/tools/__tests__/editor-state-policy-drift.test.ts`
  - `docs/adr/0012-editor-state-guards.md`
- Modified, C++:
  - `HaybaMCPModule.cpp`
  - `HaybaMCPCommandHandler.cpp` (guard slot)
  - `handlers/HaybaMCPEditorHandler.cpp`
  - `handlers/HaybaMCPPIEHandler.h/.cpp`
  - `handlers/HaybaMCPBatchHandler.cpp`, `HaybaMCPBatchPolicy.h` (`bHeld`, `ValidateSteps`)
  - `Tests/HaybaMCPEditorStateTest.cpp`, `Tests/HaybaMCPBatchPolicyTest.cpp`
  - `HaybaMCPToolkit.Build.cs`: Win64 `PrivateIncludePathModuleNames.Add("LiveCoding")`; the module that declares `IPIEAuthorizer` (`UnrealEd` on 5.8; checked against 5.7)
- Modified, TS:
  - `tool-executor.ts`, `tcp-client.ts`
  - `editor/editor-get-state.ts`, `editor/editor-get-state.test.ts`
  - `index.ts` (one hunk)
  - `ue-refusal-codes.test.ts`

**Tests**
- `Hayba.MCP.State.PieRule`
- `Hayba.MCP.State.PieVerdict`
- `Hayba.MCP.State.PieTracker`
- `Hayba.MCP.State.ResolvePieBackstop`
- `Hayba.MCP.State.HooksBoundAtStartup`
- `Hayba.MCP.State.PieSafeDrift`: every entry is registered or router-inline, and the test lists the registered commands that are refused by default.
- `Hayba.MCP.State.RouterRefusesMutationDuringPIE`, under a user PIE override:
  - `blueprint_add_node` gets `pie_active` / `not_started`, and an owner named "Joseh" does not flip it to suspect;
  - reads and `editor_pie_actor_list` pass;
  - `editor_start_pie` and `python_run` are refused;
  - no PIE request is queued.
- `Hayba.MCP.State.RouterPieOwnerDrive`
- `Hayba.MCP.State.RouterStopAgentPieFromAnyCaller`: `editor_start_pie` from conn 900001 with no owner, then `editor_stop_pie` from conn 900002 succeeds, while a drive command from 900002 gets `pie_active`; `editor_stop_pie` under a user PIE is refused.
- `Hayba.MCP.State.StartPieBlockedByModal`: a transient Blueprint set to `BS_Error` with `bDisplayCompilePIEWarning` makes `editor_start_pie` answer `pie_blocked`, and no PIE request is queued.
- `Hayba.MCP.State.UserPlayDecision`: the pure `DecideUserPlay` unsafe branch (deny, no override), and that the authorizer is registered after `Startup` and unregistered after `Shutdown`.
- `Hayba.MCP.State.GetStateShape`: includes the `include_dirty:false` case.
- Extended: `Hayba.MCP.Editor.GetStateNative`
- `Hayba.MCP.Batch.HoldExcludedFromFenceTimeout` (pure, injected clock): enter a fence, hold for 10 × `FenceTimeoutSeconds`, resume; the next step runs and the batch succeeds. The same for a hold during a yield.
- `Hayba.MCP.Batch.ValidateRejectsPieSteps` (pure)
- `Hayba.MCP.State.BatchHoldsDuringPIE` (latent, hard cap 10 s). **This is the first latent test in the suite**, so T2 lands the latent-test infrastructure (the `DEFINE_LATENT_AUTOMATION_COMMAND` helper with a hard cap, and the manifest rule that a latent test must report Success, not merely finish). It also asserts the batch lease's `ExpiresAt` advanced during the hold.
- `Hayba.MCP.State.RealPIE` (opt-in with `-HaybaRealPIETests`, owned child only)
- TS:
  - `editor-get-state.test.ts`: forwards `include_dirty`, passes the extended state through, and rejects a non-boolean.
  - `ue-refusal-codes.test.ts`: `pie_active` and `pie_blocked`, with no retry.
  - `editor-state-policy-drift.test.ts`: allowlist membership, a forbidden-writer check, and each handler reading the fields named in the table.

**Done when:** `RouterRefusesMutationDuringPIE`, `HooksBoundAtStartup` and `HoldExcludedFromFenceTimeout` pass headless.

---

### T3: `asset_busy` and the asset-write seam (item 06b and seam S1; D5; I-6, I-7)

**Current state**
- A lease-table query for "who holds an asset X" does not exist.
- `AssetPackageKey`, `AssetWriteCommands` and the implied `asset:<path>` claim (commit `001c0537`) exist only on `<deploy-branch>` and `feat/anim-authoring`.
- blueprint_compile, blueprint_add_function, blueprint_add_event, ui_build_tree and ui_set_variable are classified Read.

**Design**
1. **Seam S1.** Re-add three pieces from `001c0537`: `AssetPackageKey` (lower-cased package key; strips `.Name` and `_C`), `AssetWriteCommands()` and the implied X claim in `CheckCommand`.
   - This branch gets **blueprint and UI rows only**:
     - blueprint rows key on `path`: blueprint_add_node, blueprint_connect_nodes, blueprint_set_pin_default, blueprint_add_variable, blueprint_add_function, blueprint_add_event, blueprint_compile;
     - UI rows key on `widget_blueprint_path`: ui_build_tree, ui_mutate_tree, ui_set_variable, ui_set_widget_properties, ui_add_element, ui_bind_property, ui_compile_widget, ui_save_widget.
   - `blueprint_remove_node` is **not** a row here: it is not registered on `fix/p0-safety` (`FHaybaMCPBlueprintHandler::GetCommands`, `HaybaMCPBlueprintHandler.cpp:75-91`, has no entry), so both drift checks would fail. It exists only on branches this one does not contain (`63f4c619` / `f389950f`, on `<deploy-branch>`, `feat/anim-authoring` and `bc`), and is added back as a merge fixup (§7.3).
   - The exact rows are pinned by `Hayba.MCP.Lease.ClassificationDrift`, and every row must name a field its handler reads.
   - The anim rows arrive by merge on the deploy branch (§7.3).
2. **`FTable::FindAssetHolders(ExcludeOwner, AssetKey = {})`** (`HaybaMCPLeasePolicy.h`). It is inline and non-virtual, calls `Expire()` first, and matches locks with `Mode == Exclusive` whose key starts with `asset:`. An empty `ExcludeOwner` excludes nobody.
3. **Policy tables** in `HaybaMCPEditorStatePolicy.h`:
   - `AssetBusyTargets()`:
     - `blueprint_compile`, `anim_blueprint_compile`, `bt_compile` and `audio_asset_save`: `path`;
     - `ui_compile_widget` and `ui_save_widget`: `widget_blueprint_path`;
     - `material_compile`: `material_path` or `function_path`.
   - `AnyBusyCommands()`: `editor_start_pie`, `editor_save_all_and_quit`.
4. **Guard** in §4.1 slot 3. Enforcement mode refers to `LeaseEnforcement`.
   - **AnyBusyCommands:** refuse when **any** owner, the caller included, holds an asset X lock (`FindAssetHolders({})`). This applies in every mode except Off. It is safe before T4 because it fires only on a deliberate asset lease. The caller is not excluded because §5.2 puts all of a lane's helpers under one owner: excluding it would let a lane's own agent start PIE while that lane's bpgraph is mid-build, which is I-6 within one lane. A tool that holds build leases releases them before it starts PIE.
   - **AssetBusyTargets:** refuse when another owner holds X on that asset, under `EnforcedForWrites` (after T8) or `Enforced`. Here the caller is excluded, because a build compiles its own assets.
   - The Warning log of each refusal goes through T1's `FWarningLimiter`.
     - Under Advisory the command runs, and the reply carries `state_warning {code: "asset_busy", …}`.
     - The warning travels through a new `FHaybaMCPRequestContext::StateWarning` field, merged like `lease_warning`.
   - Refusal detail: `busy: {command, caller_owner, assets:[{asset, owner, label, lane, held_s, since, expires_in_s}]}`. It never includes a handle.
   - Message: `asset_busy: '<cmd>' is refused: <asset> is being built by '<owner>' (label <label>, held <n> s, lease expires in <m> s). PIE/compile would use it half-built. Nothing ran; try again when editor_get_state.building no longer lists it.`
   - Advisory: `retryable_failure`, `not_started`.
5. `editor_get_state.building` lists every `asset:` X lock, whatever its label.
6. **TS:** `asset_busy` joins `KNOWN_UE_CODES`. `state_warning` is surfaced like `lease_warning` (`tool-executor.ts:297-302`). `TcpResponse` gains `busy?` and `state_warning?`.

**Files**
- `HaybaMCPAccessPolicy.h` (S1)
- `HaybaMCPLeasePolicy.h`
- `HaybaMCPLeaseManager.h/.cpp` (context field, implied claim)
- `HaybaMCPEditorStatePolicy.h`, `HaybaMCPEditorState.cpp`
- `HaybaMCPCommandHandler.cpp` (guard slot, `state_warning` merge at `:1226-1233`)
- `Tests/HaybaMCPLeasePolicyTest.cpp`, `Tests/HaybaMCPEditorStateRouterTest.cpp`
- TS: `tool-executor.ts`, `tcp-client.ts`, `ue-refusal-codes.test.ts`
- `src/tools/__tests__/access-policy-drift.test.ts` (the S1 rows)

**Tests**
- `Hayba.MCP.State.AssetBusyTargets`
- `Hayba.MCP.Lease.AssetHolders`
- `Hayba.MCP.State.RouterAssetBusyStartPie`: a builder holds `asset:/Game/Test/BP_Busy` X; `editor_start_pie` from `lane5` gets `asset_busy`, `busy.assets[0].owner == "builder"`, and no PIE request is queued. The same `editor_start_pie` sent as owner `builder` is also refused.
- `Hayba.MCP.State.RouterAssetBusyCompile`: refused under Enforced; `state_warning` under Advisory.
- `Hayba.MCP.Lease.ClassificationDrift`, extended with the S1 rows.
- TS: `ue-refusal-codes.test.ts` covers `asset_busy`, keeping `busy`, and `state_warning` passthrough.

**Done when:** `RouterAssetBusyStartPie` passes. That is the automated form of the I-6 PIE-on-a-half-built-Blueprint scenario for an **agent** PIE; it moves M6a only once builds actually hold asset leases (the §5.1 bpgraph step). The user's Play button is T10 (M6b).

---

### T4: `lease_id` (item 01; postmortem P0-1; I-5)

**Current state**
- Every output names the handle `token`:
  - `lease_acquire` (`handlers/HaybaMCPLeaseHandler.cpp:129`);
  - `lease_renew` / `lease_release` params and echoes (`:159-192`);
  - `lease_status` (`:211-215`);
  - the lease-gate diagnostic key `lease_token` (`HaybaMCPLeaseManager.cpp:248`).
- Both redaction layers erase it:
  - C++ `RedactFinalEnvelope` (`HaybaMCPSecretRedaction.cpp:843-871`, key compound `token` `:160`);
  - Node `redactMcpResult`, whose `ASSIGNMENT` text rule (`security/secret-redaction.ts:164-165`) also redacts `"token": "v"` in pretty-printed JSON.
- Handles have the form `lease-<salt>-<seq>`, with one salt per editor session, so any holder can enumerate the others. Through `EffectiveOwner` (`HaybaMCPLeaseManager.cpp:139-154`), holding a handle means acting as its owner.
- Consumers:
  - Node `lease-tools.ts:117-118` read `data.token`, so the keeper tracked the literal marker.
  - The consumer's `editor_gate.py` stores the marker in `lock.json`.

**Design**
1. **Rename, don't allowlist.** The redaction code in both languages is unchanged. A new protocol rule is written into ADR-0010 and pinned by tests:
   - no lease or batch protocol key may end in a secret word (token, secret, password, passwd, pwd, credential, cookie, authorization, or a `*key` compound);
   - lease and ticket ids use only `[a-z0-9_]`;
   - no hint or `next` text contains `token:` or `token=`.
2. **Id format.** Leases are `ls_<seq>_<mac12>` and tickets are `lq_<seq>_<mac12>`.
   - `mac12` is the first 12 lowercase hex characters of `FSHA1::HMACBuffer(key = session salt, "<prefix>:<seq>")`.
   - The salt becomes the full 32-hex GUID and never appears in an id.
   - An empty salt (pure tests) gives `ls_<seq>`.
   - Old-format ids need no compatibility: the lease table lives in memory, and the deploy restarts the editor.
3. **Why the format is redaction-proof.**
   - Keys: `lease_id` ends in `id`, a measurement head in both layers, so the key check returns early. `lease_id_error` ends in `error`, also a head. `ticket`, `renewing_lease_ids` and `deprecation` contain no secret compound.
   - Values: every value regex in both layers needs a character outside `{l,s,q,_,0-9,a-f}`.
   - Checked empirically: 20,000 random ids passed through the compiled Node redactor with 0 changes.
4. **Wire after T4** (the full contract is in §4.3):
   - `lease_acquire` granted: `{status:"granted", lease_id, owner, lane, expires_in_s, bound_to_connection, resources, next}`. No `token`, ever (R1).
   - `lease_renew {lease_id, ttl_s?}` → `{lease_id, renewed:true, expires_in_s}`.
   - `lease_release {lease_id}` or `{ticket}` → `{lease_id | ticket, released:true}`.
   - `lease_status`: `leases[].lease_id`, shown only to their owner.
   - `editor_batch`: takes `lease_id` (preferred) or `lease`, which is permanent because it is not secret-shaped, else the envelope `lease`. Different values for the two give `[lease_id_ambiguous]`.
   - The envelope field stays `lease`, and its value is a `lease_id`.
   - `ping`: `capabilities.lease_id = true`, the host handshake.
   - Lease-gate detail: `lease_id_error` is `"unknown_or_expired"` or `"redaction_marker"`. The messages are `… the envelope's lease_id is unknown or expired` and `… the envelope's lease is a redaction marker, not a lease_id; run lease_acquire again and send the lease_id it returns`.
5. **Handler codes** (bracket channel, R3):
   - `[lease_id_required]`
   - `[lease_id_ambiguous]`
   - `[lease_id_redacted]` (a canonical param that holds a marker, R5)
   - `[lease_id_unknown]`

   The substrings `belongs to` and `ticket` stay verbatim, because `editor_gate.py:258,303` matches on them.
6. **Deprecated alias.** `token` is accepted on `lease_renew` / `lease_release`.
   - The reply gains a `deprecation` string.
   - `NoteDeprecatedParam` logs one Warning per (command, param, owner) per session: `lease_renew: deprecated param 'token' from owner 'X'; send lease_id`. This line is the removal metric (§4.4).
7. **C++ pure helpers** in `HaybaMCPLeasePolicy.h`: `IsRedactionMarker`, `EIdParam`, `FIdParam`, and `ResolveIdParam(canonical, alias)`.
   - The canonical value wins, and the alias fills an empty canonical.
   - Two different non-empty values give `Ambiguous`, and a marker gives `RedactionMarker`.
   - An optional second commit renames the internal `Token` fields to `Id`. It is layout-neutral.
8. **Node.**
   - `lease-keeper.ts` is keyed by lease id. `track()` refuses unusable ids, `isUsableLeaseId` tests `^ls_[a-z0-9_]+$`, and renews send `{lease_id, ttl_s}`.
   - `lease-tools.ts` uses strict shapes with `superRefine` and the same messages as C++. It never sends `token` to the editor.
   - `handleLeaseAcquire` tracks `data.lease_id` only when it is usable. Otherwise it returns `lease_id_error`, which happens when the plugin predates this fix.
   - `lease_status` reports `renewing_lease_ids`.
   - `batch-tools.ts` accepts `lease_id` and `lease`.
   - `tcp-client.ts` seeds the envelope lease only from `HAYBA_LEASE_ID` (R9). It stops reading `HAYBA_LEASE` and `HAYBA_LEASE_TOKEN` (today `tcp-client.ts:84`), and clears an env-seeded lease that the editor reports as `lease_unknown`.

**Files**
- C++:
  - `HaybaMCPLeasePolicy.h`
  - `HaybaMCPLeaseManager.h/.cpp`
  - `handlers/HaybaMCPLeaseHandler.cpp`
  - `handlers/HaybaMCPBatchHandler.cpp`
  - `handlers/HaybaMCPLegacyHandler.cpp` (caps)
  - `HaybaMCPCommandHandler.cpp` (comments only)
  - new `Tests/HaybaMCPLeaseIdTest.cpp`
- Node:
  - `lease-keeper.ts`, `tools/lease/lease-tools.ts`, `tools/batch/batch-tools.ts`, `tcp-client.ts`
  - their tests, plus new `tools/lease/lease-wire.test.ts`
  - optional new `security/native-redaction-parity-contract.test.ts`
- Docs:
  - ADR-0010: a "Lease ids" section and line 42
  - `CONTEXT.md` glossary
  - `CHANGELOG.md`
  - `<host-kit>/*` (§5); `<host-kit>` is the consumer project's host-tools folder, which holds `editor_gate.py` and `bpgraph.mjs`
- Deliberately unchanged: both redaction modules, `Public/IHaybaMCPHandler.h`, `tool-executor.ts`, `index.ts`.

**Tests**
- `Hayba.MCP.Lease.IdFormat`
- `Hayba.MCP.Lease.IdParam`
- `Hayba.MCP.Lease.IdSurvivesRedaction`:
  - covers every C++ shape the lease code emits, for 256 salts × 4 seqs;
  - passes each through `RedactFinalEnvelope` and checks the ids come back byte-identical with no redaction `_meta`;
  - negative control: `{"token": id}` is still redacted.
- `Hayba.MCP.Lease.WireRoundTrip`, through `ProcessCommand`: `ping` shows `caps.lease_id`; acquire, renew by `lease_id`, renew by `token` (with `deprecation`), ambiguous, redacted marker, status, the gate detail `lease_id_error: "redaction_marker"`, release, and a second release giving `[lease_id_unknown]`.
- `Hayba.MCP.Batch.WireRoundTrip`: latent (using T2's latent-test infrastructure), hard cap 10 s. `editor_batch {lease_id, steps:[ping]}` reaches `succeeded`, the exact call refused at 01:25:52 in I-5.
- TS:
  - `lease-keeper.test.ts`, with a `nativeRedaction` fake; the I-5 regression is that a `{token}` reply becomes `lease_id_error` and is never tracked;
  - `lease-wire.test.ts`, which mocks `tcp-client` so the Tool Stream mirror never dials 52342;
  - `tcp-client.test.ts`: `HAYBA_LEASE` and `HAYBA_LEASE_TOKEN` are ignored with one `console.error`; `HAYBA_LEASE_ID` is sent; a reply with `lease.reason: "lease_unknown"` for it clears the lease, logs once, and the next envelope has no `lease`;
  - `batch-tools.test.ts`;
  - `secret-redaction.test.ts` ("lease protocol keys are not secret-shaped").
- Python host kit: `pytest <host-kit>/tests` (§5).

**Done when:** `Hayba.MCP.Batch.WireRoundTrip` passes headless, and the host kit's tests pass against a fake that returns only `lease_id`.

---

### T5: Save sites (item 05; postmortem P0-4; I-3)

**Current state**
- **The crash mechanism.** `UPackage::SavePackage` with the default `FSavePackageArgs::Error = GError` and no `SAVE_NoError` calls `appError` on a read-only target (UE 5.8 `SavePackage2.cpp:3453-3466`). The SEH guard catches it mid-save, and the next frame dies in `StaticFindObjectFast` (I-3). All 18 `GetError()` calls are gated by `IsGenerateSaveError`, so `SAVE_NoError` alone removes the `appError`.
- **Three raw `GError` sites:**
  - `blueprint_compile` (`handlers/HaybaMCPBlueprintHandler.cpp:1003-1004`, `save` defaults to true);
  - `metasound_compile` (`HaybaMCPMetaSound/.../HaybaMCPMetaSoundHandler.cpp:571`);
  - `create_graph` (`handlers/HaybaMCPLegacyHandler.cpp:948-950`). This one first renames an existing same-name graph into the transient package.
- **Already `SAVE_NoError` but with no preflight:**
  - `HaybaSaveVerify::SaveAndVerify` (`Public/HaybaMCPSaveVerify.h:53-99`). Its Note gap produces the contradictory "Written to disk, but … still dirty" next to `saved:false` (9 in the transcripts).
  - `HaybaPersistAsset` (`handlers/HaybaMCPMaterialHandler.cpp:154-174`).
- **Engine-routed saves fail softly, except map saves.** On a read-only map `SaveWorld`'s read-only branch calls `FMessageDialog::Open` (UE 5.8 `FileHelpers.cpp:1048-1050`), a **modal dialog on the game thread**, because Hayba never sets `GIsRunningUnattendedScript`. Slate's modal loop does not tick `FTSTicker` (`SlateApplication.cpp:2238-2253`), and Hayba's command drain and every batch pump are `FTSTicker`s, so every lane stalls until a human clicks OK. Two routes reach it:
  - native `level_save`;
  - `python_run`, which runs without `EPythonCommandFlags::Unattended` (`handlers/HaybaMCPPythonHandler.cpp:2170-2179` sets no flags): `save_current_level`, `EditorLoadingAndSavingUtils.save_map` (the host's scripted load-save-unload pattern) and `save_packages` on a map. Python is where agents actually save (84 % of MCP calls; I-8 saved 40 World Partition packages from Python), and `python_run` is `NON_IDEMPOTENT`, so clients do not retry.
- A handler `Err()` drops `data`. Structured refusals follow the `AssetImportPreflightFailure` precedent (`AssetHandler.cpp:851-887`).
- `blueprint_compile`'s sidecar entry declares only `path` under a strict schema, so **MCP agents cannot pass `save:false`**.

**Design**
- **Task A: the crash fix** (it can ship on its own).
  1. **Helper** in `Public/HaybaMCPSaveVerify.h`, namespace `HaybaSaveVerify`, header-only:
     - `PackageReadOnlyCode = "package_read_only"`, a wire contract that is never renamed.
     - `FindReadOnlyPackageFiles(LongName | UPackage*)`:
       - resolves the file (`.umap` or `.uasset`) plus the `.uexp`, `.ubulk`, `.uptnl` and `.m.ubulk` siblings;
       - checks `IFileManager::IsReadOnly`, which is false for a nonexistent file;
       - returns absolute paths.
     - `MakeWritableHint(files, noSaveAlternative)`. It stays at or under 480 chars, to survive the 512-char trim. It names the file relative to the project and says to take the lock (`git lfs lock "<rel>"` or a Perforce checkout) or to clear the flag deliberately, then retry. It states that Hayba never clears read-only flags, and appends the no-save alternative.
     - `ReadOnlyRefusal(cmd, pkg, files, alt)` → `Ok(Data{ok:false, code:"package_read_only", error:"<cmd> [package_read_only]: <pkg> cannot be saved: <file> is read-only on disk. Nothing was changed. <hint>", phase:"preflight", mutation_status:"not_started", failure_kind:"policy_blocked", package, read_only_files, make_writable_hint, save_attempted:false, saved:false})`.
     - `RefuseIfReadOnly(cmd, pkg, OutRefusal, alt)`.
     - `Detail::SavePackageNoError(Pkg, Asset, File)`: **the only raw `UPackage::SavePackage` in the tree.** It always uses `SAVE_NoError` and `RF_Public|RF_Standalone`.
     - `SaveAndVerify`:
       - runs the preflight first; on a read-only file it sets `bRefusedReadOnly` and `ReadOnlyFiles` and does not save;
       - otherwise it calls `Detail::SavePackageNoError`;
       - it gains a Note branch, placed before the `bStillDirty` branch, for a failed call where the file is unchanged: `SavePackage failed and the file on disk was not changed. NOT persisted; see LogSavePackage.`;
       - `Describe()` adds `save_error_code`, `read_only_files` and `make_writable_hint`.
  2. **`blueprint_compile`:**
     - When `save`, preflight before `CompileBlueprint` (`:956`), with the alternative "Or pass save:false to compile without saving.";
     - the save becomes `SaveAndVerify`, adding `save_error` / `save_error_code` on failure;
     - `blueprint_create` is routed through `SaveAndVerify` too, with no behaviour change.
  3. **`metasound_compile`:**
     - preflight before `AttachBuilder` (`:506`);
     - the save becomes `SaveAndVerify`;
     - a failed save returns `Ok(Data{ok:false, valid:true, saved:false, save_error, mutation_status:"applied_unsaved"})`, not `Err`, because the asset was already conformed in memory.
  4. **`create_graph`:**
     - preflight on `FullPath` before `CreatePackage` (`:639`), which also prevents the displacement at `:654-658`;
     - the save becomes `SaveAndVerify`, adding `save_error`.
  5. **`HaybaPersistAsset`** becomes `SaveAndVerify`. On refusal, `OutError = "[package_read_only] " + Note`.
- **Task B: refuse before mutation on the remaining native paths.** Each preflight must come strictly before the first mutation, because the advisory turns `policy_blocked` plus an observed mutation into `session_suspect`.
  - `ui_save_widget`: before `ReconcileWidgetVariableGuids`.
  - `ui_compile_widget`: read `save_on_success` before compiling; when it is true, preflight first.
  - `material_set_param`: before the first `MIC->Modify()`.
  - `material_compile`: before `UpdateMaterialFunction` and before `RecompileMaterial`.
  - `audio_asset_save`: before `SaveLoadedAsset`.
  - `level_save`: preflight the map package plus every dirty external package, before the sanitizer. Then wrap `SaveCurrentLevel` in `TGuardValue<bool>(GIsRunningUnattendedScript, true)` so **no modal can block the game thread**.
  - `editor_save_all_and_quit`: check every `CollectSaveableDirtyPackageNames()` entry. Any read-only file means nothing is saved and no exit ticker is added.
  - **`python_run` runs unattended.** Set `RunCmd.Flags |= EPythonCommandFlags::Unattended` on the user script and on the readback commands. PythonScriptPlugin then sets `GIsRunningUnattendedScript` for the command (`PythonScriptPlugin.cpp:1843`, `:1935`), and `FMessageDialog` returns its default instead of opening a modal. A Python map save on a read-only map then fails softly and returns `False`. A side effect is intended: a script that deliberately shows an editor dialog gets the dialog's default answer.
  - Unchanged by design: create-only paths (their targets cannot pre-exist). Per-path `read_only` reasons for failed Python saves stay in item 07.
- **Wire.**
  - `IsWireRefusalCode` is created with `{package_read_only}` (§3.0).
  - Advisory `PolicyBlocked` + `package_read_only` gets the next action "Make the package file writable (take its source-control lock), then retry; see data.make_writable_hint. Retrying unchanged will fail again." It is added to `MandatoryRecovery`, so it survives ErrorsOnly.
  - TS: `package_read_only` joins `KNOWN_UE_CODES`.
  - `sidecar.json`:
    - `blueprint_compile` gains an optional boolean `save` ("Defaults true. Pass false to compile without saving, e.g. for a read-only package") and the returns `saved` and `save_error`. **This is part of the fix, not optional.**
    - The notes of `blueprint_compile`, `metasound_compile`, `create_graph`, `ui_save_widget`, `level_save`, `audio_asset_save` and `editor_save_all_and_quit` mention `package_read_only`.
  - Run `npm run build:server` and restart the MCP server, or the stale `dist/` hides the new param.

**Files**
- `Public/HaybaMCPSaveVerify.h`
- The handlers: Blueprint, Legacy (`Cmd_CreateGraph`), Material, UI, Audio, Level, Editor and Python (the `Unattended` flag)
- `HaybaMCPCommandHandler.cpp` (`ShapeOkResponse`, `IsWireRefusalCode`)
- `HaybaMCPAdvisory.cpp`
- New `Tests/HaybaMCPSaveReadOnlyTest.cpp`
- `HaybaMCPMetaSound/.../HaybaMCPMetaSoundHandler.cpp` and its test
- TS:
  - `tool-executor.ts` (codes only)
  - `legacy-commands/sidecar.json`
  - new `tools/save-site-contract.test.ts` and `tools/package-read-only.test.ts`

**Tests**
- New translation unit. These run as an OwnedChild by default; do **not** add them to the InProcess allowlist. The RAII fixture `FScopedReadOnlyPackage` always clears the flag and deletes the asset.
  - `Hayba.MCP.Save.ReadOnly.FindReadOnlyPackageFiles`
  - `Hayba.MCP.Save.ReadOnly.SaveAndVerifyRefusesWithoutSaving`
  - `Hayba.MCP.Save.ReadOnly.NoErrorSaveSurvivesMissedPreflight`: the direct `Detail::SavePackageNoError` call returns false, `GIsCriticalError` stays false, and a later `StaticFindObject` succeeds (I-3's next-frame fatal).
  - `Hayba.MCP.Save.ReadOnly.BlueprintCompileRefusesBeforeCompiling`: `BS_Dirty` is kept and `save:false` still compiles.
  - `Hayba.MCP.Save.ReadOnly.WidgetSaveAndCompileRefuse`
  - `Hayba.MCP.Save.ReadOnly.CreateGraphKeepsExistingGraph`
  - `Hayba.MCP.Save.ReadOnly.MaterialRefusesBeforeEdit`
  - `Hayba.MCP.Save.ReadOnly.AudioAndSaveAllRefuse`
  - `Hayba.MCP.Save.ReadOnly.LevelSaveRefusesWithoutModal`: a hang trips the child's timeout.
  - `Hayba.MCP.Save.ReadOnly.PythonMapSaveReturnsWithoutModal`: `python_run` with `unreal.EditorLevelLibrary.save_current_level()` on a read-only map returns within its deadline with the script's `False`; a hang trips the child's timeout.
  - `Hayba.MCP.Save.ReadOnly.EnvelopeCarriesCodeAndHint`
  - `Hayba.MCP.MetaSound.Compile.ReadOnlyRefusesBeforeConform`, in `HaybaMCPMetaSoundHandlerTest.cpp`
- Only test #3 declares `AddExpectedError("as it is read only")`. Every other test proves that `SavePackage` was never reached, because an unexpected Error log fails it.
- TS `save-site-contract.test.ts` (fails closed):
  - it scans at least 150 files and finds exactly 1 raw `SavePackage`, which uses `SAVE_NoError`;
  - `RefuseIfReadOnly(TEXT("<cmd>")` precedes each command's first mutation, and there are at least 11 of them;
  - exact per-file counts of the engine save helpers;
  - `level_save`'s unattended guard precedes `SaveCurrentLevel()`;
  - in `HaybaMCPPythonHandler.cpp`, `EPythonCommandFlags::Unattended` is set on every `FPythonCommandEx` before the guarded Python exec (`RunGuardedAt(EHaybaFaultSite::Python`, after T1).
- TS `package-read-only.test.ts`: the code mapping, the hint kept, the legacy error text containing `[package_read_only]` and `git lfs lock`, and the sidecar `save` param.

**Done when:** the save-site contract finds exactly one raw save, and `NoErrorSaveSurvivesMissedPreflight` passes.

---

### T6: Enforcement policy, owner in the log, warning rate limit (item 03 commits c1 and c2)

**Current state**
- `CheckCommand` (`HaybaMCPLeaseManager.cpp:175-269`) logs `[advisory] …` once per command with no throttle. That produced 35,385 lines in 2 h 45 min.
- The `Processing command: %s (id: %s)` line (`HaybaMCPCommandHandler.cpp:1292`) has no owner.
- `ResolveOwner` keeps control characters and does not report whether the owner came from the envelope.

**Design**
1. **New pure header** `P/Private/HaybaMCPEnforcementPolicy.h`, namespace `HaybaMCPEnforcement`. It depends only on `HaybaMCPAccessPolicy.h` and uses an injected clock.
   - Types: `EMode {Off, Advisory, EnforcedForWrites, Enforced}` with `LexMode()`; `EHandle {None, Valid, Unknown}`; `EReason {None, Held, LeaseUnknown, OwnerMissing}`; `EVerdict`; `FFacts`; `FDecision`.
   - `Decide(facts)`:
     - A write is any class other than Read.
     - The caller is identified when the owner came from the envelope, or the handle is valid, or the call is in-process.
     - Precedence: OwnerMissing (an unidentified write while other owners are active), then LeaseUnknown, then Held.

       | Mode | Read | Write |
       |---|---|---|
       | Off | allow | allow |
       | Advisory | warn on any reason | warn on any reason |
       | EnforcedForWrites | warn on a dead handle; never refuse | refuse on any reason |
       | Enforced | refuse on a dead handle (today's behaviour) | refuse on any reason |
   - `SanitizeOwner`: trim, replace control characters with `?`, cap at 128.
   - `FWarningLimiter` is reused from T1's `HaybaMCPWarningLimiter.h` (§3.0), not redefined.
   - `FOwnerPresence`: an owner is active while it has an open connection or was seen within the last 60 s; at most 256 owners. The router records presence through one seam, `FHaybaMCPLeaseManager::NoteAuthenticatedCaller(Owner, ConnId, bIdentified)`; T8 fills in who counts as identified.
2. **In c2, change only what reduces volume.**
   - `ResolveOwner(Envelope, ConnId, bool* bOutFromEnvelope = nullptr)` sanitizes the owner. The new parameter is defaulted, so existing callers (`HaybaMCPCommandHandler.cpp:1201`, `:1215`, and the `Lease.Envelope` test) compile unchanged.
   - The log line becomes `Processing command: <cmd> (id: <id>, owner: <owner>, via: envelope|lease|conn|local, conn: <n>, lease: none|valid|unknown|redacted[, batch: <job8>])`. The prefix is unchanged, so `audit-crash-threat-model.mjs:60` and existing greps still match. The handle itself is never logged.
   - Every `LogHaybaMCPLease` warning goes through the limiter:
     - the first hit per key per 30 s is logged;
     - the next window's first line appends `(+N identical in the previous 30 s)`;
     - a closed window is drained as `[<mode>] <code>/<reason> repeated N more times in 30 s: owner='conn:*' cmd='…' holder='…' conflict='…'`.
     - The `[advisory]` prefix is kept.
   - Responses are unchanged: every response still carries its own `lease_warning`, now with `repeats_in_window`.
   - The same limiter already throttles the unsafe, `pie_active` and `asset_busy` refusal logs from Deploy A (T1–T3).

**Files**
- New:
  - `P/Private/HaybaMCPEnforcementPolicy.h`
  - `Tests/HaybaMCPLeaseEnforcementTest.cpp` (the pure cases now; the router case in T8)
- Modified:
  - `HaybaMCPLeaseManager.h/.cpp` (limiter and presence members, `ResolveOwner`)
  - `HaybaMCPCommandHandler.cpp` (log line)
  - `Tests/HaybaMCPLeasePolicyTest.cpp` (`Envelope` extended)

**Tests**
- `Hayba.MCP.Lease.EnforcementDecision` (the full mode × class × reason table)
- Extended `Hayba.MCP.Lease.WarningLimiter` (it lands in T1 with the header; T6 adds the lease-key cases)
- `Hayba.MCP.Lease.OwnerPresence`
- `Hayba.MCP.Lease.ProcessingLogOwner`: 50 identical advisory conflicts give 1 Warning line.
- Extended `Hayba.MCP.Lease.Envelope`
- TS `src/tools/__tests__/lease-enforcement-contract.test.ts`: the log line carries owner, via, conn and lease. The default-mode assertion is added in T8.

---

### T7: Lease lifetime (item 02a)

**Current state**
- Renewal requires the handle, and the TTL is capped at 900 s. Nothing renews on use.
- Re-acquiring identical claims grants a *second* lease, which leaves ghost leases behind.
- `bind_connection` defaults to true in Node, and the server closes any connection idle for 5 s (`HaybaMCPFrameReadPolicy.h:35-57`). A Node-acquired lease is therefore **deleted about 5 s after the agent goes quiet**, before the keeper's first renew at 40 s. This was found by reading the code; confirm it once live on the dev editor before tuning the grace.
- On a TCP server restart the close queue is discarded, so bound leases live on until their TTL.

**Design** (loosening only; safe for the first hotfix)
1. **Table changes** in `HaybaMCPLeasePolicy.h`. Every entry point calls `Expire()` first.
   - `FTuning.OrphanGraceSeconds = 60`.
   - `FLease` gains `bBindConnection`, `TtlSeconds` and `OrphanedAt` (0 when not orphaned); `FAcquireResult` gains `bReused`.
   - `CapExpiry`: the fence cap is `GrantedAt + FenceGrantMaxSeconds`; an orphaned lease is capped at **`OrphanedAt + 60`**, never `Now + 60`, so nothing can keep sliding an orphan forward.
   - **Idempotent acquire.** A lease is reused only when **owner, claim set (order ignored; shared and exclusive differ), label and binding (the bind flag and, when bound, the ConnId) all match**. The existing lease is refreshed and the reply gives the same `lease_id` with `reused:true`. Anything else gets a new lease. Matching on claims alone would merge distinct holders under one owner (§5.2): the gate's global X lease (`bind_connection:false`, label `editor_gate:<owner>`) and the lane's MCP `lease_acquire` of global would share one id, so either release would drop the other, and two bpgraph runs of one lane would share one asset lease, so the first run's release would remove the second's `asset_busy` protection mid-build (I-6).
   - `Renew(Token, Owner, Ttl, OutExpires, OutError, int32 ConnId = 0)`. The new parameter is defaulted, so existing callers (`HaybaMCPBatchHandler.cpp:593`, `HaybaMCPLeasePolicyTest.cpp:224-229`, `HaybaMCPBatchPolicyTest.cpp:453`, `:479`) compile unchanged. **ConnId 0 means "leave the binding unchanged"**, so the batch keep-alive never re-binds a bound lease to 0.
   - **Un-orphaning.** Only an explicit act by the lease's owner revives an orphaned lease: `Renew`, `RenewOwner` or `lease_adopt` (T9). With a non-zero ConnId the lease clears `OrphanedAt` and re-binds to that connection. With ConnId 0 (in-process, e.g. the batch keep-alive) it clears `OrphanedAt` and becomes unbound, since its connection is gone, and then lives by its TTL.
   - `RenewOwner(owner, ttl, conn)` and `ReleaseOwner(owner)` renew or release every lease of the owner; `ReleaseOwner` also withdraws its tickets.
   - `Touch(owner, lockSet, now)` implements renew-on-use: it slides `ExpiresAt` to at least `Now + TtlSeconds` and never shortens it. It touches only leases that are **not orphaned** and that hold a lock the command requires or that its declared `resources` name. It never touches an orphaned lease.
   - `OnConnectionClosed(conn)` replaces `ReleaseConnection`. Bound leases are **orphaned** (`OrphanedAt = Now`, 60 s grace), not deleted; the connection's waiters are dropped as today.
   - `OrphanAllBound()` runs on a TCP server restart, called from `StartTcpServer`.
2. **Router.**
   - Presence: `NoteAuthenticatedCaller` (T6) runs immediately after auth in every mode (§4.1), so even a refused command proves the owner is present for `owner_required`. Presence never extends a lease.
   - Touch: `TouchOnUse` runs just before dispatch, and only for a command whose class is not Read and that passed every gate (slots 0–4 and the Plan gate). Routine traffic (`ping`, `ui_tool_stream` mirroring every MCP tool call, `editor_get_state` polling such as bpgraph's PIE wait) and refused commands never touch. Otherwise a lane's MCP server under the gate owner (§5.2) would keep alive any lease that owner forgot (a lane that never released, a killed bpgraph, an old gate that hit `KeyError`), and under `EnforcedForWrites` and `AnyBusyCommands` that would refuse other owners' writes and every `editor_start_pie` indefinitely.
3. **Protocol** (T4 names):
   - `lease_acquire` granted adds `reused`, `ttl_s`, `max_ttl_s: 900`, `orphan_grace_s: 60` and `bind_connection`.
   - `lease_renew {}` (no id) renews every lease of the caller: `{owner, renewed:N, expires_in_s:<min>, leases:[{lease_id, resources, expires_in_s, orphaned}]}`. N = 0 gives `[no_leases]` (R6).
   - `lease_release {all:true}` gives `{owner, released:N, tickets_withdrawn:M}`. Sending both an id and `all`, or neither, gives `[bad_request]`.
   - `lease_status` shows `orphaned`, `bind_connection` and `ttl_s` per lease, plus top-level `max_ttl_s` and `orphan_grace_s`.
   - An owner mismatch keeps the text `lease belongs to <o>` under `[lease_owner_mismatch]`.
4. **Marker shim (R5)**, removed together with the `token` alias (§4.4):
   - `lease_renew {token:"[REDACTED:…]"}` renews by owner (it only loosens, so it stays broad);
   - `lease_release {token:"[REDACTED:…]"}` releases only the owner's leases that carry the legacy gate label `editor_gate:<owner>` (`editor_gate.py:254`) and are not yieldable batch leases. If there are none, it answers `[lease_id_redacted] a redacted marker cannot name a lease; send lease_id, or all:true to release every lease you hold`. A broader release on a degenerate input would drop a running `editor_batch`'s lease (the batch fails at its next fence and unloads its regions) and bpgraph's asset leases mid-build. Marker sources survive Deploy B: other owners' legacy `holders` entries in `lock.json` (`mirror_grant` prunes only expired ones), ruling R49, and memory notes that teach "release with the token from lock.json";
   - an envelope `lease` holding a marker counts as absent and warns once with reason `lease_handle_redacted`;
   - each use is counted in the log.
5. **Node.**
   - The keeper's cadence is `max(1 s, min(ttl/3, grace/3))`, which is 20 s at the defaults.
   - `leaseRenewShape {lease_id?, token?, ttl_s?}` accepts none of them, meaning renew by owner.
   - `leaseReleaseShape` takes exactly one of `lease_id` (or `token`), `ticket` or `all`.
   - `batch-tools.ts` wording uses `lease_id`.

**Files**
- `HaybaMCPLeasePolicy.h`
- `HaybaMCPLeaseManager.h/.cpp`
- `handlers/HaybaMCPLeaseHandler.cpp`
- `HaybaMCPModule.cpp:418`
- `HaybaMCPCommandHandler.cpp` (`TouchOnUse` before dispatch)
- `Tests/HaybaMCPLeasePolicyTest.cpp`, new `Tests/HaybaMCPLeaseBindingTest.cpp`
- Node: `lease-keeper.ts`, `lease-tools.ts`, `batch-tools.ts` and their tests; `plan-mode-gate.test.ts`
- ADR-0010 amendments to `:95-98` and `:200-201`: a batch now survives its client's socket closing, bounded by its step list.

**Tests**
- Updated `Hayba.MCP.Lease.Table`: same id on an identical re-acquire; a bound lease is orphaned, then lapses 60 s after `OrphanedAt` even while its owner keeps sending commands.
- `Hayba.MCP.Lease.IdempotentAcquire`: a gate-style acquire (unbound, label `editor_gate:o`) and an MCP-style acquire (bound, no label) of global X by the same owner get distinct `lease_id`s, and releasing one leaves the other; two bound acquires on different connections get distinct ids.
- `Hayba.MCP.Lease.RenewByOwner`
- `Hayba.MCP.Lease.TouchOnUse`: a lease with TTL 60 s whose owner sends `ping`, `ui_tool_stream` and `editor_get_state` every 5 s lapses at 60 s; a refused write does not touch; a write that uses the lease's lock extends it.
- `Hayba.MCP.Lease.RenewRevivesOrphanedLeaseOfSameOwner`: after `OnConnectionClosed`, a `Renew` from the owner on a new connection clears the orphan and re-binds to it; a `Touch` does not; a `Renew` with ConnId 0 clears the orphan and leaves the lease unbound.
- `Hayba.MCP.Lease.ConnectionDrop`
- `Hayba.MCP.Lease.RenewWithoutHandle`: the ids survive `RedactFinalEnvelope`.
- `Hayba.MCP.Lease.RedactedMarkerShim`: a marker release drops the owner's `editor_gate:<owner>` lease, leaves its batch lease and its unlabelled asset leases, and answers `[lease_id_redacted]` when no gate lease exists.
- TS `lease-keeper.test.ts`:
  - the cadence stays inside the grace;
  - renew without an id;
  - release all stops every heartbeat;
  - release needs exactly one of its options;
  - the marker is ignored in the environment.

---

### T8: The enforcement flip and PIE-probe reclassification (item 03 c3 + item 06d; D1)

This task ships only in the same deploy as T4. It must never ship alone.

**Design**
1. **Setting** (`HaybaMCPDeveloperSettings.h:16-26, :93-95`):
   - insert `EnforcedForWrites` between `Advisory` and `Enforced`. The ini stores names, so an explicit `Enforced` still resolves;
   - set `LeaseEnforcement = EnforcedForWrites` and update the tooltip;
   - The consumer has no `DefaultHaybaMCP.ini`, so the new C++ default is what runs there.
2. **`CheckCommand` is rebuilt around `Decide()`.**
   - `FVerdict` gains `Code` and `Reason`.
   - The detail carries `enforcement`, `reason` (held / lease_unknown / owner_missing), `command`, `access_class`, `caller_owner`, the holder fields, `other_owners` (at most 8) for owner_missing, `repeats_in_window` and `hint`. It never includes a handle.
   - The refusal goes through `MakeGateRefusal`:
     - held: `retryable_failure` with `retry_unchanged_safe`;
     - otherwise `input_rejected`;
     - always `preflight` / `not_started`. This fixes today's `unclassified_handler_failure` / `unknown` label on a command that never ran.
3. **`owner_required`.** An unidentified write is refused while other owners are active: `owner_required: '<cmd>' (<class>) names no owner while 2 other agents are connected (LANE3, node-4312-a1b2c3). Send the envelope 'owner' (HAYBA_AGENT_ID) or a valid lease handle, then retry.`
   - `NoteAuthenticatedCaller` records presence only for owners that come from the envelope or from a valid handle, so the synthetic `conn:<n>` / `local` owners never count as present.
4. **Status.**
   - `ping` capabilities gain `lease_enforcement` (the `LexMode` string) and `owner_required: true`.
   - `lease_status` gains `active_owners`.
   - New `static FString FHaybaMCPLeaseManager::CurrentModeName()` returns `HaybaMCPEnforcement::LexMode(<current setting>)`. The existing `LexEnforcement` (`HaybaMCPLeaseHandler.cpp:36-45`), which maps any unknown enum to `advisory`, is deleted and every caller uses `CurrentModeName()`, so `enforced_for_writes` can never be reported as `advisory`.
5. **Fail-closed write detection.** `EnforcedForWrites` and `owner_required` key on the access class, and today that classifier fails open: every dispatched writer outside `IsDestructiveCommand` (`HaybaMCPCommandHandler.cpp:401-560`) and the S1 rows is Read, and Read is never refused. Examples: material_set_param, material_set_node, material_delete_node, material_disconnect, mesh_set_lod, texture_set_settings, texture_set_compression, bt_add_node, bt_compile, foliage_paint_at, asset_fix_redirectors, project_set_settings, editor_capture_viewport (which spawns the I-9 capture actor) and editor_set_camera. None of them showed up among the 7,962 logged collisions, because Read is never checked.
   - `ClassifyCommand` (`HaybaMCPAccessPolicy.h:103-140`) returns **Read only for commands in the R12 read sets** (`ControlPlaneCommands()`, `ReadCommands()`, `PieObservationCommands()`, plus the `lease_*` commands). Any other command it would have classified Read becomes **WriteScoped** (global IX plus world IX on the editor world, plus any S1 asset claim). This is the same list the PIE guard uses (R12), so there is one read table.
   - **`python_run`.** `ClassifyPythonRun` (`HaybaMCPAccessPolicy.h:470-506`) returns Read only when the caller declares `read_only: true`, never because no Tier-2 keyword matched. The lexical keywords miss real writers: `obj.set_editor_property(...)` does not contain `set_property`, and `build_from_static_mesh_descriptions` (the I-6 call) and `BlueprintEditorLibrary.compile_blueprint` match nothing. A declared `read_only:true` is trusted like a declared `resources` list; the Python policy tiers (`HaybaMCPPythonHandler.cpp:1863-1883`) are unchanged.
   - **Undeclared `python_run`** (no `resources`, not `read_only`) is expanded to **X on global for conflict checks**, so it conflicts with any other owner's lock, including `asset:` X build leases, which today sit directly under global and never meet a `world:` claim. Scripts narrow their scope by declaring `resources`. This matches the gate model, in which one lane at a time holds global X. `AssetBusyTargets` is unchanged; the global-X expansion is what makes a Python compile or save of another owner's asset conflict.
   - Advisory mode sees the same classes, so these commands now produce `lease_warning`s where they produced nothing; the limiter keeps M2 bounded.
6. **06d, PIE commands.** In `ClassifyCommand`:
   - PieSafe observation commands become **Read**. Otherwise `EnforcedForWrites` would refuse PIE probes whenever any lease is held.
   - PieOwner drive commands and `editor_stop_pie` keep a write class for Advisory reporting, but a command slot 2 authorized as a PIE command **skips slot 4** (R13). Otherwise the PIE owner's `editor_stop_pie` (Global, needs global X, `HaybaMCPAccessPolicy.h:507`) is refused as soon as another owner holds any lease, and that owner may have acquired during the PIE (`lease_acquire` is PieSafe; the gate's default scope is global). The other owner is itself stuck: its writes get `pie_active`, and it cannot stop a PIE it does not own. That deadlock would last until a human pressed Stop or bpgraph's 30-minute PIE wait expired.
   - `editor_start_pie` stays **Global**.
   - The existing `Hayba.MCP.Lease.Classification` assertion at `HaybaMCPLeasePolicyTest.cpp:65-66` ("every editor_pie_* is global", using `editor_pie_screenshot`) becomes "PIE observation is read" (`editor_pie_screenshot` → Read), and gains a drive-command case (`editor_pie_press_key` → WriteScoped) and `editor_start_pie` → Global. ADR-0010's text that describes PIE commands as global is amended in the same commit.
7. **TS:** `owner_required` joins `KNOWN_UE_CODES`, and the `lease_status` description lists `off / advisory / enforced_for_writes / enforced` and `active_owners`. The `python_run` tool gains an optional boolean `read_only` ("declare that the script only reads; undeclared scripts conflict with every other owner's lease") in its descriptor and sidecar entry.
8. **Docs:**
   - ADR-0010 `:105-118` is retitled "EnforcedForWrites by default", covering `owner_required`, the rate limit, fail-closed write detection and the `python_run` declarations;
   - `CHANGELOG.md` gets a Changed entry;
   - the migration README gets `:59`.

**Files**
- `HaybaMCPDeveloperSettings.h`
- `HaybaMCPLeaseManager.h/.cpp`
- `HaybaMCPCommandHandler.cpp`
- `HaybaMCPAccessPolicy.h`, `HaybaMCPCommandSets.h`
- `handlers/HaybaMCPLeaseHandler.cpp`, `handlers/HaybaMCPLegacyHandler.cpp`, `handlers/HaybaMCPPythonHandler.cpp` (`read_only` param)
- `Tests/HaybaMCPLeaseEnforcementTest.cpp`, `Tests/HaybaMCPLeasePolicyTest.cpp`
- TS: `tool-executor.ts`, `tcp-client.ts` (comments), `lease-tools.ts`, `python-run.ts` (`read_only`), `legacy-commands/sidecar.json`, `lease-keeper.test.ts`, `tcp-client.test.ts`, `ue-refusal-codes.test.ts`, `lease-enforcement-contract.test.ts`, `access-policy-drift.test.ts`

**Tests**
- `Hayba.MCP.Lease.EnforcedForWritesTwoOwners`, through the live router:
  - A holds global X;
  - B's `blueprint_add_node` gets `lease_conflict` with `enforcement: "enforced_for_writes"` and `not_started`;
  - B's `blueprint_inspect_graph` passes;
  - an owner-less write on a third connection gets `owner_required` naming A;
  - A's own write passes;
  - after A releases, B's write is no longer refused;
  - PIE deadlock case: A starts PIE, B acquires global X during the PIE, and A's `editor_stop_pie` and `editor_pie_press_key` succeed;
  - fail-closed case: B's `material_set_param` while A holds global X gets `lease_conflict` (it was Read before);
  - Python case: B's undeclared `python_run` while A holds only `asset:/Game/__HaybaTest__/BP_A` X gets `lease_conflict`; with `read_only:true` it passes.

  Settings are restored and owners forgotten afterwards.
- `Hayba.MCP.Lease.PieCommandsClassify`
- Updated `Hayba.MCP.Lease.Classification` (the `:65-66` assertion, design 6).
- `Hayba.MCP.Lease.ReadClassDrift`: fails when any registered command classifies Read but is not in the R12 read sets; lists the commands that moved from Read to WriteScoped in this task.
- `Hayba.MCP.Lease.PythonRunClassification`: undeclared → global X for conflicts; `resources` → those claims; `read_only:true` → Read; `set_editor_property` with no declaration is never Read.
- TS:
  - `lease-enforcement-contract.test.ts`: the default is `EnforcedForWrites`; every enum value has a wire name; every refusal code the plugin emits is in `KNOWN_UE_CODES`; no source still calls the deleted `LexEnforcement`;
  - `tcp-client.test.ts`: every envelope carries an owner;
  - `lease-keeper.test.ts`: `owner_required` mapping, `lease_unknown` as a reason, `repeats_in_window` passthrough.

**Rollback** (no rebuild, no restart). `LeaseEnforcement` is read on every check (`HaybaMCPLeaseManager.cpp:180`, `GetDefault`), and the setting's tooltip says it takes effect immediately.
1. **Live, preferred:** in the editor, Project Settings > Hayba MCP Toolkit > Lease Enforcement = Advisory. It applies at once and is written to `Config/DefaultHaybaMCP.ini` under the section below. No restart, so the user's session survives.
2. **Fallback, needs a restart** (editor down or UI unavailable): create or edit `Config/DefaultHaybaMCP.ini` with the section header, because a key without its section is ignored:
   ```ini
   [/Script/HaybaMCPToolkit.HaybaMCPDeveloperSettings]
   LeaseEnforcement=Advisory
   ```
   (The UCLASS is `Config=HaybaMCP, DefaultConfig` in module `HaybaMCPToolkit`; the consumer has no such file today.)
3. **Check:** `ping` shows `capabilities.lease_enforcement == "advisory"` and `lease_status.enforcement == "advisory"`.

---

### T9: Owner-first identity and `lease_adopt` (item 02b; Deploy C)

**Design**
- **`ResolveCaller(envelopeOwner, conn, envelopeLease)`** replaces `ResolveOwner` + `TryGetStringField`. It is the single choke point that item 32 (scoped auth) will tighten later.
  - The owner is:
    1. the envelope owner;
    2. otherwise the connection's adopted owner;
    3. otherwise `conn:N` / `local`.
  - **Reserved owners.** `conn:N` is accepted only from connection N, and `local` only from ConnId 0. Anything else is refused at router slot 0 with the top-level code `owner_reserved`.
  - `LeaseRef` is one of None, Bound, Unknown, NotBound or Redacted.
- **`EffectiveOwner()` returns `Context->Owner`.** The envelope `lease` field no longer changes identity. The Plan gate, the Python `deadline_s`, `editor_batch` and the lease handlers inherit this with no further edits.
- **NotBound.** Naming another owner's lease is never a refusal by itself. The command is judged as the caller.
  - The detail gains `lease_binding {named_lease_owner, caller_owner, fix}`.
  - The detail rides on a `lease_conflict` refusal if one follows. Otherwise it is sent as a warning with reason `lease_not_bound`.
- **`lease_adopt {owner, lease_id}`** is a new command.
  - It is Read class through the `lease_` prefix. It is not Plan-gated, not in `NON_IDEMPOTENT`, and is refused while unsafe (T1).
  - Checks, each with its code:
    - the call arrives over a connection: `[adopt_needs_connection]`;
    - the lease is live: `[lease_id_unknown]`;
    - the lease's owner equals `owner`: `[lease_owner_mismatch]`;
    - `owner` is not reserved: `[owner_reserved]`;
    - the connection is not already adopted by another owner: `[connection_already_adopted]`.
  - Effect: the connection's default owner becomes `owner`, and its bound leases are re-bound.
  - Reply: `{adopted:true, owner, lease_id, connection_owner, expires_in_s, note}`.
  - It follows the five-layer command checklist: handler, Node descriptor, returns text, agent-callable flags and category listing. Raw TCP works after layer 1, so it looks done early.
  - Node `handleLeaseAdopt` calls `setOwner` and `setLease` only after the editor confirms.
- **Auto-adoption.** A grant on a connection whose owner is explicit, and which is not yet adopted, adopts that connection.
- `lease_status` gains `connection_owner`.
- **Tests:**
  - `Hayba.MCP.Lease.Adopt`
  - `Hayba.MCP.Lease.ResolveCaller`
  - `Hayba.MCP.Lease.RouterBinding`
  - `Hayba.MCP.Lease.ReservedOwner`: includes a batch whose owner is `conn:900001`; its steps run after connection 900001 closes, while a raw envelope claiming `conn:900001` from connection 900002 gets `owner_reserved`.
  - `Hayba.MCP.Lease.UnknownLeaseRefusesWrites` (T8 shape: `lease_conflict` / `lease_unknown`)
  - updated `Hayba.MCP.Lease.ClassificationDrift`
  - TS: adopt switches owner and lease only after confirmation; a refused adopt changes nothing; `owner_reserved` mapping.
- **Batch steps.** `ProcessBatchStep` runs with ConnId 0 and today replays the batch owner through the envelope (`HaybaMCPBatchHandler.cpp:407-413`, `:751`; `HaybaMCPCommandHandler.cpp:1205-1216`). A batch whose lease was acquired without an envelope owner has `S->Owner == "conn:N"`, so the reserved-owner rule would refuse every step, and keep refusing after connection N closes (batches outlive their socket after T7). `ProcessBatchStep` therefore sets `Context.Owner` (and `Context.BatchJobId`) directly instead of round-tripping the owner through the envelope, and slot 0 is skipped for contexts with a non-empty `BatchJobId`: the owner was checked when the batch was submitted.
- **Rollback:** set `LeaseEnforcement=Advisory` (live, T8 Rollback), or revert T9 alone.

---

### T10: User Play veto for builds (item 06c; held for D7; Deploy B if D7 is approved in time)

T10 extends T2's `FHaybaPIEAuthorizer` (already registered in `FHaybaMCPEditorState::Startup`, with the unsafe branch) with a build branch.
- The pure decision `DecideUserPlay(busy, kind, mode, bUnsafe, lastVeto, now)` gains the busy branch: any `asset:` X lock (`FindAssetHolders({})`) is busy.
  - The mode comes from the CVar `hayba.PIEBuildVeto`: 0 = notification only, 1 = veto with a double-press override within 10 s, 2 = strict. **Deploy B ships with mode 1 as the default** if D7 is approved.
  - A veto uses the same mechanism as T2 design 9: **5.8** `RequestPIEPermissionInternal` returns `MakeError(FText)` naming the asset, owner and label; **5.7** returns false with `OutReason`. The engine cancels the session itself (`PlayLevel.cpp:2616-2632`). Hayba never calls `CancelRequestPlaySession` from the authorizer (double CancelPIE broadcast, and a reset of `PlaySessionRequest` while `StartPlayInEditorSession` holds `InRequestParams`, `PlayLevel.cpp:1197`).
  - Agent-attributed requests never get the override, and never reach the authorizer busy, because slot 3 already refused them.
  - The unsafe branch keeps precedence and has no override.
- Test: `Hayba.MCP.State.UserPlayDecision`, extended with the busy branch in all three modes, the double-press window and the agent case.
- If D7 is declined, T10 either ships with mode 0 (notification only) or is dropped, and M6b is reported as not moved in P0.

---

## 4. Protocol changes summary

### 4.1 Router gate order (after this train)

```text
parse → owner/lease resolve + SanitizeOwner (T6; ResolveCaller in T9)
      → "Processing command … (id, owner, via, conn, lease)" log line (T6)
      → auth (existing)
  0   → owner_reserved (T9)                          — skipped for batch steps (Context.BatchJobId set)
      → NoteAuthenticatedCaller: presence (T6/T8)    — never refuses, never extends a lease
  1   → editor_unsafe_restart_required (T1)          — unless in CommandsAllowedWhileUnsafe(cause)
  2   → pie_active (T2)                               — unless PieSafe; PieOwner drive only from the PIE's owner;
                                                        editor_stop_pie of an agent PIE from anyone
  3   → asset_busy (T3)                               — AnyBusyCommands: any holder, caller included;
                                                        AssetBusyTargets: other owners, under EnforcedForWrites/Enforced
  4   → lease gate: owner_required / lease_conflict (T8), otherwise lease_warning
                                                      — skipped for a PIE command slot 2 authorized (R13)
      → inline specials → Plan gate
      → TouchOnUse (T7)                               — non-Read commands that passed every gate only
      → dispatch in RunGuardedAt(Dispatch) (T1)
      → handler preflights: pie_blocked (T2), package_read_only (T5)
```
Routed batch steps (`ProcessBatchStep`) and in-process callers (ConnId 0) take the same path. The batch pump's own native work (region load and unload steps, cleanup `UnloadAll`, GC fences, `Finalize`) does not go through the router; its preamble (§3.0) stops it while unsafe and holds it during PIE. Every router refusal goes through `MakeGateRefusal`, so no refusal is classified by the words in its message.

### 4.2 Codes

**Top-level envelope `code`** (all are added to `UeToolErrorCode` / `KNOWN_UE_CODES`):

| Code | Task | Emitted when | `advisory.state` / mutation | Retry |
|---|---|---|---|---|
| `editor_unsafe_restart_required` | T1 | editor unsafe and the command is not allowlisted | policy_blocked / not_started; `session_health: restart_required` | forbidden until the editor restarts |
| `native_fault_contained` | T1 | the command that faulted | session_suspect / unknown; `restart_required` | forbidden |
| `pie_active` | T2 | PIE active or queued, and the command is not PIE-safe | retryable_failure / not_started | after `editor_get_state.pie == "none"` |
| `pie_blocked` | T2 | `editor_start_pie` found loaded Blueprints that would open a modal before play | retryable_failure / not_started | after compiling or fixing the listed assets |
| `asset_busy` | T3 | another owner holds X on the target asset (or any asset, for AnyBusyCommands) | retryable_failure / not_started | after `building` no longer lists it |
| `lease_conflict` | existing; T8 adds reasons | reason `held` or `lease_unknown` | held: retryable_failure; lease_unknown: input_rejected; both not_started | held: safe later; lease_unknown: re-acquire first |
| `owner_required` | T8 | unidentified write while other owners are active | input_rejected / not_started | after setting an owner |
| `owner_reserved` | T9 | the envelope claims `conn:N` / `local` that is not the caller's | input_rejected / not_started | never unchanged |
| `package_read_only` | T5 | a handler preflight found a read-only file (promoted from `data.code` by `IsWireRefusalCode`) | policy_blocked / not_started | after making the file writable, or with `save:false` |

**Handler text codes** (a bracketed prefix in `error`; not in `KNOWN_UE_CODES` in P0):
- T4: `[lease_id_required]`, `[lease_id_ambiguous]`, `[lease_id_redacted]`, `[lease_id_unknown]`
- T7: `[lease_owner_mismatch]` (keeps "lease belongs to"), `[no_leases]`, `[bad_request]`, and `[lease_id_redacted]` for a marker release that matches no legacy gate lease
- T9: `[adopt_needs_connection]`, `[connection_already_adopted]`, `[owner_reserved]`
- T5: `[package_read_only]` in `HaybaPersistAsset` errors, and in the text of every `package_read_only` refusal

**Fault and policy codes:** `HCR-NATIVE-002` (existing, reworded), `HCR-NATIVE-003` (new) and `HCR-NATIVE-004` (new). They appear in the error text and in `data.policy_code`.

**Warnings** (the command ran):

| Field | Task | Contents |
|---|---|---|
| `lease_warning` | existing; T6/T7/T8/T9 | `{code: lease_conflict or owner_required, reason: held / lease_unknown / owner_missing / lease_handle_redacted (T7) / lease_not_bound (T9), enforcement, lease_id_error?, lease_binding? (T9), repeats_in_window, hint}` |
| `state_warning` | T3 | `{code:"asset_busy", busy{…}}`, under Advisory only |
| `deprecation` | T4 | a string on replies to `lease_renew` / `lease_release` that used `token` |

### 4.3 Commands and fields

| Command | Change | Task |
|---|---|---|
| `lease_acquire` | granted gives `lease_id` (never `token`); adds `reused`, `ttl_s`, `max_ttl_s`, `orphan_grace_s`, `bind_connection`; identical claims reuse the lease | T4, T7 |
| `lease_renew` | `{lease_id?, token? (deprecated), ttl_s?}`; no id = renew by owner | T4, T7 |
| `lease_release` | exactly one of `{lease_id or token}`, `{ticket}` or `{all:true}`; a marker under `token` releases only legacy gate leases | T4, T7 |
| `lease_status` | `leases[].lease_id` (owner only), `orphaned`, `bind_connection`, `ttl_s`; top level `max_ttl_s`, `orphan_grace_s`, `active_owners` (T8), `connection_owner` (T9); Node adds `renewing_lease_ids` | T4, T7, T8, T9 |
| `lease_adopt` (**new**) | `{owner, lease_id}`, see T9 | T9 |
| `editor_batch` | param `lease_id` (preferred) or `lease`; pauses during PIE without spending fence time; refused while PIE is active or the editor is unsafe; a running batch fails with `editor_unsafe_restart_required` after a fault, without unloading or GC; PIE steps are rejected at validation | T4, T2, T1 |
| `editor_get_state` | param `include_dirty`; fields in T2 §6 (pie*, compiling, shader_jobs, saving, building, editor_unsafe, python_unhealthy, health) | T1, T2, T3 |
| `editor_start_pie` | adds `pie_requested`, `pie_owner`; refused by `pie_active`, `asset_busy` (the caller's own build included), `pie_blocked`, unsafe | T2, T3 |
| `editor_stop_pie` | stops an agent PIE from any caller; never a user PIE | T2 |
| `python_run` (editor) | runs with `EPythonCommandFlags::Unattended`; optional `read_only` declaration; CPython corruption markers raise `native_fault_contained` | T5, T8, T1 |
| user Play button | vetoed while unsafe (T2); vetoed during another build if D7 is approved (T10) | T2, T10 |
| `ping` | `capabilities.lease_id`, `.editor_health`, `.lease_enforcement`, `.owner_required`; health fields | T4, T1, T8 |
| `blueprint_compile` | sidecar param `save` (bool, default true); returns `saved`, `save_error`, `save_error_code` | T5 |
| `metasound_compile` | a failed save returns `ok:false, valid:true, mutation_status:"applied_unsaved"` | T5 |
| `python_run` (Node) | native faults map to `mutation_status`, `may_have_executed`, `restart_required`, `editor_health`, `advisory` | T1 |
| `test_inject_native_fault` (**new, test-only**) | in-process only, behind three guards; not in the sidecar, not agent-callable | T1 |

### 4.4 The `lease_id` transition (the compatibility decision)

| Phase | When | Server behaviour | Host requirement |
|---|---|---|---|
| **Before** | now, up to Deploy B | handles are named `token` and arrive as `[REDACTED:token]` | none; the gate falls back to its file lock unless it is migrated |
| **Precondition** | before the Deploy B build window | none | the migrated `editor_gate.py` and its tests are installed in the consumer project (§5.2). It uses leases only when `caps.lease_manager && caps.lease_id`, so against the old plugin it keeps the file lock |
| **A: transition** | Deploy B (T4 + T7 + T8) | output is `lease_id` only. `token` is accepted as a deprecated input alias on `lease_renew` / `lease_release`, with a `deprecation` field and a log line. A marker under `token` means renew by owner, or release of the owner's legacy `editor_gate:<owner>` leases. A marker in the envelope counts as absent. `caps.lease_id = true` | send `lease_id`; launch MCP servers with `HAYBA_AGENT_ID` equal to the gate owner and **without** `HAYBA_LEASE` (§5.2) |
| **C: removal** | when **all** hold: zero `deprecated param 'token'` lines in the consumer's log for 7 working days; item 15 (official client plus gate migration) has landed; and not before the `bc` → `main` PR | the alias and shim are removed; a `token` param answers `[lease_id_required] 'token' was renamed to 'lease_id'`; Node drops its "ignored" warning for `HAYBA_LEASE_TOKEN` (it has not read it since T4, R9) | none beyond phase A |

The envelope field `lease`, the `ticket` param and the `editor_batch` `lease` param **never change**.

**If an old gate reaches a new plugin anyway**, it raises `KeyError` at `editor_gate.py:273` after a global X lease with `bind_connection:false` was granted. That lease blocks every other owner's writes until 900 s after its owner's last write that used it (T7 touches only on use, never on status traffic). To recover, send `lease_release {all:true}` with `owner: <that gate owner>` (T7), or restart the editor. An old gate that does send its `lock.json` marker under `token` releases exactly its `editor_gate:<owner>` leases (T7 design 4), and nothing else of that owner.

---

## 5. Host-tooling migration notes (for the consumer's session)

Hayba never edits `<project>`. Changes ship as a regenerated patch and a test kit in `<host-kit>/` (`editor_gate.py`, `editor_gate.patch`, `tests/test_editor_gate.py`, `README.md`). Today that `editor_gate.py` is byte-identical to the consumer's `Tools/GameFlow/editor_gate.py`. Line numbers refer to that file.

### 5.1 Before Deploy A (recommended; nothing breaks without it, but M6a moves only with the bpgraph lease step)

- **Tell the user what the new notification means.** After Deploy A, a contained fault raises a persistent editor notification (T1 design 11). For a Python or native fault: save at once (File > Save All) and restart, without compiling, pressing Play or loading a map first. For an engine fatal during a save: do not save; restart. Play is vetoed until the restart.
- **bpgraph build leases (D5).** This step moved here from §5.2, because without it nothing marks a build busy and `asset_busy` cannot fire on Deploy A.
  - `bpgraph.mjs` acquires **one** lease covering every spec asset (`asset:<path>` X for each, at most 32 resources) on its persistent socket, with `bind_connection:true`, lane `long`, label `build:bpgraph_<pid>`, and an explicit envelope owner. It releases in `finally`, and a socket close drops it anyway.
  - The owner is `HAYBA_AGENT_ID`, which must equal the lane's gate owner. Without `HAYBA_AGENT_ID`, bpgraph fails fast with exit 2 (`set HAYBA_AGENT_ID to the gate owner`) instead of queueing behind its own lane's global X lease.
  - This works on the Deploy A plugin: writes are judged by the envelope owner, and the bound lease is dropped when the socket closes, so bpgraph never needs the (still redacted) handle.
  - **Keep the socket busy.** Before T7 the server closes a connection idle for 5 s and deletes its bound leases. While otherwise idle (a PIE wait, a long compile), bpgraph sends `ping` at least every 2 s on the same socket. After any reconnect it re-acquires before the next write (before Deploy B), or sends `lease_renew {}` (renew by owner, after Deploy B), which revives and re-binds an orphaned lease (T7).
  - bpgraph never sends `editor_start_pie` while it holds build leases; it releases them first. Its own PIE would be refused by `asset_busy` (T3 counts the caller's own build).
  - **Before Deploy B, lanes must not use `editor_gate.py acquire --scope asset:…`.** Those leases cannot be released before T4 (the handle is redacted, and `release_lease` prints "already lapsed"), so they would keep refusing `editor_start_pie` with `asset_busy` for up to 900 s after the lane thinks it released.
- `editor_gate.py` `hayba()` (`:130-147`): raise `HaybaError(message, code=msg.get("code"), detail=msg.get("pie") or msg.get("busy") or msg.get("lease") or msg.get("editor_health"))`, so callers branch on code, not text.
- **Exit codes.** One table for all host tools, so lanes can tell outcomes apart:

  | Exit | Meaning |
  |---|---|
  | 0 | ok |
  | 1 | timeout, or a lease that could not be used |
  | 2 | refused (existing) |
  | 3 | an asset refusal: `package_read_only`, `asset_busy`, `pie_blocked` |
  | 4 | `editor_unsafe_restart_required` or `native_fault_contained`: **stop all lanes; the user must restart the editor** |
  | 5 | a lease refusal: `lease_conflict`, `owner_required` |
  | 6 | the PIE wait cap was exceeded |

  The gate itself uses 0, 1, 2 and 4.
- `acquire_lease` (`:226-289`) and `acquire_file` (`:173-204`): when the editor answers, call `editor_get_state {include_dirty:false}` first. If `editor_unsafe` is set, or any reply has code `editor_unsafe_restart_required`, print `unsafe: fault contained at <health.faulted_at_utc> in <health.faulted_command>; restart the editor` and exit 4. Never re-queue, and never fall back to the file lock, in that case.
- `pie_running()` (`:43-45`): prefer `editor_get_state {include_dirty:false}` and test `pie != "none"`. Fall back to the log scan when the editor is down or the reply has no `pie` key (an older plugin).
- `status` (`:314`): print the health from `editor_get_state` next to `lease_status`.
- `bpgraph.mjs`:
  - `send()` (`:770-795`) passes through `code`, `pie`, `busy`, `lease` and `editor_health`;
  - `editor_unsafe_restart_required` or `native_fault_contained` stops the build at once, releases the gate in `finally`, and exits 4;
  - `pie_active` is preflight, so resending is safe: poll `editor_get_state {include_dirty:false}` every 2 s until `pie == "none"`, then resend; cap the wait at 30 min, then exit 6;
  - `asset_busy`: fail that asset with its owner, label and age, exit 3, and never loop;
  - `pie_blocked`: print the listed assets and exit 3;
  - before pass 1, refuse to start when `pie != "none"` or `editor_unsafe` is set.
- `apply_look.py` (`:113-135`): read `msg.get("code")`. Either unsafe code raises `SystemExit("editor_unsafe: …")`. `pie_active` maps to the existing PIE exit.

### 5.2 Before Deploy B (required; this is the D1 / R1 precondition)

`editor_gate.py`:
1. `lease_manager_available()` (`:160-168`) requires both `caps.lease_manager` and `caps.lease_id`. Otherwise it uses the file lock.
2. Add `LEASE_ID_RE = re.compile(r"^ls_[a-z0-9_]+$")` and validate every id read from the editor, the environment, `--lease-id` / `--token` or `lock.json`.
3. `mirror_grant` (`:87-98`) stores `{"lease_id": …}`.
4. `mirrored_token` (`:115-121`) becomes `mirrored_lease_id`, which returns `held.get("lease_id")` only when it matches the regex. Legacy `{"token": "[REDACTED:token]"}` entries, which the consumer's `lock.json` holds today, count as absent.
5. Renew (`:232-240`): send `lease_renew {"lease_id": id, "ttl_s": ttl_s}`. Re-running acquire is now idempotent too.
6. Acquire (`:273-274`): read `held["lease_id"]`. If it is missing or invalid, print `refused: Hayba returned no usable lease_id` and exit 2.
7. Release (`:280-283`, `:301`): a held lease goes out as `{"lease_id": …}`. A queued request is withdrawn with `{"ticket": ticket}`, which today wrongly goes out under `token`.
8. Validate `HAYBA_LEASE` / `--token` against the regex before sending (`:293`), because a stale shell variable can hold the marker.
9. Add a `lease-id` subcommand and a `--lease-id` flag. Keep `token` / `--token` as CLI aliases.
10. Keep the `belongs to` and `ticket` substring checks (`:258`, `:303`). The plugin preserves both.
11. `announce()` (`:219-223`) prints `HAYBA_AGENT_ID=<owner>` (for launching MCP servers) and, on a separate labelled line, `HAYBA_LEASE=<lease_id>  # helpers only; never put this in an MCP server's environment`. Update the docstring (`:1-30`).
12. `tests/test_editor_gate.py`: `FakeHayba` answers with `lease_id` and `caps.lease_id`. The new tests are:
    - `test_plugin_without_lease_id_capability_keeps_the_file_lock`
    - `test_redacted_mirror_entry_is_ignored_and_reacquired`
    - `test_renew_and_release_send_lease_id`
    - `test_timeout_withdraws_ticket_with_ticket_param`
    - `test_grant_without_usable_lease_id_exits_2`
    - `test_acquire_refuses_when_editor_unsafe_exit_4`
    - `test_renew_refused_unsafe_does_not_requeue`
    - `test_status_reports_editor_health`

**Lane environment:**
- Every Claude Code MCP server a lane uses runs with `HAYBA_AGENT_ID` equal to that lane's gate `--owner`. Otherwise, under `EnforcedForWrites`, the lane's own MCP writes are refused while its gate lease is held.
- MCP servers are launched **without** `HAYBA_LEASE`. Node ignores it anyway (R9), and reads only `HAYBA_LEASE_ID` as an explicit opt-in. The owner match already covers the lane's gate lease.
- Undeclared `python_run` conflicts with every other owner's lease under `EnforcedForWrites` (T8 design 5). A lane that runs Python while another lane holds a lease either waits for the gate as today, or declares `resources` (or `read_only: true` for a script that only reads).

**Helpers:**
- `bpgraph.mjs` (`:774-777`), `apply_look.py` (`:120-125`), `Tools/Foliage/check_pcg_culls.py` (`:132-133`) and `Tools/UI/import_input_prompts.py`:
  - always send an owner: `HAYBA_AGENT_ID`, else `<script>-<pid>`;
  - fail fast with exit 2 when `HAYBA_LEASE` is set but `HAYBA_AGENT_ID` is not;
  - stop at the first `lease_conflict` / `owner_required` (exit 5), printing `lease.holder_owner` and `lease.reason`.
- `bpgraph.mjs` builds (D5): the lease step is in §5.1. After Deploy B it may also take its leases through `editor_gate.py acquire --scope asset:<…> --lane long --label build:<id>`; add `--label` (today the label is hard-coded at `:254`). On any reconnect, send `lease_renew {}` before the next write (T7).
- `bpgraph.mjs`, read-only files: keep the preflight (`readOnlyPackages` `:672-700`, exit 3 at `:1307-1313`). Also treat `r.data?.code === 'package_read_only'` from `blueprint_compile` (`:942-948`, `:1169-1178`) as fatal: exit 3 and print `r.data.make_writable_hint`. After Deploy B, reword the header comment (`:35-40`) that says a read-only save crashes the editor.
- **Rulings and memory.** Update ruling R49 ("read lock.json") and any note that teaches `lease_renew {token}`. The alias keeps those working until phase C.

### 5.3 After Deploy B, before Deploy C (required for T9)

- Every helper that runs under a gate lease must send the gate's `--owner` as the envelope owner.
  - After T9, the envelope `lease` field no longer confers identity. A helper that sends only `lease` is judged as `conn:<id>`, and its conflicting writes get `lease_conflict` with a `lease_binding` fix hint.
- Replace `MAX_LEASE_TTL_S = 900` (`:39`) with the reply's `max_ttl_s`.
- Add `env --owner X`, which prints only `HAYBA_AGENT_ID=X` (for launching MCP servers), and `env --owner X --helper`, which also prints `HAYBA_LEASE=<lease_id>` for helper processes. The two are never printed together by default, so an MCP server never inherits a lease that later dies.
- Keep `bind_connection:false` for the gate's own short connection.
- `lease_adopt` is only for clients that cannot put an owner on every envelope. Repeat it after every reconnect, because the editor drops connections idle for about 5 s.

### 5.4 Unaffected, and one correction

- `apply_look.py`'s Python calls, and every host script that calls `unreal.EditorAssetLibrary.save_*` through `python_run`. Asset saves already fail softly and return `False`; scripts must keep checking that value.
- **Map saves from Python** (`save_current_level`, `EditorLoadingAndSavingUtils.save_map`, the scripted load-save-unload pattern) did **not** fail softly: on a read-only map they opened a modal on the game thread and stalled every lane. After Deploy B (T5, `Unattended`) they return `False` like asset saves. Until then, check `os.access(path, os.W_OK)` on the `.umap` before a Python map save.
- The envelope field names `lease`, `owner` and `auth`.

---

## 6. Testing strategy

### 6.1 Levels

1. **Pure C++ policy tests** (`EditorContext | EngineFilter`, an injected clock, no editor state): enforcement decisions, health classification, PIE rules and tracker, id format, `ResolveIdParam`, the limiter, presence, asset-busy targets, and the lease table.
2. **C++ router tests** through `Module->GetCommandHandler()->ProcessCommand(json, ConnId)`, so every reply really passes `JsonToString` → `RedactFinalEnvelope`.
   - Owners are unique (`hayba-test-<guid8>`), ConnIds are fake (≥ 900000), and asset paths do not exist (`/Game/__HaybaTest__/…`). Release and forget in `ON_SCOPE_EXIT`.
   - Stateful singletons are overridden (`FScopedOverrideForTests`, `FScopedPieOverride`) wherever the design provides a seam.
3. **Owned-child tests** (the default isolation class) for anything that can fault, save to disk, switch worlds or start real PIE. Never add them to the InProcess allowlist.
4. **TS vitest** covers the Node surface: shape contracts, redaction boundary, and fail-closed source contracts.
5. **Python host kit:** `python -m pytest <host-kit>/tests -q`.

### 6.2 Rules

- **Filter `Hayba`, never `Hayba.MCP`.** The narrower prefix silently skips whole files.
- **Verify exact names, not counts.** A UE build can report "Succeeded" without compiling a new `.cpp`.
  - The plan adds a manifest, `mcp-tools/hayba-mcp/scripts/p0-expected-automation-tests.txt`, with every test name listed in section 3. Names are full leaf names as registered (for example `Hayba.MCP.Advisory.AllStates`, never a prefix such as `Hayba.MCP.Advisory`).
  - A checker, `scripts/check-automation-report.mjs`, reads the automation report JSON (`-ReportExportPath`) and fails when any manifest name is missing, or present with a state other than Success.
  - The only allowed exception is the known `-NullRHI` failure of `Hayba.MCP.UI.RenderWidgetToPng`.
- **Source-scanning contract tests fail closed.** Each asserts a minimum number of files and matches, and each guard learns every call form in the same commit (ADR-0007).
- **A real unsafe flag poisons the rest of the run.**
  - Every test that injects or can reach an SEH catch uses the health override or runs in an owned child.
  - Router tests assert exact codes, so a stray real `editor_unsafe` shows up as `editor_unsafe_restart_required` failures rather than passing silently.
- **Tests never touch the consumer project.**
  - Automation, manual acceptance and raw-TCP checks run only on the scratch host or the Hayba dev editor.
  - Never on the consumer's live editor, never against `<project>/Plugins`, and never while other agents hold leases on the editor under test.

### 6.3 Headless run on a scratch host project

The scratch host is a blank UE 5.8 C++ project, for example `D:/Scratch/HaybaP0Host/HaybaP0Host.uproject`.
- Its `Plugins/` holds **copies** of the worktree's plugins. The dev host's satellites symlink to `main`, so a satellite change on this branch would go untested there.
- The `Metasound` engine plugin is enabled, for the MetaSound satellite.

```bash
UE="C:/Program Files/Epic Games/UE_5.8"
WT="D:/Hackathons/hayba/.worktrees/p0-safety"
SHA=$(git -C "$WT" rev-parse --short HEAD)

# 1. Standalone plugin compile and package; catches missing includes and module deps.
"$UE/Engine/Build/BatchFiles/RunUAT.bat" BuildPlugin \
  -Plugin="$WT/unreal/HaybaMCPToolkit/HaybaMCPToolkit.uplugin" \
  -Package="D:/Scratch/HaybaP0Build/$SHA/HaybaMCPToolkit" -TargetPlatforms=Win64

# 2. Install into the scratch host: the packaged Toolkit plus copies of the satellite sources
#    (HaybaMCPMetaSound and HaybaMCPGAS depend on the Toolkit, so they build inside the host).
#    Then build the host's editor target.
"$UE/Engine/Build/BatchFiles/Build.bat" HaybaP0HostEditor Win64 Development \
  -Project="D:/Scratch/HaybaP0Host/HaybaP0Host.uproject"

# 3. List and run everything under the Hayba filter, writing a JSON report.
"$UE/Engine/Binaries/Win64/UnrealEditor-Cmd.exe" "D:/Scratch/HaybaP0Host/HaybaP0Host.uproject" \
  -ExecCmds="Automation List;RunTests Hayba;Quit" \
  -ReportExportPath="D:/Scratch/HaybaP0Reports/$SHA" \
  -unattended -nopause -nosplash -NullRHI -log

# 4. Exact-name verification.
node "$WT/mcp-tools/hayba-mcp/scripts/check-automation-report.mjs" \
  "D:/Scratch/HaybaP0Reports/$SHA/index.json" \
  "$WT/mcp-tools/hayba-mcp/scripts/p0-expected-automation-tests.txt"
```

- `-ExecCmds` splits on `,`, so the whole string reaches one `Automation` command, which splits its remainder on `;` (`AutomationCommandline.cpp:582`). Subcommands after the first are therefore written **without** a repeated `Automation` prefix; `Automation List; Automation RunTests Hayba` would log "Unknown Automation command" and run nothing. This is the in-repo form (`HaybaMCPTestHandler.cpp:922`: `Automation RunTests %s;Quit`).
- Results are in the report and in the host's `Saved/Logs`, not on stdout. Let the editor exit on its own; killing it early truncates the log and shows "0 tests".
- On `LNK1104` (a leftover editor holding the DLL), kill only processes whose command line names the **scratch project**, never a consumer editor.
- `Hayba.MCP.State.RealPIE` runs in a separate invocation with `-HaybaRealPIETests`.
- Run the headless suite on:
  - every task's tip before it lands;
  - the Deploy A and Deploy B tips;
  - each merge result (§7), both `<deploy-branch>` with its fixups and `bc`.

### 6.4 TS gate (run locally)

```bash
cd mcp-tools/hayba-mcp
# build the @hayba/* workspace packages first, then:
npx tsc --noEmit && npm test && npm run lint:legacy-wrappers
npm run build:server   # before any live check; a stale dist/ is why tools "go missing"
```

- **New test files:**
  - `tools/save-site-contract.test.ts`
  - `tools/package-read-only.test.ts`
  - `tools/__tests__/editor-health-contract.test.ts`
  - `tools/__tests__/editor-state-policy-drift.test.ts`
  - `tools/__tests__/lease-enforcement-contract.test.ts`
  - `tools/lease/lease-wire.test.ts`
  - `tools/ue-refusal-codes.test.ts`
  - optionally `security/native-redaction-parity-contract.test.ts`, which extracts at least 40 heads.
- **Wire tests** that wrap handlers in `wrapToolHandlerForStream` must `vi.mock('../../tcp-client.js')`. The mirror otherwise dials the real editor on 52342.

### 6.5 Manual acceptance (Hayba dev editor only, over raw TCP 52342)

1. `ping` shows `caps.lease_id`, `editor_health`, `lease_enforcement: "enforced_for_writes"` and the health fields.
2. `lease_acquire` on `asset:/Game/__HaybaTest__/X` returns an `ls_` id. `lease_renew` works, `editor_batch` with a `ping` step reaches `succeeded` in `batch_status`, and `lease_release` works. The log has zero "unknown or expired" lines.
3. With a scratch Blueprint marked read-only, `blueprint_compile {save:true}` refuses with the hint, and `{save:false}` compiles.
4. Start PIE by hand. `blueprint_add_node` gets `pie_active`, `editor_stop_pie` from a raw connection is refused, and `editor_get_state` shows `pie: "user"`.
5. Confirm the 5 s idle drop (T7) with an idle Node client before tuning the 60 s grace.
6. Switch Lease Enforcement to Advisory in Project Settings and back; `ping` reports each mode at once, with no restart (T8 rollback).
7. Review the exact notification texts and the Play-veto message, which `UserNotifiedOnce` and `UserPlayDecision` print to the automation log. The real notification is never raised on a shared editor by a test, because a real fault poisons the process.

---

## 7. Rollout

### 7.1 Branch flow

```text
feat/multi-agent-leases (d5a1a205)
  ├─ fix/p0-safety: T1 → T2 → T3 ──(Deploy A)── T4 → T5 → T6 → T7 → T8 [→ T10 if D7] ──(Deploy B)── T9 ──(Deploy C)
  │     ├─ merge → <deploy-branch>   (consumer hotfix; with fixups §7.3)
  │     └─ merge → feat/hayba-brain-client     (trunk; after each deploy is verified, and only after step 0)
  └─ step 0: merge feat/multi-agent-leases → feat/hayba-brain-client (prerequisite, §7.3)
```

- Each deploy point is a tag on `fix/p0-safety` (`p0-deploy-a`, `p0-deploy-b`, `p0-deploy-c`) and passes the full gate before it is tagged: headless C++ with exact names, the TS gate, and the host kit.
- Work lands on feature branches and is pushed when ready. No direct commits to `deploy/*` other than merges and the listed fixups.

### 7.2 Build windows (coordinated with the consumer's session)

Every deploy is a **full editor rebuild with the consumer's editor closed**.

1. **Hayba side.**
   - Merge the tag into `<deploy-branch>` with the §7.3 fixups.
   - Re-run the headless suite on the merge result.
   - Build the Node `dist/` from the **same commit**. With a new Node and an old plugin, Node reports `lease_id_error` and tracks nothing; with an old Node and a new plugin, auto-renew silently stops.
2. **Consumer side, before the window.**
   - Deploy A: the user knows what the unsafe notification asks of them (§5.1).
   - Deploy B only: the migrated gate and its tests are installed and green; `HAYBA_AGENT_ID` is set per lane and `HAYBA_LEASE` is not in any MCP server's environment (§5.2); D7 is decided.
   - Announce the window. All lanes stop via the gate (`acquire --owner deploy`, global). The user saves and closes the editor.
3. **Build.**
   - Deploy through the existing deploy-branch path. **Never `robocopy /MIR` into `<project>/Plugins`.**
   - The MetaSound satellite reaches the consumer only once it is installed there (D6, after T5).
4. **Restart and verify** (done by the consumer's session on its own editor):
   - `ping` capabilities and health;
   - `editor_get_state` fields;
   - gate acquire, renew and release through `lease_id`;
   - one `editor_batch` ping job (M3);
   - zero `unknown or expired` lines in the first hour (M1, M2).
5. **Metrics.** Collect M1–M7 over the following 7 days.

**Rollback**
- Enforcement problems: Project Settings > Hayba MCP Toolkit > Lease Enforcement = Advisory, live, with no restart and no rebuild. Fallback with a restart: `Config/DefaultHaybaMCP.ini` with the `[/Script/HaybaMCPToolkit.HaybaMCPDeveloperSettings]` section and `LeaseEnforcement=Advisory`. Check `ping` `capabilities.lease_enforcement == "advisory"` (T8 Rollback).
- A user-Play veto problem after T10: `hayba.PIEBuildVeto 0` in the console (notification only), live.
- Anything else: redeploy the previous tag, which needs a full rebuild in a new window.
- The `pie_active` guard, the unsafe gate and the unsafe Play veto have no runtime switch, by design.

### 7.3 Merge fixups

- **Into `<deploy-branch>`:**
  - That branch has a fourth raw save, `HaybaAnimShared::SavePackage` (`handlers/HaybaMCPAnimationHandler.cpp:458-472`, used at `:575` and `:1124`). Route it through `SaveAndVerify`, and add a `save:true` preflight before compiling in `anim_blueprint_compile` (`:1111-1124`). Without this the save-site contract test fails there.
  - `AssetWriteCommands`: take the **union** of the branch's anim rows and T3's blueprint and UI rows, with one `AssetPackageKey`. `ClassificationDrift` must pass on the merge.
  - Include `anim_blueprint_compile` in `AssetBusyTargets`; it is already in the table, keyed on `path`.
  - Add `blueprint_remove_node` (registered on this branch, `63f4c619` / `f389950f`) to the S1 blueprint rows, keyed on `path`; `ClassificationDrift` and `access-policy-drift.test.ts` must pass on the merge.
- **Into `feat/hayba-brain-client`:**
  - **Step 0, a prerequisite with its own gate run.** `bc` does not contain this train's base: `d5a1a205` is not an ancestor of `feat/hayba-brain-client`, their merge-base is `5c4aefed`, and `feat/multi-agent-leases` has 12 commits `bc` lacks (`bc` has no `HaybaMCPLeaseManager`, no `HaybaMCPBatchHandler` and no `docs/adr/0010`). Merging `fix/p0-safety` would bring in the whole lease feature too. A read-only `git merge-tree` of `d5a1a205` into `bc` already shows textual conflicts before any P0 change:
    - `HaybaMCPCommandHandler.cpp`, the Plan-gate block: `bc`'s Agent-panel approval against the per-owner `PlanApprovalApplies`. This is the router file that T1, T2, T3, T6, T7 and T8 all edit;
    - `HaybaMCPMainPanel.cpp`, `HaybaMCPStyle.cpp`, `CHANGELOG.md`, `IconAgent.svg`, `IconWorld.svg`.

    So: merge `feat/multi-agent-leases` into `bc` first, on a feature branch, resolving the Plan-gate (for example, keeping the Agent-panel approval as one source of approval for the per-owner `PlanApprovalApplies`), MainPanel, Style, CHANGELOG and icon conflicts, and run the full gate (headless C++ with exact names, TS gate) on the result. Only then merge each verified P0 deploy tag.
  - The same three save sites exist there (`HaybaMCPBlueprintHandler.cpp` at `:482` / `:1341` on `bc`), and `blueprint_remove_node` is registered there: add it to the S1 rows as on the deploy branch.
  - Before merging, confirm that the main checkout's uncommitted files (R11) have been committed or set aside by their owner. They sit on `feat/multi-agent-leases`, so if they are committed there they arrive through step 0.
  - Re-run the full gate on `bc` after each merge.

### 7.4 Deploy contents

| Deploy | Tasks | Host prerequisite | Metrics moved |
|---|---|---|---|
| A | T1, T2, T3 | none to be safe; §5.1 recommended, and its bpgraph lease step is required for M6a | M4, M5, M8, M6a (with the §5.1 bpgraph step), part of M7 |
| B | T4, T5, T6, T7, T8, plus T10 if D7 is approved before the window | §5.2 (required); D7 decided | M1, M2, M3, M6b (only with T10), the rest of M7 |
| C | T9 | §5.3 (required) | attribution quality; no new metric |
| later | T10, if D7 is decided after the Deploy B window | D7 sign-off | M6b |

If the consumer takes a single window, A and B ship together with the §5.2 prerequisite.

---

## 8. Out of scope (later waves)

- **Python policy rework** (postmortem P1-2): AST classification, exemptions for the typed-tool wrappers, `try/except` rules, `project_read_text`.
- **Python save paths** (item 07): `read_only` reasons for each failed path in `asset_save`. (The `Unattended` flag for `python_run` moved into T5.)
- **Python and GC after a fault:** anything beyond unhooking the pre-GC delegate (T1 design 12), such as an `EXCEPTION_CONTINUE_SEARCH` crash-and-report option or an automatic save-and-restart.
- **Veto of the user's Compile button while unsafe.** Only the notification covers it in P0.
- **General post-execution facts** (item 08): `may_have_executed` generalised to all commands, stdout on error, and the `HCR-TIME-001` post-execution case.
- **Official client and gate migration** (item 15, P1-5): a persistent Node and Python client, per-request ids, connection reuse.
- **PIE verification tools** (P1-3): `pie_run_check` / `pie_run_sequence`, and first-contact registration of `pie_*`.
- **Batch graph authoring** (P1-1): `blueprint_apply_graph_spec`, `blueprint_clear_graph`.
- **Safe capture APIs** (P1-4), viewport ownership, and the guard against saving unrelated dirty packages.
- **World Partition bulk-load caps** (P2-5), and the other P2 capability gaps (MetaSound authoring, Sequencer, Niagara, node fidelity, widget renders, sidecar health).
- **Save-hook changes:** a `PackageSavingDelegates` pre-save hook, and any option for Hayba to clear read-only flags.
- **Detection gaps:** ACL-denied or locked-file detection. Those files still fail softly under `SAVE_NoError`.
- **Lease follow-ups:** scoped auth and principal binding (item 32); `MaxHoldSeconds`; `batch_cancel`; thin `build_begin` / `build_end` wrappers.
- **State and PIE follow-ups:** a push event for editor state; a `during_pie` escape; an `EXCEPTION_CONTINUE_SEARCH` option for 0x4000. (Status-only reads after an engine fatal moved into T1; the shared command sets are R12.)
- **Pre-existing issues noted but not fixed:**
  - `create_graph` still displaces an existing graph when a save fails for a non-read-only reason;
  - the `level_*` handlers still use `IsPlayingSessionInEditor`;
  - `BP compile %s: ok=%d` still logs at Warning on success (`HaybaMCPBlueprintHandler.cpp:161-163`).

---

## Appendix A: where this spec overrides an item design

| Item design said | This spec | Rule |
|---|---|---|
| 02, 04, 06 host notes: the editor keeps returning a (redacted) `token` during the transition | `token` is never emitted; `lease_id` only; the gate migrates first | R1 |
| 02: add `FHaybaHandlerResult::Code` / `ErrCode` | no public-struct change; bracket or data-code channels | R3 |
| 02: top-level code `lease_unknown` for a dead handle | `lease_conflict` + `reason: lease_unknown`; handler `[lease_id_unknown]` | R4 |
| 01: a marker in any id param gives `[lease_id_redacted]`; 02: a marker gives renew/release by owner | canonical `lease_id` marker → error; deprecated `token` marker → by owner; envelope marker → absent | R5 |
| 01: `lease_renew` with no id gives `[lease_id_required]` | renew by owner once T7 lands | R6 |
| 06: `editor_get_state.python` / `unsafe` / `unsafe_detail` | 04's `editor_unsafe` / `python_unhealthy` / `health` | R7 |
| 04 and 06 both claimed ADR-0011 | 0011 = editor_unsafe, 0012 = editor-state guards | R8 |
| 01: `HAYBA_LEASE_ID`; 02: `HAYBA_LEASE` | Node reads only `HAYBA_LEASE_ID`; `HAYBA_LEASE` is for helpers only | R9 |
| 03: asset_busy after the lease gate; 06: before it | before it | R10 |
| 04, 06, 03: add cases to `tool-executor.test.ts` | a new `ue-refusal-codes.test.ts` | R11 |
| 04 / 06: separate refusal builders; 06: a `SignalsForError` prefix branch | one `MakeGateRefusal` with explicit signals; no message-based classification for router refusals | R2 |
| 06: the lease handle stays under `token` in host lock mirrors with a fallback read | host stores `lease_id`; legacy marker entries count as absent | §5.2 |
| 03 host note: send `{lease_id, token}` together | send `lease_id` only; the gate uses leases only when `caps.lease_id` is set | §5.2 |
| bpgraph exit codes: 04 used 4 for unsafe, 03 used 4 for lease refusals, 06 used 4 for a PIE timeout | one table: 3 asset, 4 unsafe, 5 lease, 6 PIE wait | §5.1 |
| 06c: the unsafe Play veto is part of T10 and D7 | the unsafe branch ships in T2 (Deploy A) under D2 | §2.3, T2 design 9 |
| 06: separate PieSafe table; 04: separate unsafe read list; 03: access class decides writes | one command-set header; write detection fails closed | R12, T8 design 5 |
| 06b: `asset_busy` excludes the caller's own leases | `AnyBusyCommands` counts the caller's own build | T3 design 4 |
| 02: touch on every command, orphan capped at `Now + 60` | touch only on a used, non-Read, admitted command; orphan capped at `OrphanedAt + 60` | T7 design 1–2 |
| 02: idempotent acquire keyed on owner and claims | keyed on owner, claims, label and binding | T7 design 1 |

---

## Appendix B: critic round 1

All critical and important findings were applied. These parts were merged into another finding's fix, or rejected:

- **Considered and rejected:** holding a running batch while unsafe (`LastBusy = "editor_unsafe"`, the batch waits for the restart). The batch is finished as failed instead (T1 design 13), without `RunStep`, `UnloadAll`, `ReleaseAll` or GC. That is equally safe, and a held batch would keep renewing its lease and blocking the lease queue until the restart for no benefit.
- **Considered and rejected:** letting `Touch` clear the orphaned state of a lease whose owner reconnects. It contradicts the critical touch finding (routine traffic must never keep a lease alive). Only an explicit `Renew`, `RenewOwner` or `lease_adopt` by the owner revives and re-binds an orphan, and bpgraph sends `lease_renew {}` after any reconnect (T7, §5.1).
- **Considered and rejected:** refusing `editor_start_pie` from a synthetic `conn:*` owner. It would break owner-less host scripts on Deploy A, which promises no host change; allowing `editor_stop_pie` of an agent PIE from any caller already removes the stuck-PIE state.
- **Considered and rejected:** classifying `editor_stop_pie` and the drive commands against the `pie` resource. Skipping slot 4 for a PIE command that slot 2 authorized (R13) removes the deadlock without a new lock shape.
- **Considered and rejected:** excluding only same-connection leases from `AnyBusyCommands`. The stricter rule (count every holder, the caller included) is simpler and fails closed; a tool releases its build leases before it starts PIE.
- **Not decided here:** shipping T10 in Deploy B depends on D7, a maintainer decision. The spec requires D7 to be decided before the Deploy B window and defines both outcomes (§2.3, M6a/M6b).
