# Editor survival and native/live acceptance matrix

This runbook separates the generic hostile transport/crash gate from positive
asset mutations. The generic suite must never be pointed at a user project. It
requires both `-ConfirmDisposableProject` and an adjacent
`.hayba-disposable-project` file whose complete trimmed content is
`HAYBA_DISPOSABLE_PROJECT_V1`. There is no keep-editor mode: launch owns and
tears down the target; attach additionally requires `-TakeOwnership`.

No Unreal process was launched, connected to, or stopped while preparing this
matrix. A later operator must record the exact engine/editor executable,
project path, source/artifact attestation, loaded plugin binary hashes,
RHI/adapter hashes, active transport-limit snapshot, survival JSON, JUnit,
editor log, crash-directory snapshot, and native automation report together.
The harness refuses to start hostile traffic until the operator supplies either
a clean exact source commit plus the expected SHA256 of every loaded Hayba DLL,
or a bounded exact artifact manifest containing the same commit and DLL map.
Hashes collected after launch are evidence, not an expectation: accepting them
without comparison would let a stale binary prove the wrong tree.

## Executable order

1. On a clean worktree, run the TypeScript contract tests and typecheck.
2. Build the plugin for the exact engine recorded in the evidence bundle. Do
   not accept a source-only proof. Compute the expected DLL SHA256 values before
   launch and pass them to the harness; it requires the loaded module set and
   every hash to match exactly.
3. Run native automation (`Hayba.MCP`) in a fresh disposable editor and archive
   its Automation report plus log. At minimum retain the transport frame/read,
   Python policy, parameter, editor-state, response-builder, render-safety,
   redaction, mutation, idempotency/advisory, and UMG GUID-invariant results.
4. Run `test-editor-survival.ps1 -List` and compare its case catalog and pending
   matrix with this document.
5. Preconfigure Plan Mode only in the marked disposable project's settings and
   restart it before the hostile run, or provide a real operator-approved plan.
   The harness deliberately refuses to disable, bypass, or auto-approve Plan
   Mode, and treats `plan_mode_required` as a hard, diagnostic gate failure.
6. Run a launch-mode canary against a fresh marked project. Accept it only when
   `canary_detects_editor_exit` passes and evidence includes
   `ordinary_gate_would_fail: true` and `ordinary_gate_exit_code: 1`.
7. Restore/recreate the marked project. Run the ordinary launch-mode suite with
   JSON and JUnit output paths. Any forced cleanup, state/filesystem/crash/log
   delta, identity change, nonce mismatch, listener-owner change, or failed case
   fails the gate.
8. Recreate the project again before each opt-in positive matrix below. Capture
   before/after object state and delete every created artifact. Do not add these
   positive mutations to the generic suite.

Representative invocation shape (replace every placeholder; never reuse a
valuable project):

```powershell
pwsh ./mcp-tools/hayba-mcp/scripts/test-editor-survival.ps1 `
  -EditorExe '<absolute UnrealEditor.exe>' `
  -ProjectPath '<absolute disposable .uproject>' `
  -ConfirmDisposableProject `
  -ExpectedSourceCommit '<exact 40-hex clean HEAD>' `
  -ExpectedPluginDllSha256 'UnrealEditor-HaybaMCPToolkit.dll=<64-hex SHA256>', 'UnrealEditor-HaybaMCPGAS.dll=<64-hex SHA256>' `
  -OutputJson '<absolute evidence.json>' `
  -OutputJUnit '<absolute evidence.xml>'
```

For a separately produced artifact, replace both `-ExpectedSourceCommit` and
`-ExpectedPluginDllSha256` with `-ExpectedArtifactManifest <manifest.json>`.
The JSON schema is deliberately small and bounded:

```json
{
  "schema_version": 1,
  "source_commit": "<40 hex>",
  "plugin_dll_sha256": {
    "UnrealEditor-HaybaMCPToolkit.dll": "<64 hex>"
  }
}
```

List every Hayba satellite DLL the editor will load. Extra loaded modules,
missing expected modules, partial hashes, paths in place of filenames, a dirty
direct-attestation worktree, and any mismatch are hard failures.

Run the same command with `-CanaryKill` first for step 6. Do not supply a PID
for launch mode. A successful canary invocation exits `0` because it correctly
detected the intentional death of its owned disposable editor; its evidence
records `ordinary_gate_simulated_exit_code: 1` to prove that the same process
exit in ordinary survival mode is a hard failure. A canary that misses the exit
returns `1`. Attach mode is intentionally ownership-transferring and needs both
the exact tagged process data and `-TakeOwnership`.

## Coverage and pending acceptance

| Issue | Generic/native evidence | Additional opt-in live acceptance |
|---|---|---|
| #18 | Not covered by hostile suite | MetaSound create/add/connect/set/compile/list readback, then cleanup and filesystem/crash/log proof. |
| #365 | Framing, strict UTF-8/NUL/nesting, total read deadline, disconnect recovery, native non-allocating response admission, exactly-once lifecycle reservations, and coupled per-client/global outbound-memory leases retained through send completion | Execute `Hayba.MCP.Transport.OutboundAdmissionAndAccounting` from the attested DLL, then hold a real reader stalled through the send deadline and prove a fresh ping succeeds. |
| #366 | Fatal-pattern rejections, bounded Python execution, denied and self-cleaning allowed Tier-3 filesystem probes, per-case Python nonce | Run the documented live tier matrix from the Python crash-policy audit in a recreated disposable project. |
| #367 | Typed malformed parameter cases plus native centralized reader tests | Add live handler-specific boundary cases only when their fixtures are self-cleaning. |
| #368 | PIE start/stop transitions with baseline state and nonce recovery | Exercise any remaining PIE input/world-context cases in the dedicated PIE acceptance run. |
| #369 | Source/native atomicity contracts only | Blueprint, DataAsset, level, and material mutations with before/after rollback proof and cleanup. |
| #370/#371 | Source/native ledger and advisory state contracts only | Real-handler advisory classification plus persisted verbosity transitions, restart/readback, and cleanup. |
| #383 | Source/native bounded redaction contracts only | Unique sentinels through journal, log, panel, MCP, and report surfaces; prove absence without recording the secret itself. |
| #387 | Source/native render/RHI lifecycle contracts plus benign nonce health | Real-RHI camera, UMG, and viewport rendering; cancel/disconnect/overlap and render-then-graceful-quit, recording RHI/adapter. |
| #406 | Source/native UMG GUID-invariant contracts plus benign nonce health | Every UMG mutation and deliberately inconsistent disposable fixtures; prove compile-log, crash-signature, object-state, and cleanup outcomes. |

## Remaining blocker

The generic socket suite can safely discriminate input framing, connection
accounting, pipeline limits, total-frame deadlines, and disconnect recovery.
Oversized-frame size, JSON depth, connection count, and pipeline count are
derived from the active `ping.transport_limits` snapshot; configured-next-start
values and hard-coded defaults are not accepted as live evidence. Stored
response and exception diagnostics are bounded hashes only, so the #383
sentinel scan can inspect JSON/JUnit artifacts without those artifacts becoming
a new plaintext exfiltration surface.
It intentionally does not synthesize oversized handler output. The native
`FHaybaMCPOutboundAdmission` hook classifies even `MAX_uint64` without allocating
an attacker-sized string, and production measures exact UTF-8 bytes before
constructing `FTCHARToUTF8`. #365 is still live-pending: the native test must run
from the attested DLL, and an opt-in disposable-editor run must prove a real
stalled reader is disconnected at the configured send deadline, accounting
returns to zero, and the next valid ping succeeds.
