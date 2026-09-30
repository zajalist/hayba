# Hand-off: P0 Deploy A to the consumer (sticky editor_unsafe, PIE and build guards)

For the consumer's session, to act on in its own closed-editor window. Hayba never builds into, launches or edits `<project>`. Design: `docs/superpowers/specs/2026-09-28-p0-safety-train-design.md` (§5.1, §7.2, §7.4).

## 1. What ships

| | |
|---|---|
| Tag | `p0-deploy-a` (and `v0.4.0-rc.1`, see `docs/VERSIONING.md`) → `e3ca9b62` on `fix/p0-safety-public` |
| Deploy branch | `<deploy-branch>` at `1cdf1f2c`. |
| Node | `mcp-tools/hayba-mcp/dist` built from `1cdf1f2c` (§4 step 4) |
| Gate evidence | BuildPlugin, host build twice, 42 exact test names (R0+34), RealPIE, TS suite, live ladder A1–A8 |

- **Sticky `editor_unsafe` (T1).** After a contained native fault, Hayba refuses writes, Python, saves, compiles and PIE with `editor_unsafe_restart_required` until the editor restarts. Reads still answer. After an engine fatal during a save (`HCR-NATIVE-004`), only status commands answer: `ping`, `editor_get_state`, `lease_status`, `lease_release`, `batch_status` and the logs. The person at the editor gets a persistent notification within one frame, and the Play button is refused until the restart.
- **Editor state and PIE (T2).** `editor_get_state` reports `pie` (`none` / `user` / `agent:<owner>`), `pie_running`, `building`, `compiling`, `shader_jobs`, `saving` and the health fields, and takes `include_dirty:false`. While a PIE runs or is queued, anything that is not PIE-safe gets `pie_active`, which is safe to resend once `pie` is `none`. Nobody drives or stops a user PIE. Anyone may stop an agent PIE, and that logs a Warning naming both owners. `editor_start_pie` answers `pie_blocked` instead of opening a modal when a loaded Blueprint is in error. `editor_batch` pauses during PIE.
- **Build guard (T3).** `editor_start_pie` answers `asset_busy` while any owner, the caller included, holds an `asset:` X lease. Asset compiles and saves answer `asset_busy` while another owner builds that asset.

There is no runtime switch for the unsafe gate, the `pie_active` guard or the unsafe Play veto (by design). Lease enforcement stays `Advisory` in Deploy A.

## 2. Preconditions before the window

1. **The user knows what the notification means.** It reads either:
   - `Hayba contained a native fault in '<cmd>'. Save now (File > Save All) and restart the editor. Do not compile, press Play or load a map before restarting.`
   - `Hayba contained an engine fatal error in '<cmd>' during a package save. Do not save; restart the editor now. Saving in this state can crash the editor or write a corrupt package.`

   After a Python fault the next garbage collection (a Blueprint compile, Play, or about 61 s of ticking) can still crash the editor. The notification buys time to save; it does not prevent that crash.
2. **Recommended: the bpgraph build lease (D5).** Without it nothing marks a build busy, and `asset_busy` never fires (M6a stays at baseline).
   - `bpgraph.mjs` acquires **one** lease covering every spec asset (`asset:<path>` X for each, at most 32 resources) on its persistent socket: `bind_connection:true`, lane `long`, label `build:bpgraph_<pid>`, envelope owner `HAYBA_AGENT_ID`. It releases in `finally`; a socket close drops the lease anyway.
   - Without `HAYBA_AGENT_ID`, bpgraph exits 2 with `set HAYBA_AGENT_ID to the gate owner`. It never queues behind its own lane's global lease.
   - **Keep the socket busy.** Until Deploy B the editor closes a connection idle for 5 s and deletes its bound leases. While otherwise idle (a PIE wait, a long compile), bpgraph sends `ping` at least every 2 s on the same socket. After any reconnect it re-acquires before the next write.
   - bpgraph never sends `editor_start_pie` while it holds build leases. It releases them first, because its own PIE would get `asset_busy`.
3. **Rule until Deploy B: no `editor_gate.py acquire --scope asset:…`.** Such a lease cannot be released before Deploy B (the handle is still redacted, and `release` prints "already lapsed"). It would keep refusing `editor_start_pie` with `asset_busy` for up to 900 s.
4. **Rule until Deploy B: check the map file before a Python map save.** A Python map save on a read-only map (`unreal.EditorLevelLibrary.save_current_level()`, `unreal.EditorLoadingAndSavingUtils.save_map(...)`, the scripted load-save-unload pattern, or `save_packages` on a map) still opens a modal dialog on the game thread, and every lane stalls until a person clicks OK. Deploy B makes those calls return `False` instead. Until then, every host script that saves a map from Python first runs this check, and skips the save (or takes the lock first) when it fails:

   ```python
   import os, pathlib
   PROJECT = pathlib.Path(r"<project>")

   def map_is_writable(package_name):  # for example "/Game/Maps/Main"
       path = PROJECT / "Content" / (package_name.removeprefix("/Game/") + ".umap")
       return (not path.exists()) or os.access(path, os.W_OK)
   ```

   The check runs in the host script, outside the editor, before it sends the `python_run` that saves.

   Asset saves (`unreal.EditorAssetLibrary.save_*`) already fail softly and return `False`; keep checking that return value.

## 3. Host changes (§5.1, recommended; nothing breaks without them)

The host-kit files (the gate script and its test) ship to the consumer team **separately**, out of band from this public repo, from the private kit commit `c8f6f82`. That kit is a tested, reviewed patch on the consumer's existing `editor_gate.py`; its own README carries the apply-and-test steps and the exact pytest count to expect. Do not hand-copy the gate script from memory or from this document — install it from that kit, and do not edit it by hand: Deploy B's gate is a further patch on top of this one, and installing this kit is Deploy B's precondition.

What the kit changes:

- `hayba()` raises `HaybaError(message, code=…, detail=…)`, where `detail` is the refusal's `pie`, `busy`, `lease` or `editor_health` object, so callers branch on the code, not the text.
- `acquire`: when the editor answers, it calls `editor_get_state {include_dirty:false}` first. If `editor_unsafe` is set, or a renew or acquire is refused with `editor_unsafe_restart_required`, it prints `unsafe: fault contained at <health.faulted_at_utc> in <health.faulted_command>; restart the editor` and exits 4. It never re-queues and never falls back to the file lock in that case.
- `pie_running()` asks `editor_get_state {include_dirty:false}` and tests `pie != "none"`. It falls back to the log scan when the editor is down or the reply has no `pie` key.
- `status` prints the health from `editor_get_state` next to `lease_status`.

The other host tools are the consumer's own files; these are the changes to make in them:

- `bpgraph.mjs`:
  - `send()` (`:770-795`) passes through `code`, `pie`, `busy`, `lease` and `editor_health`;
  - on `editor_unsafe_restart_required` or `native_fault_contained`, stop the build at once, release the gate in `finally`, and exit 4;
  - `pie_active` is preflight, so resending is safe: poll `editor_get_state {include_dirty:false}` every 2 s until `pie == "none"`, then resend; cap the wait at 30 min, then exit 6;
  - on `asset_busy`, fail that asset with its owner, label and age, and exit 3; never loop;
  - on `pie_blocked`, print the listed assets and exit 3;
  - before pass 1, refuse to start when `pie != "none"` or `editor_unsafe` is set.
- `apply_look.py` (`:113-135`): read `msg.get("code")`. Either unsafe code raises `SystemExit("editor_unsafe: …")`. `pie_active` maps to the existing PIE exit.

**Exit codes**, one table for every host tool:

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

## 4. The window

1. Announce the window to every lane.
2. `python Tools/GameFlow/editor_gate.py acquire --owner deploy` (global). Every lane stops at the gate.
3. The user saves and closes the consumer's editor.
4. Build through the existing deploy-branch path, at exactly `1cdf1f2c`:
   ```powershell
   git -C <deploy-worktree> fetch
   git -C <deploy-worktree> rev-parse --short HEAD   # must print 1cdf1f2c
   Set-Location <deploy-worktree>\mcp-tools\hayba-mcp
   npm run build:server                                            # Node dist from the same commit
   ```
   Then do the usual full editor rebuild of the consumer project with the editor closed. **Never `robocopy /MIR` into `<project>/Plugins`.** The MetaSound satellite reaches the consumer only once it is installed there (D6).
5. Start the editor. Restart every lane's MCP server so that it loads the new `dist/`.

## 5. After the restart (the consumer's session, on its own editor)

```powershell
$S = "<deploy-worktree>\mcp-tools\hayba-mcp\scripts\invoke-tcp-command.ps1"
pwsh $S -Cmd ping                                          # capabilities.editor_health = true; editor_unsafe = false
pwsh $S -Cmd editor_get_state -ParamsJson '{"include_dirty":false}'   # pie "none"; building []; health {}
python Tools/GameFlow/editor_gate.py release --owner deploy
```

Then press Play once by hand. `editor_get_state` shows `pie: "user"`, and any agent write gets `pie_active`. Stop PIE.

## 6. Rollback

There is no live switch for Deploy A's guards. Redeploy the previous deploy-branch commit, `151c55ec` (the tip before this merge), in a new window with the same procedure (§4).

## 7. Measuring (collect for 7 days after the restart)

Run in PowerShell on the consumer's editor log. Every Hayba Warning is rate-limited, so each count adds the suppressed repeats: a first-hit line counts 1; a line ending `(+N identical in the previous 30 s)` counts 1 + N; a line `… repeated N more times in 30 s …` counts N.

```powershell
$log = "<project>\Saved\Logs\<Project>.log"
function Count-Occurrences($hits) {
  $n = 0
  foreach ($h in $hits) {
    if ($h.Line -match 'repeated (\d+) more times in 30 s') { $n += [int]$Matches[1] }
    elseif ($h.Line -match '\(\+(\d+) identical in the previous 30 s\)') { $n += 1 + [int]$Matches[1] }
    else { $n += 1 }
  }
  $n
}
$lines = Get-Content $log
$processing = $lines | Select-String 'Processing command: (\S+) \('
"commands: $($processing.Count)"

# M8: every fault warned the user within one frame.
$faults = $lines | Select-String 'editor_unsafe: native fault .*?frame (\d+)\)'
$notes  = $lines | Select-String 'editor_unsafe: user notified \(cause \w+, frame (\d+)\)'
foreach ($f in $faults) {
  $ff = [int]$f.Matches[0].Groups[1].Value
  $ok = $notes | Where-Object { $_.LineNumber -gt $f.LineNumber -and [int]$_.Matches[0].Groups[1].Value -le $ff + 1 }
  "M8 fault at line $($f.LineNumber) frame ${ff}: $(if ($ok) { 'warned' } else { 'NOT WARNED' })"
}

# M4: commands dispatched after a fault that are not on the allowlist (target 0).
$allow = 'ping','editor_get_state','editor_get_output_log','editor_stream_log','lease_status','lease_release','batch_status',
  'build_status','test_get_log','get_setting','ui_tool_stream','ui_tool_stream_new_turn','test_list','test_cancel','ui_memory_set',
  'project_get_info','level_get_info','level_list','actor_list','actor_get_properties','actor_get_components','object_get_property',
  'asset_get_info','asset_search','asset_browse','asset_registry_query','asset_get_dependencies','asset_get_referencers',
  'asset_get_references','blueprint_get_info','blueprint_inspect_graph','material_get_info','material_list','mesh_get_info','mesh_list',
  'texture_get_info','texture_list','wp_get_cells','wp_get_streaming_state','docs_search','docs_lookup_api','docs_lookup_class'
if ($faults) {
  $after = $processing | Where-Object { $_.LineNumber -gt $faults[0].LineNumber -and $allow -notcontains $_.Matches[0].Groups[1].Value }
  $refused = Count-Occurrences ($lines | Select-String 'editor_unsafe_restart_required' | Where-Object { $_.LineNumber -gt $faults[0].LineNumber })
  "M4 non-allowlisted commands after the fault: $($after.Count); refusals: $refused; accepted: $($after.Count - $refused)"
}

# M5: PIE windows with accepted commands whose PIE rule is Refuse (target 0).
# A command's rule is Refuse unless it is PIE-safe, a lease_* command, or a PIE-owner command. $pieSafe is the
# list Hayba.MCP.State.PieSafeDrift printed at the gate of this build: names, never a pattern.
$pieSafe  = 'actor_get_components, actor_get_properties, actor_list, anim_blueprint_get_info, asset_browse, asset_get_dependencies, asset_get_info, asset_get_referencers, asset_get_references, asset_registry_query, asset_search, asset_validate, audio_active_sounds, audio_asset_inspect, audio_list, audio_meter_read, batch_status, blueprint_get_info, blueprint_inspect_graph, bt_get_info, build_status, copilot_get_key, copilot_key_status, data_get, docs_lookup_api, docs_lookup_class, docs_search, editor_get_output_log, editor_get_perf_stats, editor_get_performance_stats, editor_get_state, editor_pie_actor_inspect, editor_pie_actor_list, editor_pie_assert, editor_pie_project_world, editor_pie_screenshot, editor_pie_wait_for, editor_pie_widget_tree, editor_stream_log, foliage_list_types, get_node_details, get_setting, hayba_propose_plan, level_get_info, level_get_spatial_index, level_list, list_node_classes, list_pcg_assets, material_get_info, material_list, material_validate, mesh_audit, mesh_get_info, mesh_list, mesh_list_dynamic, mesh_topology_stats, metasound_inspect, metasound_list, object_get_property, pcg_export_graph, pcg_get_node_details, pcg_list_assets, pcg_list_node_classes, pcg_read_node_output, pcg_validate_graph, ping, placement_validate, project_get_info, project_get_settings, project_list_plugins, scene_export, scene_get_actor_relations, scene_validate_physics, spline_get_info, test_cancel, test_get_log, test_list, texture_audit, texture_get_info, texture_list, ui_list_widget_blueprints, ui_list_widget_types, ui_measure_text, ui_memory_set, ui_query, ui_report_findings, ui_tool_stream, ui_tool_stream_new_turn, wait_for_idle, wait_for_shaders, wp_get_cells, wp_get_streaming_state' -split ', '
$pieOwner = 'editor_pie_press_key','editor_pie_mouse','editor_pie_type_text','editor_pie_axis','editor_pie_click_widget',
  'editor_pie_set_text','editor_pie_click_actor','editor_stop_pie'
function Test-RefuseRule($cmd) { -not ($cmd -like 'lease_*' -or $pieSafe -contains $cmd -or $pieOwner -contains $cmd) }
$windows = @(); $open = $null; $last = $null
foreach ($l in $lines) {
  if ($l -match 'Creating play world package') {
    $open = @{ at = $l.Substring(0, [math]::Min(24, $l.Length)); dispatched = @(); refused = 0 }
    $last = $open; $windows += $open
  }
  elseif ($l -match 'Shutting down PIE') { $open = $null }
  elseif ($open -and $l -match 'Processing command: (\S+) \(') { if (Test-RefuseRule $Matches[1]) { $open.dispatched += $Matches[1] } }
  elseif ($last -and $l -notmatch 'PIE \(queued\)' -and
          ($l -match "pie_active: refused '([^']+)' from " -or $l -match "\[pie\] pie_active repeated \d+ more times in 30 s: .*cmd='([^']+)'")) {
    # A refusal names its command. Only a Refuse-rule command counts here: a PIE-owner command refused for a
    # non-owner is not part of M5. The drained "repeated" line of a window can print after the window closed,
    # so a refusal counts for the last window that opened.
    if (Test-RefuseRule $Matches[1]) { $last.refused += (Count-Occurrences @([pscustomobject]@{ Line = $l })) }
  }
}
$bad = @($windows | Where-Object { $_.dispatched.Count -gt $_.refused })
"M5 PIE windows: $($windows.Count); with accepted Refuse-rule commands: $($bad.Count)"
foreach ($w in $bad) {
  "M5 candidate at $($w.at): dispatched $($w.dispatched.Count), refused $($w.refused): $(($w.dispatched | Sort-Object -Unique) -join ', ')"
}

# M6a: pre-play compiles of an asset under an open build, with an editor_start_pie in the previous 5 s (target 0).
function Stamp($line) { if ($line -match '^\[(\d{4})\.(\d\d)\.(\d\d)-(\d\d)\.(\d\d)\.(\d\d)') { [datetime]::new([int]$Matches[1],[int]$Matches[2],[int]$Matches[3],[int]$Matches[4],[int]$Matches[5],[int]$Matches[6]) } }
$starts = $processing | Where-Object { $_.Matches[0].Groups[1].Value -eq 'editor_start_pie' }
$lines | Select-String 'Compiling (\S+) before play' | ForEach-Object {
  $at = Stamp $_.Line
  $agent = $starts | Where-Object { $t = Stamp $_.Line; $t -and ($at - $t).TotalSeconds -ge 0 -and ($at - $t).TotalSeconds -le 5 }
  if ($agent) { "M6a candidate: $($_.Line)  (compare with editor_get_state.building at that time)" }
}

# M7: crashes with a Hayba command in the last 10 s, per 10 000 commands (target < 0.05).
# Every crash folder holds a copy of the crashed session's log; the last stamped line is the crash time.
# The command count covers every session log of the 7 days, backups included.
$since   = (Get-Date).AddDays(-7)
$logDir  = "<project>\Saved\Logs"
$allCmds = 0
Get-ChildItem $logDir -Filter "<Project>*.log" | Where-Object { $_.LastWriteTime -ge $since } | ForEach-Object {
  $allCmds += (Select-String -Path $_.FullName -Pattern 'Processing command: ').Count
}
$crashes = @(Get-ChildItem "<project>\Saved\Crashes" -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.CreationTime -ge $since } | Sort-Object CreationTime)
$withCommand = 0; $readOnlyCrashes = 0
foreach ($c in $crashes) {
  $crashLog = Get-ChildItem $c.FullName -Filter *.log | Select-Object -First 1
  if (-not $crashLog) { "M7 $($c.Name) at $($c.CreationTime.ToString('s')): no log in the crash folder; check it by hand"; continue }
  $cl  = Get-Content $crashLog.FullName
  $end = Stamp ($cl | Where-Object { Stamp $_ } | Select-Object -Last 1)
  $recent = @($cl | Select-String 'Processing command: (\S+) \(' |
    Where-Object { $t = Stamp $_.Line; $t -and $end -and ($end - $t).TotalSeconds -le 10 })
  $fault = @($cl | Select-String 'editor_unsafe: native fault').Count
  if ($recent.Count -gt 0) { $withCommand++ }
  if (@($cl | Select-String 'as it is read only').Count -gt 0) { $readOnlyCrashes++ }
  "M7 $($c.Name) at $($c.CreationTime.ToString('s')): $($recent.Count) command(s) in the last 10 s; contained faults before it: $fault"
  $recent | ForEach-Object { "    $($_.Line)" }
}
"M7: $withCommand of $($crashes.Count) crash(es) had a Hayba command in the last 10 s; $allCmds commands; " +
  "rate $([math]::Round(10000 * $withCommand / [math]::Max(1, $allCmds), 3)) per 10 000"
"read-only save crashes (I-3 class, target 0): $readOnlyCrashes"
```

M7 needs at least 60 000 commands before its rate means anything; below that, report the listing and the two counts and no rate. A crash that follows a contained fault still counts, even when the user was warned (M8).

## 8. Verification status

The gate (build, exact-name headless test run, RealPIE, TS suite) is green: BuildPlugin standalone, the host built twice, all 42 manifest test names passing (108 total, 0 failures), `RealPIE` passing, and the TS gate clean. The live ladder A1, A2, A4, A5, A6 and A7 passed on the throwaway scratch host.

**Three ladder steps are still pending manual verification with the maintainer, at the editor itself:** A3 (a user PIE refuses agent writes, and nobody stops it), A7b (the person at the editor sees the fault notification and Play is refused), and A8 (an editor restart clears the unsafe state). This handoff is not a claim that those three are verified — the checklist to run them is recorded alongside the gate evidence. Deploy A should not be presented as fully verified until they are run and pass.

## 9. Known limits in Deploy A

- **A command outside the read sets is refused during any PIE**, whatever its name suggests. These read-like commands are reads and keep working while the user plays: `wait_for_idle`, `wait_for_shaders`, `asset_validate`, `material_validate`, `mesh_audit`, `mesh_list_dynamic`, `mesh_topology_stats`, `metasound_inspect`, `metasound_list`, `pcg_export_graph`, `pcg_read_node_output`, `pcg_validate_graph`, `placement_validate`, `scene_export`, `scene_validate_physics`, `texture_audit`, `ui_measure_text`, `copilot_get_key`. They are still refused after a contained fault, like every command outside the unsafe allowlist.
- **Asset-busy lifetimes (R-23).** Until Deploy B a bound build lease dies 5 s after its socket goes idle, so `asset_busy` protection is lost mid-build unless bpgraph pings every 2 s (§2.2). `editor_start_pie` also counts the caller's own build.
- `HAYBA_AGENT_ID` must equal the lane's gate owner for every bpgraph run (R-10). Without it, a restarted lane is a new owner.
