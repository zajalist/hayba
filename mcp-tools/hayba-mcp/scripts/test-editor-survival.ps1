#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Adversarial MCP transport/handler tests that prove the same editor survives.

.DESCRIPTION
  This gate is deliberately process-aware. By default it launches its own
  tagged editor process and discovers the MCP port owned by that exact PID.
  Attaching to an existing process is allowed only when its command line
  contains the caller-supplied survival-session token; a bare PID is not proof
  that an editor is disposable and is therefore refused.

  Every case verifies all of these:
  the expected editor PID is alive, that exact PID still owns the listener,
  a fresh ping succeeds, and no new Unreal crash directory appeared. A safe
  `ok:false` rejection passes; a timeout, listener handoff, crash report, or
  process exit fails immediately.

  The launched editor is stopped without saving when the suite ends unless
  -KeepEditor is set. No hostile case is ever sent to an untagged editor.
#>
param(
    [ValidateRange(0, [int]::MaxValue)]
    [int]$EditorPid = 0,

    [string]$EditorExe = 'C:\Program Files\Epic Games\UE_5.8\Engine\Binaries\Win64\UnrealEditor.exe',

    [string]$ProjectPath = '',

    [string]$SessionToken = '',

    [switch]$KeepEditor,

    [ValidateRange(0, 65535)]
    [int]$Port = 0,

    # A cold UE editor can spend several minutes compiling shaders and loading
    # the host project before the plugin binds its listener.  The timeout is a
    # harness patience limit, not a per-case safety limit; hostile commands are
    # still bounded independently by MaxCaseMs.
    [ValidateRange(10000, 600000)]
    [int]$StartupTimeoutMs = 120000,

    [ValidateRange(500, 60000)]
    [int]$MaxCaseMs = 10000,

    [string]$CrashDir = '',
    [string]$OutputJson = '',
    [string]$OutputJUnit = '',
    [switch]$List,
    [switch]$CanaryKill,
    [string]$Auth = ''
)

$ErrorActionPreference = 'Stop'
$Invoker = Join-Path $PSScriptRoot 'invoke-tcp-command.ps1'
$Results = [System.Collections.Generic.List[object]]::new()
$LaunchedProcess = $null
$ExitCode = 0
$InitialCrashes = @()
$InitialDirtyPackages = @()
$FrameReadTimeoutMs = 5000
$ConfiguredMaxClients = 16
$CaseCatalog = @(
    'world_switch_new_blank_map', 'world_switch_load_map', 'self_socket_deadlock',
    'dangling_tick_callback', 'python_background_thread', 'game_thread_sleep',
    'infinite_loop', 'python_deadline_exhaustion', 'listview_duplicate_identity',
    'native_memory_escape', 'process_exit',
    'static_mesh_known_crasher', 'oversized_python_script', 'zero_length_frame',
    'oversized_declared_frame', 'truncated_header', 'truncated_body',
    'malformed_json', 'excessive_json_nesting', 'embedded_nul_frame', 'malformed_utf8_frame',
    'connection_churn', 'partial_frame_client_flood', 'slowloris_frame_timeout', 'stale_actor_path',
    'fractional_lod_index', 'wrong_typed_physics_flag', 'nonfinite_numeric_payload',
    'pie_start_transition', 'pie_stop_transition'
)

if ($List) {
    [pscustomobject]@{
        mode = 'list'
        case_count = $CaseCatalog.Count
        cases = $CaseCatalog
        canary = 'Pass -CanaryKill in launch mode to prove editor-exit detection.'
    } | ConvertTo-Json -Depth 5
    exit 0
}

function Get-SanitizedHash([object]$Value) {
    $json = $Value | ConvertTo-Json -Compress -Depth 30
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
}

function Write-SurvivalReports([object]$Report) {
    $json = $Report | ConvertTo-Json -Depth 30
    if ($OutputJson) {
        $parent = Split-Path -Parent $OutputJson
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        Set-Content -LiteralPath $OutputJson -Value $json -Encoding utf8
    }
    if ($OutputJUnit) {
        $parent = Split-Path -Parent $OutputJUnit
        if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
        $failed = @($Report.cases | Where-Object { -not $_.passed })
        $durationSeconds = [Math]::Round((($Report.cases | Measure-Object duration_ms -Sum).Sum / 1000.0), 3)
        $xml = [Text.StringBuilder]::new()
        [void]$xml.AppendLine('<?xml version="1.0" encoding="utf-8"?>')
        [void]$xml.AppendLine("<testsuite name=`"Hayba.EditorSurvival`" tests=`"$($Report.cases.Count)`" failures=`"$($failed.Count)`" time=`"$durationSeconds`">")
        foreach ($case in $Report.cases) {
            $name = [Security.SecurityElement]::Escape([string]$case.name)
            $time = [Math]::Round(([double]$case.duration_ms / 1000.0), 3)
            [void]$xml.Append("  <testcase name=`"$name`" time=`"$time`">")
            if (-not $case.passed) {
                $detail = [Security.SecurityElement]::Escape([string]$case.detail)
                [void]$xml.Append("<failure message=`"$detail`" />")
            }
            [void]$xml.AppendLine('</testcase>')
        }
        [void]$xml.AppendLine('</testsuite>')
        Set-Content -LiteralPath $OutputJUnit -Value $xml.ToString() -Encoding utf8
    }
    return $json
}

function Get-EditorCommandLine([int]$ProcessId) {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    return [string]$row.CommandLine
}

function Assert-SurvivalTag([int]$ProcessId, [string]$ExpectedToken) {
    if ([string]::IsNullOrWhiteSpace($ExpectedToken)) {
        throw 'SessionToken is required when attaching to an existing editor'
    }
    $needle = "-HaybaSurvivalSession=$ExpectedToken"
    $commandLine = Get-EditorCommandLine $ProcessId
    if (-not $commandLine.Contains($needle, [StringComparison]::Ordinal)) {
        throw "Refusing editor PID ${ProcessId}: command line does not contain the matching $needle tag"
    }
}

function Find-OwnedMcpPort([int]$ProcessId) {
    $ports = @(
        Get-NetTCPConnection -OwningProcess $ProcessId -State Listen -ErrorAction SilentlyContinue |
            Where-Object { $_.LocalPort -ge 52342 -and $_.LocalPort -le 52350 } |
            Select-Object -ExpandProperty LocalPort -Unique
    )
    if ($ports.Count -gt 1) {
        throw "Editor PID $ProcessId owns multiple Hayba-range listeners: $($ports -join ', ')"
    }
    if ($ports.Count -eq 1) { return [int]$ports[0] }
    return 0
}

function Get-CrashDirectoryNames([string]$Directory) {
    return @(
        if (Test-Path -LiteralPath $Directory) {
            Get-ChildItem -LiteralPath $Directory -Directory | ForEach-Object Name
        }
    )
}

try {
if ($EditorPid -eq 0) {
    if (-not (Test-Path -LiteralPath $EditorExe -PathType Leaf)) {
        throw "Editor executable not found: $EditorExe"
    }
    if ([string]::IsNullOrWhiteSpace($ProjectPath) -or
        -not (Test-Path -LiteralPath $ProjectPath -PathType Leaf)) {
        throw 'ProjectPath must name an existing .uproject when the harness launches the editor'
    }
    $ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
    if ([IO.Path]::GetExtension($ProjectPath) -ne '.uproject') {
        throw "ProjectPath is not a .uproject: $ProjectPath"
    }
    if ([string]::IsNullOrWhiteSpace($SessionToken)) {
        $SessionToken = [guid]::NewGuid().ToString('N')
    }
    if ([string]::IsNullOrWhiteSpace($CrashDir)) {
        $CrashDir = Join-Path (Split-Path -Parent $ProjectPath) 'Saved\Crashes'
    }
    # Snapshot BEFORE launch so an editor that dies during startup cannot have
    # its fresh crash folder mistaken for pre-existing evidence.
    $InitialCrashes = Get-CrashDirectoryNames $CrashDir

    $arguments = @(
        "`"$ProjectPath`"",
        "-HaybaSurvivalSession=$SessionToken",
        '-Unattended',
        '-NoSplash',
        '-NoSound'
    )
    $LaunchedProcess = Start-Process -FilePath $EditorExe -ArgumentList $arguments `
        -WindowStyle Hidden -PassThru
    $EditorPid = $LaunchedProcess.Id
}
else {
    if (-not (Get-Process -Id $EditorPid -ErrorAction SilentlyContinue)) {
        throw "editor PID $EditorPid does not exist"
    }
    Assert-SurvivalTag $EditorPid $SessionToken
    if ([string]::IsNullOrWhiteSpace($CrashDir)) {
        throw 'CrashDir is required in attach mode because the project path is not inferred from an arbitrary process'
    }
    $InitialCrashes = Get-CrashDirectoryNames $CrashDir
}

if ($Port -eq 0) {
    $startup = [Diagnostics.Stopwatch]::StartNew()
    while ($startup.ElapsedMilliseconds -lt $StartupTimeoutMs) {
        if (-not (Get-Process -Id $EditorPid -ErrorAction SilentlyContinue)) {
            throw "tagged editor PID $EditorPid exited before opening an MCP listener"
        }
        $Port = Find-OwnedMcpPort $EditorPid
        if ($Port -ne 0) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($Port -eq 0) {
        throw "tagged editor PID $EditorPid did not open a Hayba MCP listener within ${StartupTimeoutMs}ms"
    }
}

Assert-SurvivalTag $EditorPid $SessionToken

function Get-ListenerOwner {
    $owners = @(
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    if ($owners.Count -ne 1) {
        throw "Expected exactly one listener on port $Port; found $($owners.Count)"
    }
    return [int]$owners[0]
}

function Invoke-HaybaCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [hashtable]$Params = @{}
    )
    $json = $Params | ConvertTo-Json -Compress -Depth 30
    $text = & $Invoker -Cmd $Command -ParamsJson $json -Port $Port -TimeoutMs $MaxCaseMs -Auth $Auth
    if ($LASTEXITCODE -ne 0) { throw "transport failed for $Command" }
    return $text | ConvertFrom-Json
}

function Get-DirtyPackages {
    $script = @'
import unreal, json
dirty = []
for package in unreal.EditorLoadingAndSavingUtils.get_dirty_content_packages():
    dirty.append(str(package))
for package in unreal.EditorLoadingAndSavingUtils.get_dirty_map_packages():
    dirty.append(str(package))
print("__HAYBA_DIRTY__" + json.dumps(sorted(set(dirty))))
'@
    $response = Invoke-HaybaCommand -Command 'python_run' -Params @{ script = $script }
    if ($response.ok -ne $true) { throw "dirty-state probe failed: $($response.error)" }
    $stdout = [string]$response.data.stdout
    $match = [regex]::Match($stdout, '__HAYBA_DIRTY__(\[[^\r\n]*\])')
    if (-not $match.Success) { throw 'dirty-state probe returned no parseable marker' }
    return @($match.Groups[1].Value | ConvertFrom-Json)
}

function Assert-EditorHealthy {
    if (-not (Get-Process -Id $EditorPid -ErrorAction SilentlyContinue)) {
        throw "editor PID $EditorPid exited"
    }
    $owner = Get-ListenerOwner
    if ($owner -ne $EditorPid) {
        throw "listener ownership changed: expected PID $EditorPid, got $owner"
    }
    $ping = Invoke-HaybaCommand -Command 'ping'
    if ($ping.ok -ne $true) { throw "fresh ping failed: $($ping | ConvertTo-Json -Compress)" }

    $now = @(
        if (Test-Path -LiteralPath $CrashDir) {
            Get-ChildItem -LiteralPath $CrashDir -Directory | ForEach-Object Name
        }
    )
    $newCrashes = @($now | Where-Object { $_ -notin $InitialCrashes })
    if ($newCrashes.Count -gt 0) {
        throw "new Unreal crash report(s): $($newCrashes -join ', ')"
    }

    $dirtyNow = @(Get-DirtyPackages)
    $addedDirty = @($dirtyNow | Where-Object { $_ -notin $InitialDirtyPackages })
    $removedDirty = @($InitialDirtyPackages | Where-Object { $_ -notin $dirtyNow })
    if ($addedDirty.Count -gt 0 -or $removedDirty.Count -gt 0) {
        throw "dirty-package baseline changed (added: $($addedDirty -join ', '); removed: $($removedDirty -join ', '))"
    }
    return [pscustomobject]@{
        same_pid_alive = $true
        listener_owner = $owner
        ping_ok = $true
        crash_delta = $newCrashes.Count
        dirty_package_delta = 0
    }
}

function Add-Result {
    param(
        [string]$Name,
        [bool]$Passed,
        [long]$DurationMs,
        [string]$Detail,
        [string]$Command = '',
        [string]$ParamsHash = '',
        [object]$Recovery = $null
    )
    $Results.Add([pscustomobject]@{
        test_id = $Name
        name = $Name
        command = $Command
        sanitized_params_sha256 = $ParamsHash
        passed = $Passed
        duration_ms = $DurationMs
        editor_pid = $EditorPid
        recovery = $Recovery
        detail = $Detail
    })
}

function Test-CommandRejection {
    param(
        [string]$Name,
        [string]$Command,
        [hashtable]$Params,
        [string]$ErrorPattern,
        [int]$MinDurationMs = 0
    )
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $paramsHash = Get-SanitizedHash $Params
    try {
        $response = Invoke-HaybaCommand -Command $Command -Params $Params
        if ($response.ok -ne $false) {
            throw "expected ok:false, got $($response | ConvertTo-Json -Compress -Depth 20)"
        }
        if ($ErrorPattern -and [string]$response.error -notmatch $ErrorPattern) {
            throw "error did not match /$ErrorPattern/: $($response.error)"
        }
        if ($clock.ElapsedMilliseconds -lt $MinDurationMs) {
            throw "case returned in $($clock.ElapsedMilliseconds)ms; expected the runtime deadline path after at least ${MinDurationMs}ms"
        }
        if ($clock.ElapsedMilliseconds -gt $MaxCaseMs) {
            throw "case exceeded ${MaxCaseMs}ms"
        }
        $recovery = Assert-EditorHealthy
        Add-Result $Name $true $clock.ElapsedMilliseconds ([string]$response.error) $Command $paramsHash $recovery
    }
    catch {
        Add-Result $Name $false $clock.ElapsedMilliseconds $_.Exception.Message $Command $paramsHash
        throw
    }
}

function Test-CommandSuccess {
    param(
        [string]$Name,
        [string]$Command,
        [hashtable]$Params = @{},
        [int]$SettleMs = 0
    )
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $paramsHash = Get-SanitizedHash $Params
    try {
        $response = Invoke-HaybaCommand -Command $Command -Params $Params
        if ($response.ok -ne $true) {
            throw "expected ok:true, got $($response | ConvertTo-Json -Compress -Depth 20)"
        }
        if ($SettleMs -gt 0) { Start-Sleep -Milliseconds $SettleMs }
        if ($clock.ElapsedMilliseconds -gt $MaxCaseMs) {
            throw "case exceeded ${MaxCaseMs}ms"
        }
        $recovery = Assert-EditorHealthy
        Add-Result $Name $true $clock.ElapsedMilliseconds 'command completed; editor, listener, dirty baseline, and fresh ping survived' $Command $paramsHash $recovery
    }
    catch {
        Add-Result $Name $false $clock.ElapsedMilliseconds $_.Exception.Message $Command $paramsHash
        throw
    }
}

function Send-RawFrame {
    param(
        [byte[]]$Header,
        [byte[]]$Body = @(),
        [bool]$ReadResponse = $false
    )
    $client = [System.Net.Sockets.TcpClient]::new()
    $client.SendTimeout = $MaxCaseMs
    $client.ReceiveTimeout = $MaxCaseMs
    $client.Connect('127.0.0.1', $Port)
    try {
        $stream = $client.GetStream()
        if ($Header.Length -gt 0) { $stream.Write($Header, 0, $Header.Length) }
        if ($Body.Length -gt 0) { $stream.Write($Body, 0, $Body.Length) }
        $stream.Flush()
        if (-not $ReadResponse) { return '' }

        $lengthBytes = [byte[]]::new(4)
        $read = 0
        while ($read -lt 4) {
            $count = $stream.Read($lengthBytes, $read, 4 - $read)
            if ($count -le 0) { throw 'connection closed before response header' }
            $read += $count
        }
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($lengthBytes) }
        $length = [BitConverter]::ToInt32($lengthBytes, 0)
        if ($length -le 0 -or $length -gt 8MB) { throw "invalid response length $length" }
        $bytes = [byte[]]::new($length)
        $read = 0
        while ($read -lt $length) {
            $count = $stream.Read($bytes, $read, $length - $read)
            if ($count -le 0) { throw 'connection closed before response body' }
            $read += $count
        }
        return [Text.Encoding]::UTF8.GetString($bytes)
    }
    finally {
        $client.Dispose()
    }
}

function Get-BigEndianHeader([uint32]$Length) {
    return [byte[]]@(
        ($Length -shr 24) -band 0xff,
        ($Length -shr 16) -band 0xff,
        ($Length -shr 8) -band 0xff,
        $Length -band 0xff
    )
}

function Test-RawCase {
    param(
        [string]$Name,
        [scriptblock]$Action
    )
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Action
        Start-Sleep -Milliseconds 150
        $recovery = Assert-EditorHealthy
        Add-Result $Name $true $clock.ElapsedMilliseconds 'connection rejected; editor and listener survived' 'raw_frame' (Get-SanitizedHash @{ case = $Name }) $recovery
    }
    catch {
        Add-Result $Name $false $clock.ElapsedMilliseconds $_.Exception.Message 'raw_frame' (Get-SanitizedHash @{ case = $Name })
        throw
    }
}

    if (-not (Test-Path -LiteralPath $Invoker)) { throw "missing invoker: $Invoker" }
    $transportProbe = Invoke-HaybaCommand -Command 'ping'
    if ($transportProbe.ok -ne $true) { throw 'initial transport-limit probe failed' }
    if ($null -ne $transportProbe.data.transport_limits.frame_read_timeout_ms) {
        $FrameReadTimeoutMs = [int]$transportProbe.data.transport_limits.frame_read_timeout_ms
    }
    if ($null -ne $transportProbe.data.transport_limits.max_clients) {
        $ConfiguredMaxClients = [int]$transportProbe.data.transport_limits.max_clients
    }
    if ($MaxCaseMs -le ($FrameReadTimeoutMs + 1500)) {
        throw "MaxCaseMs (${MaxCaseMs}) must exceed the configured frame-read timeout (${FrameReadTimeoutMs}) by at least 1500ms"
    }
    $InitialDirtyPackages = @(Get-DirtyPackages)
    Assert-EditorHealthy | Out-Null

    if ($CanaryKill) {
        if ($null -eq $LaunchedProcess) {
            throw '-CanaryKill is launch-mode only; it will never terminate an attached process'
        }
        $clock = [Diagnostics.Stopwatch]::StartNew()
        Stop-Process -Id $EditorPid -Force
        try { $LaunchedProcess.WaitForExit(10000) | Out-Null } catch {}
        try {
            Assert-EditorHealthy | Out-Null
            Add-Result 'canary_detects_editor_exit' $false $clock.ElapsedMilliseconds `
                'harness failed to detect its deliberately killed disposable editor' 'harness_canary'
        }
        catch {
            Add-Result 'canary_detects_editor_exit' $true $clock.ElapsedMilliseconds `
                "detected disposable editor exit: $($_.Exception.Message)" 'harness_canary' `
                (Get-SanitizedHash @{ token = 'redacted'; mode = 'kill_owned_process' }) `
                ([pscustomobject]@{ editor_exit_detected = $true; user_process_targeted = $false })
        }
    }
    else {

    # The allow_unsafe=true probes are intentional: crash prevention must live
    # below policy and must survive callers that bypass the TypeScript wrapper.
    $fatalCases = @(
        @{ Name='world_switch_new_blank_map'; Script='import unreal; unreal.EditorLoadingAndSavingUtils.new_blank_map(False)' },
        @{ Name='world_switch_load_map'; Script='import unreal; unreal.EditorLoadingAndSavingUtils.load_map("/Game/Nope")' },
        @{ Name='self_socket_deadlock'; Script='import socket; s=socket.socket(); s.connect(("127.0.0.1",52342))' },
        @{ Name='dangling_tick_callback'; Script='import unreal; unreal.register_slate_post_tick_callback(lambda dt: None)' },
        @{ Name='python_background_thread'; Script='import threading; threading.Thread(target=lambda:None).start()' },
        @{ Name='game_thread_sleep'; Script='import time; time.sleep(10)' },
        @{ Name='infinite_loop'; Script='while True: pass' },
        @{ Name='listview_duplicate_identity'; Script='list_view.set_list_items(items + items)' },
        @{ Name='native_memory_escape'; Script='import ctypes; ctypes.string_at(0)' },
        @{ Name='process_exit'; Script='import os; os._exit(1)' },
        @{ Name='static_mesh_known_crasher'; Script='mesh.set_lod_build_settings(0, settings)' }
    )
    foreach ($case in $fatalCases) {
        Test-CommandRejection -Name $case.Name -Command 'python_run' -Params @{
            script = $case.Script
            allow_unsafe = $true
        } -ErrorPattern 'policy_blocked|blocked permanently|crash|deadlock'
    }

    # Unlike the syntactically obvious `while True` case above, this loop is
    # intentionally permitted by preflight and must be stopped by the native
    # cooperative bytecode deadline. A fast policy rejection would not prove
    # HCR-TIME-001; the lower duration bound distinguishes the two paths.
    Test-CommandRejection -Name 'python_deadline_exhaustion' -Command 'python_run' -Params @{
        script = 'for _ in range(10**12): x=1'
        allow_unsafe = $true
    } -ErrorPattern 'HCR-TIME-001|deadline|timed out' -MinDurationMs 4000

    Test-CommandRejection -Name 'oversized_python_script' -Command 'python_run' -Params @{
        script = 'x' * (256KB + 1)
        allow_unsafe = $true
    } -ErrorPattern 'limit'

    Test-CommandRejection -Name 'stale_actor_path' -Command 'actor_transform' -Params @{
        actor_id = '__HaybaMissingActor__'
        location = @(1, 2, 3)
    } -ErrorPattern 'not found'

    Test-CommandRejection -Name 'fractional_lod_index' -Command 'mesh_set_lod' -Params @{
        path = '/Game/__HaybaMissingMesh__'
        lod_index = 0.5
        screen_size = 0.5
    } -ErrorPattern 'integer'

    Test-CommandRejection -Name 'wrong_typed_physics_flag' -Command 'physics_add_impulse' -Params @{
        actor_id = '__HaybaMissingActor__'
        impulse = @(1, 2, 3)
        velocity_change = 'true'
    } -ErrorPattern 'boolean'

    # Frame-level attacks never reach a handler. A new connection and ping after
    # each prove the listener did not wedge or transfer to a replacement editor.
    Test-RawCase 'zero_length_frame' {
        Send-RawFrame -Header (Get-BigEndianHeader 0)
    }
    Test-RawCase 'oversized_declared_frame' {
        Send-RawFrame -Header (Get-BigEndianHeader (1MB + 1))
    }
    Test-RawCase 'truncated_header' {
        Send-RawFrame -Header ([byte[]]@(0, 0))
    }
    Test-RawCase 'truncated_body' {
        Send-RawFrame -Header (Get-BigEndianHeader 100) -Body ([Text.Encoding]::UTF8.GetBytes('{'))
    }
    Test-RawCase 'malformed_json' {
        $body = [Text.Encoding]::UTF8.GetBytes('{not-json}')
        $raw = Send-RawFrame -Header (Get-BigEndianHeader $body.Length) -Body $body -ReadResponse $true
        $response = $raw | ConvertFrom-Json
        if ($response.ok -ne $false) { throw "malformed JSON was not rejected: $raw" }
    }
    Test-RawCase 'excessive_json_nesting' {
        $json = ('[' * 65) + '0' + (']' * 65)
        $body = [Text.Encoding]::UTF8.GetBytes($json)
        Send-RawFrame -Header (Get-BigEndianHeader $body.Length) -Body $body
    }
    Test-RawCase 'embedded_nul_frame' {
        $prefix = [Text.Encoding]::UTF8.GetBytes('{"cmd":"ping"}')
        $body = [byte[]]::new($prefix.Length + 2)
        [Array]::Copy($prefix, $body, $prefix.Length)
        $body[$prefix.Length] = 0
        $body[$prefix.Length + 1] = [byte][char]'x'
        Send-RawFrame -Header (Get-BigEndianHeader $body.Length) -Body $body
    }
    Test-RawCase 'malformed_utf8_frame' {
        # Overlong UTF-8 encoding of NUL. Conversion APIs commonly replace it;
        # the transport must reject the original bytes so authenticated/framed
        # identity cannot differ from the JSON text handlers receive.
        $body = [byte[]]@(0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0x80, 0x22, 0x7d)
        Send-RawFrame -Header (Get-BigEndianHeader $body.Length) -Body $body
    }
    Test-RawCase 'nonfinite_numeric_payload' {
        $json = '{"cmd":"placement_validate","id":"survival-nonfinite","params":{"class_path":"/Script/Engine.Actor","location":[1,1e309,3],"radius":50}}'
        $body = [Text.Encoding]::UTF8.GetBytes($json)
        $raw = Send-RawFrame -Header (Get-BigEndianHeader $body.Length) -Body $body -ReadResponse $true
        $response = $raw | ConvertFrom-Json
        if ($response.ok -ne $false) { throw "non-finite number was not rejected: $raw" }
        if ([string]$response.error -notmatch 'finite|Invalid JSON') {
            throw "non-finite rejection was not diagnostic: $raw"
        }
    }
    Test-RawCase 'connection_churn' {
        for ($i = 0; $i -lt 64; $i++) {
            Send-RawFrame -Header (Get-BigEndianHeader 0)
        }
    }
    Test-RawCase 'partial_frame_client_flood' {
        $clients = [Collections.Generic.List[Net.Sockets.TcpClient]]::new()
        try {
            for ($i = 0; $i -lt 24; $i++) {
                $client = [Net.Sockets.TcpClient]::new()
                $client.Connect('127.0.0.1', $Port)
                $client.GetStream().WriteByte(0)
                $clients.Add($client)
            }
        }
        finally {
            foreach ($client in $clients) { $client.Dispose() }
        }
    }
    Test-RawCase 'slowloris_frame_timeout' {
        # Saturate the configured connection ceiling with incomplete headers,
        # then prove the complete-frame deadline closes every socket and frees
        # capacity for Assert-EditorHealthy's fresh ping. Sending a byte just
        # before each poll must not reset the total request deadline.
        $clients = [Collections.Generic.List[Net.Sockets.TcpClient]]::new()
        try {
            for ($i = 0; $i -lt $ConfiguredMaxClients; $i++) {
                $client = [Net.Sockets.TcpClient]::new()
                $client.ReceiveTimeout = 1000
                $client.Connect('127.0.0.1', $Port)
                $client.GetStream().WriteByte(0)
                $clients.Add($client)
            }
            Start-Sleep -Milliseconds ($FrameReadTimeoutMs + 300)
            foreach ($client in $clients) {
                $probe = [byte[]]::new(1)
                $count = $client.GetStream().Read($probe, 0, 1)
                if ($count -ne 0) {
                    throw 'slow partial-frame connection remained readable after the configured total deadline'
                }
            }
        }
        finally {
            foreach ($client in $clients) { $client.Dispose() }
        }
    }


    # PIE transitions exercise the lifetime boundary that dominates the local
    # crash corpus. Both requests are followed by the same PID/listener/ping/
    # crash/dirty checks as hostile inputs; the stop case also leaves the
    # disposable session in an editor-only state for deterministic teardown.
    Test-CommandSuccess -Name 'pie_start_transition' -Command 'editor_start_pie' -SettleMs 750
    Test-CommandSuccess -Name 'pie_stop_transition' -Command 'editor_stop_pie' -SettleMs 750
    }

    $failed = @($Results | Where-Object { -not $_.passed })
    $report = [pscustomobject]@{
        schema_version = 1
        mode = $CanaryKill ? 'canary' : 'survival'
        editor_pid = $EditorPid
        port = $Port
        crash_count_before = $InitialCrashes.Count
        initial_dirty_packages_sha256 = Get-SanitizedHash $InitialDirtyPackages
        passed = $Results.Count - $failed.Count
        failed = $failed.Count
        cases = $Results
    }
    Write-SurvivalReports $report
    if ($failed.Count -gt 0) { $ExitCode = 1 }
}
catch {
    [Console]::Error.WriteLine("editor-survival gate failed: $($_.Exception.Message)")
    if (@($Results | Where-Object { -not $_.passed }).Count -eq 0) {
        $Results.Add([pscustomobject]@{
            test_id = 'harness_internal'
            name = 'harness_internal'
            command = 'harness'
            sanitized_params_sha256 = ''
            passed = $false
            duration_ms = 0
            editor_pid = $EditorPid
            recovery = $null
            detail = $_.Exception.Message
        })
    }
    $failedCases = @($Results | Where-Object { -not $_.passed })
    $failedReport = [pscustomobject]@{
        schema_version = 1
        mode = $CanaryKill ? 'canary' : 'survival'
        editor_pid = $EditorPid
        port = $Port
        fatal_error = $_.Exception.Message
        passed = $Results.Count - $failedCases.Count
        failed = $failedCases.Count
        cases = $Results
    }
    Write-SurvivalReports $failedReport
    $ExitCode = 1
}
finally {
    if ($null -ne $LaunchedProcess -and -not $KeepEditor) {
        $owned = Get-Process -Id $EditorPid -ErrorAction SilentlyContinue
        if ($owned) {
            # This process was created by this invocation and carries our unique
            # token. Stop it without saving; hostile probes must never leak
            # dirty packages into the developer's project.
            Stop-Process -Id $EditorPid -Force -ErrorAction SilentlyContinue
            try { $owned.WaitForExit(10000) | Out-Null } catch {}
        }
    }
}

exit $ExitCode
