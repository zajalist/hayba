# P0 Deploy A: historical product handoff

This document records Deploy A product behavior and historical gate evidence. It is not a completed deployment or P0 acceptance claim. For the current candidate contracts, see [Deploy B preparation](HANDOFF-p0-deploy-b-consumer.md). Release policy is in [Versioning](../VERSIONING.md).

## Historical provenance and verification status

Historical public product source is `e3ca9b629b654f88a4802be0a38e89ad1d7967a0` on `fix/p0-safety-public`, associated with `p0-deploy-a` and `v0.4.0-rc.1`.

The historical record reports standalone BuildPlugin, two host builds, 42 manifest test names (108 total successes, zero failures), RealPIE and the TypeScript gate. Scratch-host ladder A1, A2, A4, A5, A6 and A7 were recorded as passing. These are historical measurements, not reruns against the current B candidate.

**A3, A7b and A8 remain pending manual verification:** user PIE refuses agent mutations and cannot be driven/stopped by agents; the person sees the fault notification and Play is refused; restarting clears unsafe state. Consumer handoff approval and verification are also pending. Deploy A is not main-finalized, and this record does not claim the full A1–A8 ladder passed.

## Sticky unsafe handling

After a contained native/Python fault, the faulting command reports `native_fault_contained`. Subsequent commands outside the cause-specific allowlist receive `editor_unsafe_restart_required` until the editor restarts. Writes, Python, saves, compiles and PIE are refused. Some reads remain available after ordinary contained faults; after a stranded package save or swallowed engine fatal (`HCR-NATIVE-004`), only the narrower status/log allowlist remains. A command being a read does not itself place it on the unsafe allowlist.

The person at the editor receives a persistent notification. An ordinary contained-fault notification directs the user to save and restart; a stranded-save/engine-fatal notification instead says **do not save; restart now**. A damaged process can still crash at later GC. Notification is time to act, not proof that the process recovered. The user's Compile button is not vetoed by P0.

Unsafe state has no clear command, runtime switch or Play override. Running batches stop when unsafe is detected without executing further steps, unloading regions or collecting garbage. See [Sticky editor unsafe](../adr/0011-sticky-editor-unsafe.md#decision).

## Editor state and PIE

`editor_get_state {include_dirty:false}` reports `pie` (`none`, `user` or `agent:<owner>`), `pie_running`, `building`, `compiling`, `shader_jobs`, `saving` and health fields. Running and queued PIE both activate the guard.

- Commands outside the PIE-safe sets receive `pie_active` before running; resend only after PIE is `none`.
- Nobody drives or stops user PIE. Only the owning agent drives an agent PIE; any caller may stop an agent PIE, with a warning naming both owners.
- `editor_start_pie` reports `pie_blocked` with the loaded Blueprints to fix instead of queuing a modal.
- Running `editor_batch` jobs pause during PIE and retain/renew their lease. New batches and PIE steps in batches are refused.

See [Editor state guards](../adr/0012-editor-state-guards.md#what-may-run-during-pie-fails-closed).

## Build protection and caller identity

A builder marks assets busy by holding exclusive `asset:<path>` leases, with a stable owner and a label identifying the build. Release claims reliably when the build ends, and before requesting PIE. `editor_get_state.building` reports asset X claims regardless of label.

`editor_start_pie` and save-and-quit count any owner's asset X claims, including the caller's own, except in lease enforcement Off. Asset-targeted compile/save checks another owner's claim: refusing enforcement modes answer `asset_busy`; Advisory runs with `state_warning {code:"asset_busy", busy}`. The response identifies assets, owners and labels without exposing lease handles.

Deploy A used Advisory lease enforcement and deleted bound leases on socket close. Its server could close a socket after five seconds idle, so historical clients needed same-socket keepalive traffic during idle work and reacquisition after reconnect. **This is an A-only limitation.** Deploy B introduces orphan grace and explicit renewal; use the [current lifetime contract](HANDOFF-p0-deploy-b-consumer.md#lease-lifetime).

Use stable `HAYBA_AGENT_ID` for a Node MCP caller. Plugin and Node server must come from matching product source/build provenance. Rebuild/restart integrations in their own authorized closed-editor window; install optional satellites only where supported and required. No deployment operation is authorized by this historical document.

## Known limits and safe reads

These 18 read-like commands are classified as reads and PIE-safe: `wait_for_idle`, `wait_for_shaders`, `asset_validate`, `material_validate`, `mesh_audit`, `mesh_list_dynamic`, `mesh_topology_stats`, `metasound_inspect`, `metasound_list`, `pcg_export_graph`, `pcg_read_node_output`, `pcg_validate_graph`, `placement_validate`, `scene_export`, `scene_validate_physics`, `texture_audit`, `ui_measure_text`, `copilot_get_key`. Their read classification does not bypass sticky unsafe restrictions. Commands outside the explicit read sets fail closed, irrespective of their names.

Historical A Python map saves could open a modal when the map was read-only. This is not current B guidance: B scopes unattended behavior around plugin Python execution and returns `False` for those saves. Always check save results. Hayba does not clear read-only flags.

## Portable measurement guidance

Choose an arbitrary log explicitly; retain actual session evidence locally. This example reads only the caller-provided file and makes no deployment or verification claim:

```powershell
param([Parameter(Mandatory=$true)][string]$LogPath)
function Count-Occurrences($hits) {
  $n = 0
  foreach ($h in $hits) {
    if ($h.Line -match 'repeated (\d+) more times in 30 s') { $n += [int]$Matches[1] }
    elseif ($h.Line -match '\(\+(\d+) identical in the previous 30 s\)') { $n += 1 + [int]$Matches[1] }
    else { $n += 1 }
  }
  $n
}
$lines = Get-Content -LiteralPath $LogPath
$processing = @($lines | Select-String 'Processing command: (\S+) \(')
$refusals = Count-Occurrences ($lines | Select-String 'editor_unsafe_restart_required')
"commands: $($processing.Count); unsafe refusal occurrences: $refusals"
```

First-hit warning lines count 1; `(+N identical in the previous 30 s)` counts 1 + N; `repeated N more times in 30 s` counts N. Do not count summary lines as additional first hits.

- M4 compares post-fault dispatch/refusal records against the **cause-specific** unsafe allowlist. Dispatch is not acceptance, and unmatched records require inspection rather than a pass claim.
- M5 uses the exact names printed by `Hayba.MCP.State.PieSafeDrift` for that build, plus lease commands and the distinct PIE-owner rules. A non-owner drive refusal is not evidence that a Refuse-rule mutation ran. Include repeat summaries drained after a PIE window closes.
- M6a/M6b pre-play compile candidates require contemporaneous `building` state; proximity to a PIE start alone is insufficient.
- M7 includes crashes after contained faults even when the user was warned. List crash/session counts and recent commands; report a rate only after at least 60,000 commands over the observation period.
- M8 compares each fault frame to its subsequent notification frame: notification must arrive no later than one frame after the fault. Human visibility remains a separate manual check.

These are measurement rules, not current measured outcomes. Keep project-specific logs, integration procedures and deployment provenance in their separately maintained integration records.
