# `test_run` SEH double-fault incident — 2026-08-09

## Trigger

After a UE 5.8 Live Coding patch, invoke `test_run` with a category selector that resolves to an
existing Hayba test (`Hayba.MCP.Params`). The handler raised a structured exception. The global
SEH seam logged that the editor was kept alive, then normal command post-processing continued.

## Observed failure

The very next post-processing step called `FHaybaMCPSecurityManager::HashParams`. UE terminated
with `EXCEPTION_ACCESS_VIOLATION` in `TJsonWriterFactory::Create`; the call stack ended at
`FHaybaMCPCommandHandler::ProcessCommand` line 1000. Crash evidence is preserved in the Aphrosia
host under `Saved/Crashes/UECC-Windows-E9C277DF4F34C1310A027CB36210F06F_0000` and the 03:38:32–38
UTC portion of `Saved/Logs/Aphrosia.log`.

## Product conclusion

An SEH guard cannot claim recovery and then execute the normal allocation-, transaction-, UI-,
and serialization-heavy tail. Native handler state may be invalid even when the guard regains
control. The old log message was factually false for this incident.

## Containment

- Compute the deterministic params hash before native dispatch.
- If the handler faults, cancel any open editor transaction, write only the minimal journal entry,
  return an error immediately, and skip every normal post-processing stage.
- Tell the caller that the session is suspect and needs restart.
- Keep a source contract test that prevents the early-return gate from being removed.

This containment does not explain the first handler fault. A clean UE 5.8 build/restart and a
repeated category-run test remain mandatory before `test_run` can be called reliable.

## Follow-up: do not re-enter automation discovery from an automation test

The first native contract test for category selection called `test_list`/`test_run` from inside
its own `RunTest`. Those handlers call `SetRequestedTestFilter` and `GetValidTestNames`; re-entering
that discovery surface while `FAutomationTestFramework` is executing is not a valid test seam and
caused the editor to disappear immediately after its async job began. The contract test now covers
pure selector/validation functions only. Live runner probes must target ordinary tests that do not
invoke the runner or discovery recursively.

## Follow-up: result evidence must survive response limits

The shared job registry stored `test_run` results as a JSON string in the generic `output` field.
The command response builder caps ordinary strings at 512 characters, so a large green run could
hide its final counts and every failing name behind truncation. `FinalizeTestRun` now records
explicit pass/fail/skip counts and a strict `all_passed` value. `build_status` parses test output,
promotes those scalar counts to top-level fields, and returns a bounded structured `test_results`
object. Missing job ids, unknown jobs, and malformed structured results fail at the handler
boundary rather than returning a successful envelope containing an inner `ok:false`.

Live UE 5.8 evidence after the patch:

- `Hayba.MCP.Params.Reader`: passed before the structured-reporting patch.
- `Hayba.MCP.TestSelection.SelectorsAndFailuresAreTruthful`: passed after the patch with
  `passed_count:1`, `failed_count:0`, `skipped_count:0`, and `all_passed:true` visible directly in
  `build_status`.
- Empty and unknown `build_status` job ids returned handler errors, not successful envelopes.
- The earlier full `category:"Aphrosia"` run completed with registry exit code `0` and 331 detailed
  log entries, but it predates the untruncated scalar response and therefore is not the final clean
  release proof.

At 04:09 UTC the unattended host process exited without a new crash artifact or shutdown tail,
before a subsequent full-category request reached the editor log. The cause is unproven; do not
attribute it to `test_run`, and do not waive the clean-build/relaunch full-category rerun.

Final clean-process evidence after rebuilding the base UE 5.8 DLL (not a Live Coding-only patch):
`category:"Aphrosia"` selected 331 tests and completed with `passed_count:331`,
`failed_count:0`, `skipped_count:0`, `all_passed:true`, and 109.08 seconds elapsed. A prior clean
run of the same suite also returned 331/0/0 in 101.18 seconds. The runner now resolves registered
names once from its discovery snapshot rather than rediscovering the entire engine catalogue for
each selected test. Hayba's serial TypeScript suite finished at 167 files / 1,674 tests passing;
UE 5.7 and UE 5.8 clean editor builds both linked successfully.
