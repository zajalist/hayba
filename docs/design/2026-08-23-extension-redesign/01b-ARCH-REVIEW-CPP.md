# Architecture review — UE C++ plugin (agent report, 2026-08-23)

> Produced by a read-only review agent over
> `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit` (282 files, ~14.6k lines
> outside `handlers/`, ~29.8k inside) + satellites. Verified spot-checks by the
> main session. Vocabulary: module / interface / seam / adapter / depth.

**Headline:** an unusually good centre and an unusually thin periphery. The
router (`ProcessCommand`), transport (`FHaybaMCPTcpServer`), redaction, and
advisory classifier are deep modules with invariants written down in prose at
the point of enforcement. The 33 handlers behind `IHaybaMCPHandler` are the
opposite: a 25× line-count spread (158 → 4018), ~478 hand-rolled
`TryGet*Field` calls against 18 files that touch the shared reader, and one
structural gap (no deferred response) that forced three different workarounds
into three different handlers.

## 1. The handler seam

Interface: `IHaybaMCPHandler.h:29-46` — `GetDomain()` / `GetCommands()` /
`Handle(Command, Params)`; `FHaybaHandlerResult {bOk, Data, ErrorMessage}`.
Envelope built by the router. Narrow — but **synchronous and total**: no
Pending/Deferred case. Everything in §2 falls out of that.

Consistency, measured:

| Handler | .cpp lines | raw `TryGet*Field` | `FHaybaParamReader` | `Err(` sites |
|---|---|---|---|---|
| UIHandler | 4018 | 122 | 2 | 161 |
| PIEHandler | 3259 | 68 | 4 | 107 |
| MaterialHandler | 3201 | 12 | 20 | 116 |
| PythonHandler | 2257 | 2 | 0 | 13 |
| AssetHandler | 1864 | 31 | **0** | 30 |
| LegacyHandler | 1809 | 54 | 1 | 19 |
| DataAssetHandler | 1804 | 1 | 3 | 24 |
| AudioHandler | 1349 | 30 | 7 | 93 |
| BlueprintHandler | 1311 | 5 | 11 | 69 |
| ProjectHandler | 158 | 4 | 0 | 3 |

Totals: **478 raw `TryGet*Field` in `handlers/`; 18/33 files touch
`FHaybaParamReader` at all; ~3 call sites of the thin `HaybaParams::` wrappers.**

Shared toolkit exists and is under-adopted:
- `HaybaMCPParams.h` (817 lines) — `FHaybaParamReader` accumulates errors,
  distinguishes missing / wrong-kind / empty / over-length. Its own header
  comment (`:1-22`) diagnoses why it lost: the thin same-shape wrappers were
  decoys.
- `HaybaMCPResponseBuilder.h` — applied by the router universally (correct
  chokepoint; 0 direct handler calls, by design).
- `HaybaMCPAssetGuard.h` — modal-dialog refusal; adopted by **6/33** handlers.
  Handlers calling `IAssetTools::CreateAsset` without it are latent hangs.
- `HaybaMCPSaveVerify.h` — used by **1** handler; 5 handlers call
  `UPackage::SavePackage` directly.

Transactions: **no handler boilerplate, by design** — the router owns
Begin/Commit/Cancel (`HaybaMCPCommandHandler.cpp:1370-1382`, `:1479-1484`);
`UIHandler` has the documented `FScopedTransaction` opt-out. The leak is
**`MarkPackageDirty` — 44 calls across 10 handlers** (MaterialHandler 23).

The `Ops` pattern (Parse pure → Execute editor → Shape) is the stated answer
(`HaybaActorOps.h:1-24`, cites #320): landed for 6 domains with tests
(ActorOps 171, EditorOps 83, AudioOps 86, BlueprintOps 49, UIOps 247,
PIERuntimeOps 443). 27 domains have none — and BlueprintOps is 49 lines carved
from a 1311-line handler: the seam exists but is nearly empty for the biggest
domains.

## 2. Transport and game-thread dispatch

Threading model (invariants written in code comments — the strong part):

```
[listener thread]  Run()                       TcpServer.cpp:343
[client reader]    frame-decode → PendingCommands (bounded 1..1024)
[GAME THREAD]      FTSTicker → DrainPendingCommands()   :546
                   MaxCommandsPerTick = 4               :16
                   → ProcessCommand (handlers run HERE)
[client writer]    serial writer thread, budgets        :488
```

Key documented invariants: FTSTicker-not-AsyncTask (`:250-254`, task-graph
re-entrancy crash via python_run→Interchange); shared refcounted
`FHaybaMCPClientConnection` + `bAlive` (late response never writes a freed
socket); `ResponseGeneration` vs stale idle deadlines; `HaybaMCPGameThread.h:7-27`
— best comment in the repo, names three bugs caused by handlers not believing
"you are already on the game thread". `RunSync` deliberately leaks the FEvent
on timeout (`:47-52`) — correct. But `HaybaGameThread::Run*` has **2 call
sites** in handlers: the seam is nearly unused because the invariant made it
mostly unnecessary.

Long/blocking work still on the game thread:
1. **`HaybaMCPRenderHandler.cpp:280` — a `Sleep()` poll loop up to
   TimeoutSeconds.** Comment `:236-249` admits it. Freezes DrainPendingCommands
   and every other client. **Worst offender.**
2. `HaybaMCPAssetHandler.cpp:222` — `GetAllAssets` whole-project walk
   (= critique F1a).
3. **67 `LoadObject<>`/`TryLoad`** sites — synchronous package loads inside a
   4-per-tick drain.
4. 18 `SavePackage` sites — synchronous disk writes.
5. BuildHandler's `Sleep(0.05)` is fine — it runs on a background task.

Three handlers hit the no-deferred-response wall and invented three answers:
job registry (Build), poll-snapshot (Idle — comment names the deadlock and UAF
of the previous attempt), block-the-thread (Render). One missing interface
case.

## 3. Slate UI layer

Panels get data by **three mechanisms with no policy**:
1. Router pushes into panels via a hardcoded `if/else if` chain
   (`HaybaMCPCommandHandler.cpp:1494-1503`), plus **four commands
   special-cased before dispatch** (`:1197-1272`) to reach panel statics.
2. Module-singleton reach-through (6 files:
   `GetModulePtr<FHaybaMCPModule>` → `->ToolStreamPanel.Pin()`).
3. Delegates (the good path, minority): `OnToolCallRecorded`, `OnPlanApproved`,
   6 typed streaming delegates in `HaybaMCPAgentClient.h:80-85`.

Model/view separation exists only in `Studio/HaybaStudioModel.h` and
`Slivers/HaybaSliverTypes.h`+`HaybaSliverLoader.h` (both correct — the
template). ChatPanel (1322) and ToolStreamPanel (760) hold application state
as widget members — history dies with the widget.

`FHaybaMCPStyle` is correct but vestigial: used 18× vs `FAppStyle` 100× vs
**47 inline `FLinearColor` literals in panels**. No token layer. (This is the
C++-side confirmation of critique §E; W4 lands the tokens here.)

## 4. Security / safety

`ProcessCommand` chokepoint order: id/cmd → auth → **four inline commands
(bypass Plan Mode, transaction, SEH, advisory, journal)** → Plan Mode gate →
lookup w/ self-healing `RebuildCommandMap` → transaction (PIE skip) → **SEH
guard around dispatch (`:1400-1440`, all 33 handlers)** → crash path skips all
post-processing (`:1443-1460`, cites the 2026-08-09 double-fault) →
`bEffectiveOk` payload classification (`:1465-1477`) → journal → final
redaction.

- Redaction: 872 lines, **three independent boundaries** (TCP envelope,
  journal, `ui_tool_stream` — each with a comment naming the leak it closes).
- Journal: hash-only by construction; `HashParams` = SHA-1 over key-sorted
  condensed JSON.
- Capability token: empty ⇒ fail-open by documented design; comparison is
  **not constant-time** (marginal on loopback).
- **No known-crasher gate in C++** — that gate is TS-side
  (`src/tools/guards/known-crashers.ts`); C++ has recovery (SEH) and the
  render lease instead.
- `PlanModeToolCallCount++; S.Save()` writes settings to disk **on every
  command** inside the drain (`:1330`).

## 5. Cross-cutting duplication (counted)

| Pattern | Count | Helper exists? |
|---|---|---|
| Raw `TryGet*Field` | 478 | yes, unused |
| Ad-hoc `Err()` prose | ~800 | no |
| "required/missing" spellings | 54 (~6 variants) | reader does it once |
| `GetEditorWorldContext().World()` | 41 | no |
| `TActorIterator` scans | 30 | no |
| Actor-lookup-by-label reimpls | **≥8, 3 semantics variants** | no |
| SavePackage w/o verify | 18 vs 1 verified | yes, unused |

Actor lookup: three accept name-or-label, four label-only, one path-or-label;
label collisions are silent first-match everywhere.

## 6. Satellite module seam — cleanest seam in the project

`HaybaMCPGASModule.cpp` (45 lines): `LoadModuleChecked` →
`RegisterExternalHandler`; optionality lives in `.uplugin` deps (no
preprocessor); symmetric unregister; survives Live Coding via
`RebuildCommandMap`. **Keep exactly as is** (matches ADR-0008).

Problems: (a) `HaybaMCPNiagara/` and `HaybaMCPSequencer/` are **orphaned
build artifacts** — DLLs + Intermediate, no `.uplugin`, no `Source/`;
(b) core handlers use a different registration path (33-line hand list,
`HaybaMCPModule.cpp:159-205`) than satellites — two paths, one interface.

## Ranked top-10 improvements

1. **Deferred-completion case on `IHaybaMCPHandler`** — `EHaybaResultKind
   {Ok, Err, Deferred}` + completion handle; the TCP reservation machinery
   (`TcpServer.h:41-46`) already supports it. First cut: Deferred may not open
   a transaction; long mutating ops keep the job registry. Risk: medium-high.
2. **Kill the RenderHandler game-thread Sleep** — rebuild on the Idle
   ticker-predicate pattern + the existing `HaybaRenderSafety::FLease` stages.
   Risk: medium.
3. **Delete thin `HaybaParams::` wrappers; `FHaybaParamReader` is the only
   door** — migrate top-4 handlers first (275/478 sites). Risk: low, mechanical.
4. **One `HaybaSceneQuery` module** — uniform label/name/path resolution, one
   not-found message, ambiguity = error (currently silent first-match).
   Risk: low; behaviour fix.
5. **Retire the router's inline special cases** — one
   `OnCommandCompleted(Cmd, Params, Data, bOk)` multicast panels subscribe to;
   move the four inline commands into a `FHaybaMCPUIBridgeHandler`
   (`hayba_propose_plan` stays the sole documented exception). Risk: low-med.
6. **Split UIHandler (4018) and PIEHandler (3259)** via the Ops recipe —
   grow `HaybaUIOps`/`HaybaPIERuntimeOps`; target no handler over ~800 lines.
   Risk: medium, incremental.
7. **Centralise the mutation contract** — `HaybaMutation::SaveAsset` = dirty +
   save + registry read-back verify + canonical "changed in memory, not on
   disk" message; feeds `save_verified` (already protected by
   `NeverDropTopLevelFields`). Risk: low.
8. **Slate token layer + model tier** — named tokens in `FHaybaMCPStyle`
   (sweep 47 literals — this is W4's landing zone); extract `FHaybaChatModel`
   / `FHaybaToolStreamModel` owned by the module (fixes history-dies-with-tab,
   prerequisite for W7.4 chat persistence). Risk: low/medium.
9. **Bound unbounded game-thread work** — `HaybaAssetAccess::Load` wrapper
   with duration advisory; `GetAllAssets` → filtered `GetAssets(FARFilter)`;
   `MaxCommandsPerTick` becomes time-budgeted. Risk: low. (Extends W1a.)
10. **Unify handler registration + delete orphan satellite dirs** — core list
    calls `RegisterExternalHandler` too; delete or restore
    `HaybaMCPNiagara/` and `HaybaMCPSequencer/`. Risk: very low. **Best
    value-per-effort on the list.**

## Load-bearing — do not break

The SEH-at-dispatch seam + skip-post-processing crash path; `bEffectiveOk`
payload classification; router-owned transactions with the PIE skip;
FTSTicker drain (never revert to AsyncTask); refcounted connection + `bAlive`
+ `ResponseGeneration`; `RebuildCommandMap` Live Coding ergonomics; the async
job registry (`RestoreRunningJob` included); the hash-only journal; the three
redaction boundaries (do NOT collapse into one); `NeverTrimFields` /
`NeverDropTopLevelFields`; AssetGuard's refuse-not-prompt policy;
`HaybaRenderSafety::FLease`; the Ops recipe + its 35 test files;
`HaybaStudioModel` / `SliverTypes`+`SliverLoader` as MV templates; and the
comment culture itself — comments cite dated incidents and name the failure
they prevent; a refactor that discards them loses more than it gains.
