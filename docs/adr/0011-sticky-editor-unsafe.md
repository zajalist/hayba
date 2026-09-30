# 0011 — A contained native fault makes the editor sticky-unsafe until restart

**Status:** Accepted (2026-09-28)

## Context

Hayba catches native faults (Windows SEH) around handler dispatch and around
its Python and material calls. Until P0 it then answered the next command as
if nothing had happened. In the consumer's postmortem (I-6) a Python fault at
02:10:01 was followed by 14 accepted `python_run` calls and an
`editor_start_pie`; the editor died 12 s later in the pre-play Blueprint
compile, inside Python's `gc.collect` in the damaged interpreter, and the
person at the editor lost unsaved work. `EXCEPTION_EXECUTE_HANDLER` also
swallows `appError` (0x4000) and can abandon a package save scope, after which
any object lookup is fatal (I-3).

## Decision

- **One guard that always records.** The toolkit has exactly one `__except`,
  in `HaybaSeh::RunGuardedAt`. After the guard returns, it repairs a stranded
  play-world switch and calls `FHaybaEditorHealth::RecordCaughtFault` with the
  site and the exception code.
- **Sticky.** Only an editor restart clears the state. There is no clear
  command; automation tests swap in a fresh state with
  `FScopedOverrideForTests`.
- **Refuse by cause.** The router refuses every command outside
  `CommandsAllowedWhileUnsafe(cause)` with `editor_unsafe_restart_required`,
  before the lease gate. After a Python or native fault, status commands and a
  fixed list of reads answer. After a stranded save or a swallowed engine fatal
  (HCR-NATIVE-004), only status commands answer. The gate uses the most severe
  cause seen so far.
- **The faulting command says so.** It answers `native_fault_contained`, and
  so does a handler that caught its own fault and still returned Ok.
- **Tell the person, not only the agents.** The first fault posts one
  persistent editor notification on the next tick. A Python fault also unhooks
  Python from the pre-GC delegate. The Play button is vetoed while unsafe (T2).
- **Stop background work.** A running `editor_batch` finishes as failed at its
  next pump without running a step, unloading regions or collecting garbage.

## Consequences

- Success for a fault means the user was warned in time to save, not that the
  crash never comes. GC still reads C++ state, and the user's own Compile
  button is not vetoed in P0.
- A LogPython Error line that carries a CPython corruption marker (for example
  from `unreal.log_error`) marks the editor unsafe on purpose. The live
  verification ladder uses this; the cost is a restart that the notification
  explains. The user's stdout and the bounded traceback are never scanned.
- Every new crash-prone call must go through `HaybaSeh::RunGuardedAt` or
  `HaybaSeh::RunGuarded`. `editor-health-contract.test.ts` fails when a second
  `__except` appears anywhere in the plugin tree (ADR-0007).
- The log gains one Error line per fault
  (`[HCR-NATIVE-00x] editor_unsafe: native fault …, frame <n>)`) and one
  `editor_unsafe: user notified (…, frame <n>)` line, which M4 and M8 measure.
