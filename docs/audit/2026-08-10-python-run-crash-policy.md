# `python_run` crash policy and recovery gate

Issue: [#366](https://github.com/zajalist/hayba/issues/366)

`python_run` executes on Unreal Editor's game thread. It is therefore an
escape hatch only for bounded, one-shot editor work—not for process control,
world replacement, background work, blocking I/O, or lifetime registration.

## Authority and override semantics

The authoritative policy lives in
`FHaybaMCPPythonHandler::Run`. The TypeScript table in
`tools/guards/known-crashers.ts` is an early-feedback mirror only; direct TCP
callers and stale MCP servers still meet the native boundary.

`allow_unsafe:true` has exactly one meaning: it may override the Tier-3
filesystem/subprocess sandbox. It never overrides a rule with an `HCR-*` crash,
deadline, lifetime, world-switch, native-memory, exit, or deadlock code.

Every fatal refusal contains:

- a stable `HCR-<FAMILY>-NNN` code;
- the matched rule;
- a safe alternative;
- `Retry unchanged: forbidden`;
- an explicit statement that `allow_unsafe` cannot bypass the crash guard.

## Historical crash evidence

The crash archive under `Aphrosia/Saved/Crashes` contains five unique sessions
where `python_run` is the final logged MCP command and an engine failure begins
on the next tick. Four immediately browse/load a map while PIE is active, then
fail because the old world was retained or the replacement PIE world was
already initialized. Those incidents ground `HCR-WORLD-001`.

The fifth (`UECC-Windows-2229ECCF40FF3C5ECDFD9D82FFF69972_0000`) immediately
shows six `CourtierCardItem` object identities twice in
`ItemsWithGeneratedWidgets`, then terminates at `SListView.h:1154`. Raw
`ListView` item setters/additions and direct `list_items` property writes are
therefore `HCR-UI-001`; the recovery is a typed handler that validates UObject
identity uniqueness before one refresh.

No crash context contains a Python frame in its native call stack. Attribution
here is deliberately limited to command adjacency plus the immediate engine
transition recorded in the log; the policy does not claim a Python stack that
the evidence does not contain.

## Bounded execution

Scripts are capped at 256 KiB. Python bytecode receives a five-second
cooperative trace deadline. On expiry the wrapper restores the trace hook,
captures the timeout, and returns `HCR-TIME-001`.

There is deliberately no attempt to terminate the game thread. Unreal native
calls and Python C-extension calls do not yield to `sys.settrace`; forcibly
killing them would corrupt editor state. Known blocking/native entry points are
therefore rejected before execution. New native blockers belong in preflight,
not in a more aggressive watchdog.

Calls that disable tracing/profiling are themselves forbidden. The deadline is
defense in depth for accidentally expensive Python bytecode, not a promise that
arbitrary hostile native code can be interrupted safely.

The incident-driven native denylist is intentionally a bounded mitigation, not
a proof that arbitrary in-process Python is safe. Unknown Python/C-extension
calls can still block or fault without returning to the trace hook. Issue #392
owns the complete trust-boundary fix: move untrusted execution into a disposable
process and communicate only validated results back to the editor.

## Regression gates

- `PYTHON_CRASH_RULES` is table-tested through the registered TypeScript handler
  with `allow_unsafe:true`; no rejected case may contact Unreal.
- `Hayba.MCP.Python.FatalPolicy` feeds every fatal example only to the pure
  native source-policy matcher. A matcher regression must fail the test; it must
  never execute `abort`, `kill`, map replacement, or another destructive probe
  in the serving editor.
- `Hayba.MCP.Python.PolicyBoundary` covers the size ceiling and normalized
  Tier-3 classification.
- Asset connector imports submit multiline source directly. They no longer hide
  code in `exec(<string>)`, which would correctly trigger `HCR-DYNAMIC-001`.
- The unused TypeScript print-redirection wrapper was removed for the same
  reason: it exported a helper that converted visible source into
  `exec(compile(...))` even though the native handler already captures output.

Adding a historical crash signature requires all of the following in the same
change: a C++ fatal rule, its TS mirror, a direct C++ example, a TS example, and
either a disposable-editor survival case or a written waiver explaining why
executing the case cannot be made safe even in the disposable harness.

## Required live evidence before closing #366

Run only in a tagged disposable editor owned by the survival harness—never in a
user editor:

1. Record the PID, listener port, crash-artifact baseline, PIE state, and dirty
   packages.
2. Send one case from each fatal family directly over TCP with
   `allow_unsafe:true`.
3. After every refusal, send benign `python_run` code that prints a nonce.
4. Run an accidental long bytecode loop and observe `HCR-TIME-001`, then send
   another benign nonce.
5. Run a Tier-3 filesystem operation without the override (rejected), then an
   isolated scratch-file operation with `allow_unsafe:true` (permitted and
   cleaned up).
6. Verify the same PID and listener survived, no new crash artifact appeared,
   PIE/dirty-package baselines are unchanged, and the scratch file is removed.

The live gate is pending whenever an untagged user-owned editor is running or a
fresh plugin build has not completed. Static tests do not substitute for this
evidence.
