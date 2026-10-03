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

  Every case verifies all of these before and after the hostile action: the
  exact executable/start-time/command-line identity is unchanged, the expected
  PID still owns the listener, request-id-correlated ping and native state
  reads succeed, Python executes a nonce outside PIE or proves the exact PIE
  admission refusal, PIE/map/dirty/filesystem state matches the baseline, and no
  crash signature or critical log line appeared. A safe `ok:false` rejection
  passes; a timeout, listener handoff, crash artifact, or process exit fails.

  Hostile mode requires both -ConfirmDisposableProject and an adjacent
  `.hayba-disposable-project` marker containing HAYBA_DISPOSABLE_PROJECT_V1.
  There is no keep-editor escape. Owned cleanup requests a graceful verified
  clean exit first; force termination is only a failed-recovery fallback and
  makes the gate fail. No hostile case is ever sent to an untagged editor.
#>
param(
    [ValidateRange(0, [int]::MaxValue)]
    [int]$EditorPid = 0,

    [string]$EditorExe = '',

    [string]$ProjectPath = '',

    [string]$SessionToken = '',

    # Direct attestation mode: the checked-out repository must be clean at this
    # exact commit, and every loaded UnrealEditor-HaybaMCP*.dll must have one
    # matching `FileName.dll=<64 hex SHA256>` entry below.
    [string]$ExpectedSourceCommit = '',

    [string[]]$ExpectedPluginDllSha256 = @(),

    # Artifact mode is for a separately produced build. Its bounded JSON file
    # must contain schema_version:1, source_commit, and a plugin_dll_sha256
    # object mapping every expected loaded Hayba DLL filename to its SHA256.
    # Do not combine it with the two direct-attestation parameters.
    [string]$ExpectedArtifactManifest = '',

    [switch]$ConfirmDisposableProject,

    # Attach mode transfers teardown ownership to this invocation. Requiring an
    # explicit switch prevents a tagged-but-externally-managed editor from being
    # closed by surprise after hostile probes.
    [switch]$TakeOwnership,

    [ValidateRange(0, 65535)]
    [int]$Port = 0,

    # A cold UE editor can spend several minutes compiling shaders and loading
    # the host project before game-thread commands are ready. The timeout is a
    # harness patience limit, not a per-case safety limit; hostile commands are
    # still bounded independently by MaxCaseMs.
    [ValidateRange(10000, 600000)]
    [int]$StartupTimeoutMs = 120000,

    [ValidateRange(500, 60000)]
    [int]$MaxCaseMs = 10000,

    [ValidateRange(5000, 60000)]
    [int]$GracefulShutdownTimeoutMs = 30000,

    [string]$CrashDir = '',
    [string]$OutputJson = '',
    [string]$OutputJUnit = '',
    [switch]$List,
    [switch]$CanaryKill,
    [string]$Auth = ''
)

$ErrorActionPreference = 'Stop'
if (-not $EditorExe) { $EditorExe = $env:HAYBA_UNREAL_EDITOR_EXE }
$Invoker = Join-Path $PSScriptRoot 'invoke-tcp-command.ps1'
$HostProofHelper = Join-Path $PSScriptRoot 'query-survival-host-proof.ps1'
$SurvivalOwner = 'survival-' + [guid]::NewGuid().ToString('N')
$CasePhases = [Collections.Generic.List[object]]::new()
$CasePreflight = $null
$HostileDurationMs = $null
$HealthPhasePrefix = 'preflight'
$LastHostQueryEvidence = $null
$UnaccountedHostProofProcess = $null
$Results = [System.Collections.Generic.List[object]]::new()
$LaunchedProcess = $null
$OwnsTarget = $false
$ExitCode = 0
$InitialCrashEvidence = $null
$InitialEditorState = $null
$InitialFilesystemEvidence = $null
$EditorIdentity = $null
$EnvironmentEvidence = $null
$CleanupEvidence = $null
$CleanupAttempted = $false
$LogCursors = @{}
$LogCriticalCount = 0
$CaseClock = $null
$CaseMaxMs = $MaxCaseMs
$StartupClock = $null
$StartupReadinessEvidence = $null
$FrameReadTimeoutMs = 5000
$ActiveMaxRequestBytes = 1MB
$ActiveMaxJsonNestingDepth = 64
$ConfiguredMaxClients = 16
$PipelinedRequestProbeCount = 9
$ArtifactExpectation = $null
$ActiveTransportLimits = $null
$MaxStoredDiagnosticChars = 4096
$CrashScanTimeoutMs = 2000
$MaxCrashDirectories = 256
$MaxCrashFiles = 4096
$MaxCrashContextBytes = 1MB
$FilesystemScanTimeoutMs = 2000
$MaxTrackedProjectFiles = 25000
$MaxLogFiles = 64
$MaxTotalLogDeltaBytes = 8MB
$LogScanTimeoutMs = 1000
$DisposableMarkerName = '.hayba-disposable-project'
$DisposableMarkerValue = 'HAYBA_DISPOSABLE_PROJECT_V1'
$PendingAcceptanceMatrix = @(
    [pscustomobject]@{ issue = '#18'; state = 'pending_opt_in'; required = 'MetaSound create/add/connect/set/compile/list readback and cleanup' },
    [pscustomobject]@{ issue = '#369'; state = 'pending_opt_in'; required = 'stateful Blueprint/DataAsset/Level/Material mutation recovery and object-state proof' },
    [pscustomobject]@{ issue = '#370/#371'; state = 'pending_opt_in'; required = 'live advisory classification and persisted verbosity changes across real handlers' },
    [pscustomobject]@{ issue = '#383'; state = 'pending_opt_in'; required = 'sentinel absence across native journal/log/panel/MCP/report artifacts' },
    [pscustomobject]@{ issue = '#387'; state = 'pending_opt_in'; required = 'real-RHI camera/UMG/viewport render, cancel/disconnect/overlap, render-then-graceful-quit' },
    [pscustomobject]@{ issue = '#406'; state = 'pending_opt_in'; required = 'all UMG mutations plus hostile inconsistent fixtures, cleanup, compile-log and crash-signature proof' },
    [pscustomobject]@{ issue = '#365-response'; state = 'pending_opt_in'; required = 'execute Hayba.MCP.Transport.OutboundAdmissionAndAccounting, then prove a real stalled reader is disconnected and a fresh ping succeeds' }
)
$CaseCatalog = @(
    'world_switch_new_blank_map', 'world_switch_load_map', 'self_socket_deadlock',
    'dangling_tick_callback', 'python_background_thread', 'game_thread_sleep',
    'infinite_loop', 'python_deadline_exhaustion', 'python_tier3_filesystem_denied',
    'python_tier3_legacy_override_denied', 'listview_duplicate_identity',
    'native_memory_escape', 'process_exit',
    'static_mesh_known_crasher', 'oversized_python_script', 'zero_length_frame',
    'oversized_declared_frame', 'truncated_header', 'truncated_body',
    'malformed_json', 'excessive_json_nesting', 'embedded_nul_frame', 'malformed_utf8_frame',
    'connection_churn', 'partial_frame_client_flood', 'client_limit_accounting_recovery',
    'slowloris_total_frame_deadline', 'pipelined_request_limit', 'disconnect_after_dispatch', 'stale_actor_path',
    'fractional_lod_index', 'wrong_typed_physics_flag', 'nonfinite_numeric_payload',
    'pie_start_transition', 'pie_stop_transition'
)

if ($List) {
    [pscustomobject]@{
        mode = 'list'
        case_count = $CaseCatalog.Count
        cases = $CaseCatalog
        disposable_marker = "$DisposableMarkerName must contain exactly $DisposableMarkerValue; pass -ConfirmDisposableProject."
        canary = 'Pass -CanaryKill in launch mode; evidence must say ordinary_gate_would_fail:true and ordinary_gate_exit_code:1.'
        artifact_attestation = 'Supply -ExpectedSourceCommit plus one -ExpectedPluginDllSha256 FileName.dll=SHA256 entry for every loaded Hayba DLL, or -ExpectedArtifactManifest with that exact information.'
        pending_acceptance_matrix = $PendingAcceptanceMatrix
    } | ConvertTo-Json -Depth 5
    exit 0
}

if (-not $EditorExe) { throw 'Pass -EditorExe or set HAYBA_UNREAL_EDITOR_EXE to the UnrealEditor executable.' }

function Get-SanitizedHash([object]$Value) {
    $json = ConvertTo-Json -InputObject $Value -Compress -Depth 30
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
                $detail = [Security.SecurityElement]::Escape(
                    "sanitized diagnostic sha256=$($case.detail.sha256) chars=$($case.detail.chars_observed)")
                [void]$xml.Append("<failure message=`"$detail`" />")
            }
            [void]$xml.AppendLine('</testcase>')
        }
        [void]$xml.AppendLine('</testsuite>')
        Set-Content -LiteralPath $OutputJUnit -Value $xml.ToString() -Encoding utf8
    }
    return $json
}

function Resolve-FullPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function New-DiagnosticDigest([object]$Value, [string]$Kind = 'diagnostic') {
    # Evidence files never retain response/error/exception text. Even a secret
    # shape the redactor has never seen can therefore only contribute to a
    # bounded digest, never persist as plaintext in JSON or JUnit.
    $text = if ($null -eq $Value) { '' } else { [string]$Value }
    $bounded = if ($text.Length -gt $MaxStoredDiagnosticChars) {
        $text.Substring(0, $MaxStoredDiagnosticChars)
    } else { $text }
    return [pscustomobject]@{
        kind = $Kind
        chars_observed = $text.Length
        chars_hashed = $bounded.Length
        truncated = $text.Length -gt $bounded.Length
        sha256 = Get-SanitizedHash $bounded
    }
}

function Convert-ExpectedPluginSpecs([string[]]$Specs) {
    $expected = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($spec in @($Specs)) {
        $match = [regex]::Match([string]$spec, '^([^=\\/]+\.dll)=([0-9a-fA-F]{64})$')
        if (-not $match.Success) {
            throw 'Each expected plugin hash must be FileName.dll=<64 hex SHA256>; paths and partial hashes are refused'
        }
        $name = $match.Groups[1].Value
        if (-not $name.StartsWith('UnrealEditor-HaybaMCP', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Expected plugin filename is outside the Hayba module namespace: $name"
        }
        if ($expected.ContainsKey($name)) { throw "Duplicate expected plugin DLL entry: $name" }
        $expected.Add($name, $match.Groups[2].Value.ToLowerInvariant())
    }
    if ($expected.Count -eq 0) { throw 'At least one exact expected Hayba plugin DLL SHA256 is required' }
    if (-not $expected.ContainsKey('UnrealEditor-HaybaMCPToolkit.dll')) {
        throw 'The exact UnrealEditor-HaybaMCPToolkit.dll SHA256 is mandatory'
    }
    return $expected
}

function Resolve-ArtifactExpectation {
    $repoRoot = Resolve-FullPath (Join-Path $PSScriptRoot '..\..\..')
    $manifestMode = -not [string]::IsNullOrWhiteSpace($ExpectedArtifactManifest)
    if ($manifestMode) {
        if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceCommit) -or $ExpectedPluginDllSha256.Count -gt 0) {
            throw 'ExpectedArtifactManifest cannot be combined with direct source/hash attestation parameters'
        }
        $manifestPath = Resolve-FullPath $ExpectedArtifactManifest
        if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            throw 'ExpectedArtifactManifest must name an existing JSON file'
        }
        $manifestInfo = Get-Item -LiteralPath $manifestPath
        if ($manifestInfo.Length -le 0 -or $manifestInfo.Length -gt 64KB) {
            throw 'ExpectedArtifactManifest must be between 1 byte and 64 KiB'
        }
        $manifestText = Get-Content -Raw -LiteralPath $manifestPath
        $manifest = $manifestText | ConvertFrom-Json
        if ([int]$manifest.schema_version -ne 1 -or
            [string]$manifest.source_commit -cnotmatch '^[0-9a-fA-F]{40}$' -or
            $null -eq $manifest.plugin_dll_sha256) {
            throw 'Artifact manifest needs schema_version:1, a 40-hex source_commit, and plugin_dll_sha256'
        }
        $specs = @($manifest.plugin_dll_sha256.PSObject.Properties | ForEach-Object {
            "$($_.Name)=$([string]$_.Value)"
        })
        return [pscustomobject]@{
            mode = 'exact_artifact_manifest'
            source_commit = ([string]$manifest.source_commit).ToLowerInvariant()
            source_worktree_clean = $null
            manifest_sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $manifestPath).Hash.ToLowerInvariant()
            expected_dlls = Convert-ExpectedPluginSpecs $specs
        }
    }

    if ($ExpectedSourceCommit -cnotmatch '^[0-9a-fA-F]{40}$') {
        throw 'Direct attestation requires -ExpectedSourceCommit with the exact 40-hex commit'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot '.git'))) {
        throw 'Direct source attestation requires this script to run from a Git worktree'
    }
    $actualCommit = ([string](& git -C $repoRoot rev-parse HEAD 2>$null)).Trim().ToLowerInvariant()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -cne $ExpectedSourceCommit.ToLowerInvariant()) {
        throw 'Checked-out source commit does not match ExpectedSourceCommit'
    }
    $dirtyLines = @(& git -C $repoRoot status --porcelain=v1 --untracked-files=all 2>$null)
    if ($LASTEXITCODE -ne 0 -or $dirtyLines.Count -ne 0) {
        throw 'Direct source attestation requires a completely clean worktree, including no untracked files'
    }
    return [pscustomobject]@{
        mode = 'clean_exact_source_commit'
        source_commit = $actualCommit
        source_worktree_clean = $true
        manifest_sha256 = ''
        expected_dlls = Convert-ExpectedPluginSpecs $ExpectedPluginDllSha256
    }
}

function Assert-DisposableProject([string]$ResolvedProjectPath) {
    if (-not $ConfirmDisposableProject) {
        throw 'Refusing hostile editor-survival probes without -ConfirmDisposableProject'
    }
    $root = Split-Path -Parent $ResolvedProjectPath
    $marker = Join-Path $root $DisposableMarkerName
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw "Refusing project without disposable marker: $marker"
    }
    $markerText = (Get-Content -Raw -LiteralPath $marker).Trim()
    if ($markerText -cne $DisposableMarkerValue) {
        throw "Disposable marker must contain exactly $DisposableMarkerValue"
    }
}

function Assert-SessionTokenShape([string]$Token) {
    if ($Token -cnotmatch '^[A-Za-z0-9_-]{16,128}$') {
        throw 'SessionToken must be 16-128 ASCII letters, digits, underscore, or hyphen'
    }
}

function Test-ExactCommandLineArgument([string]$CommandLine, [string]$Argument) {
    $escaped = [regex]::Escape($Argument)
    return [regex]::IsMatch(
        $CommandLine,
        "(?:^|\s)(?:`"$escaped`"|$escaped)(?=\s|$)",
        [Text.RegularExpressions.RegexOptions]::CultureInvariant)
}

function New-CaseClock { return [Diagnostics.Stopwatch]::StartNew() }

function Start-CaseBudget([int]$BudgetMs = $MaxCaseMs) {
    if ($BudgetMs -lt $MaxCaseMs -or $BudgetMs -gt 120000) { throw 'case budget is outside the bounded range' }
    $script:CaseMaxMs = $BudgetMs
    $script:CaseStartTimestamp = [Diagnostics.Stopwatch]::GetTimestamp()
    $script:CaseClock = New-CaseClock
    $script:CasePhases = [Collections.Generic.List[object]]::new()
    $script:CasePreflight = $null
    $script:HostileDurationMs = $null
    $script:HealthPhasePrefix = 'preflight'
    $script:LastHostQueryEvidence = $null
}

function Invoke-CasePhase([string]$Name, [scriptblock]$Action) {
    if ($null -eq $CaseClock) { return & $Action }
    $phase = [pscustomobject]@{
        name = $Name; start_ms = [long]$CaseClock.ElapsedMilliseconds; end_ms = $null
        duration_ms = $null; remaining_ms = [Math]::Max(0, $CaseMaxMs - $CaseClock.ElapsedMilliseconds)
        status = 'started'; diagnostic = $null
    }
    $CasePhases.Add($phase)
    try {
        Get-RemainingCaseMs $Name | Out-Null
        $value = & $Action
        Get-RemainingCaseMs $Name | Out-Null
        $phase.status = 'completed'
        return $value
    }
    catch {
        $phase.status = if ($_.Exception -is [TimeoutException] -or $CaseClock.ElapsedMilliseconds -ge $CaseMaxMs) { 'timed_out' } else { 'failed' }
        $phase.diagnostic = New-DiagnosticDigest $_.Exception.Message 'phase_failure'
        throw
    }
    finally {
        $phase.end_ms = [long]$CaseClock.ElapsedMilliseconds
        $phase.duration_ms = $phase.end_ms - $phase.start_ms
        $phase.remaining_ms = [Math]::Max(0, $CaseMaxMs - $CaseClock.ElapsedMilliseconds)
        if ($Name -ceq 'hostile.command' -or $Name -ceq 'hostile.action') { $script:HostileDurationMs = $phase.duration_ms }
    }
}

function Initialize-HostProofCapture {
    if ('HaybaHostProofCapture' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
public sealed class HaybaHostProofCapture {
    private readonly MemoryStream bytes = new MemoryStream();
    private readonly object gate = new object();
    public Task Work;
    public int Count { get { lock (gate) { return (int)bytes.Length; } } }
    public string Snapshot() { lock (gate) { return new UTF8Encoding(false, true).GetString(bytes.ToArray()); } }
    public void Start(Stream stream) { Work = Capture(stream); }
    private async Task Capture(Stream stream) {
        byte[] buffer = new byte[1024];
        while (true) {
            int count = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
            if (count == 0) return;
            lock (gate) {
                if (bytes.Length + count > 8192) throw new IOException("host proof helper output exceeded its bound");
                bytes.Write(buffer, 0, count);
            }
        }
    }
}
'@
}

function Start-HostProofProcess([string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new([Environment]::ProcessPath)
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    if (-not $process.Start()) { throw 'host proof helper could not start' }
    return $process
}

function Invoke-HostProofQuery {
    param([switch]$IncludeListener, [int]$TimeoutMs = 0)
    if ($null -ne $UnaccountedHostProofProcess) { throw 'previous host proof helper lacks confirmed exit; refusing another query' }
    if ($TimeoutMs -eq 0) { $TimeoutMs = Get-RemainingCaseMs 'host proof' }
    elseif ($null -ne $CaseClock) { $TimeoutMs = [Math]::Min($TimeoutMs, (Get-RemainingCaseMs 'host proof')) }
    if ($TimeoutMs -le 250) { throw [TimeoutException]::new('host proof has no bounded query/exit allowance') }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    Initialize-HostProofCapture
    $process = $null; $stdout = $null; $stderr = $null; $failure = $null
    $events = @(); $confirmed = $false; $timedOut = $false
    $script:LastHostQueryEvidence = [pscustomobject]@{
        helper_pid = $null; exit_confirmed = $false; timed_out = $false
        elapsed_ms = 0; stdout_bytes = 0; stderr_bytes = 0; diagnostic = $null
    }
    try {
        $arguments = @('-NoProfile', '-NonInteractive', '-File', $HostProofHelper,
            '-ProcessId', [string]$EditorPid, '-Port', [string]$Port,
            '-ProjectPath', $ProjectPath, '-SessionToken', $SessionToken)
        if ($IncludeListener) { $arguments += '-IncludeListener' }
        if ($clock.ElapsedMilliseconds -ge $TimeoutMs - 250) { throw [TimeoutException]::new('host proof helper setup exhausted its allowance') }
        if ($null -ne $CaseClock) { Get-RemainingCaseMs 'host proof helper start' | Out-Null }
        $process = Start-HostProofProcess $arguments
        $LastHostQueryEvidence.helper_pid = $process.Id
        $stdout = [HaybaHostProofCapture]::new(); $stderr = [HaybaHostProofCapture]::new()
        $stdout.Start($process.StandardOutput.BaseStream); $stderr.Start($process.StandardError.BaseStream)
        # Reserve exit accounting inside the caller's allowance. A timed-out
        # client helper is never mistaken for CIM-provider cancellation.
        $queryRemaining = $TimeoutMs - 250 - [int]$clock.ElapsedMilliseconds
        if ($queryRemaining -le 0 -or -not $process.WaitForExit($queryRemaining)) {
            $timedOut = $true
            throw [TimeoutException]::new('host proof helper exceeded the remaining query allowance')
        }
    }
    catch { $failure = $_ }
    finally {
        if ($null -ne $process) {
            try {
                if (-not $process.HasExited) { $process.Kill() }
                $remaining = $TimeoutMs - [int]$clock.ElapsedMilliseconds
                if (-not $process.HasExited -and ($remaining -le 0 -or -not $process.WaitForExit($remaining))) { throw 'host proof helper exit unconfirmed' }
                $confirmed = $true
                foreach ($capture in @($stdout, $stderr)) {
                    if ($null -eq $capture) { continue }
                    $remaining = $TimeoutMs - [int]$clock.ElapsedMilliseconds
                    if (-not $capture.Work.IsCompleted -and ($remaining -le 0 -or -not $capture.Work.Wait($remaining))) { throw 'host proof helper output completion unconfirmed' }
                    $null = $capture.Work.GetAwaiter().GetResult()
                }
                if ($null -ne $stderr -and $stderr.Count -ne 0) { throw 'host proof helper wrote unexpected diagnostics' }
                if ($null -ne $stdout) {
                    # Only complete bounded lines survive timeout; they are
                    # progress, never permission to admit partial query rows.
                    $text = $stdout.Snapshot()
                    foreach ($line in $text.Split("`n")) {
                        if ([string]::IsNullOrWhiteSpace($line)) { continue }
                        try { $events += ($line | ConvertFrom-Json -DateKind String) }
                        catch { if ($null -eq $failure) { throw 'host proof helper returned malformed output' } }
                    }
                }
                if ($null -eq $failure -and $process.ExitCode -ne 0) { throw 'host proof helper exited with failure' }
            }
            catch { if ($null -eq $failure) { $failure = $_ } }
            finally {
                if ($confirmed -and ($null -eq $stdout -or $stdout.Work.IsCompleted) -and ($null -eq $stderr -or $stderr.Work.IsCompleted)) {
                    $process.Dispose()
                }
                else { $script:UnaccountedHostProofProcess = $process }
            }
        }
        $LastHostQueryEvidence.exit_confirmed = $confirmed
        $LastHostQueryEvidence.timed_out = $timedOut
        $LastHostQueryEvidence.elapsed_ms = [long]$clock.ElapsedMilliseconds
        if ($null -ne $stdout) { $LastHostQueryEvidence.stdout_bytes = $stdout.Count }
        if ($null -ne $stderr) { $LastHostQueryEvidence.stderr_bytes = $stderr.Count }
        if ($null -ne $failure) { $LastHostQueryEvidence.diagnostic = New-DiagnosticDigest $failure.Exception.Message 'host_query_failure' }
        if ($null -ne $CaseClock) {
            foreach ($name in @('identity', 'listener')) {
                $progress = @($events | Where-Object { $_.kind -ceq 'phase' -and $_.phase -ceq $name })
                if ($progress.Count -eq 0) { continue }
                $first = $progress[0]; $last = $progress[-1]
                [long]$startTick = 0; [long]$endTick = 0
                if (-not [long]::TryParse([string]$first.start_tick, [ref]$startTick) -or $startTick -lt $CaseStartTimestamp) { continue }
                $startMs = [long](($startTick - $CaseStartTimestamp) * 1000.0 / [Diagnostics.Stopwatch]::Frequency)
                $endMs = [long]$CaseClock.ElapsedMilliseconds
                if ([long]::TryParse([string]$last.end_tick, [ref]$endTick) -and $endTick -ge $startTick) {
                    $endMs = [long](($endTick - $CaseStartTimestamp) * 1000.0 / [Diagnostics.Stopwatch]::Frequency)
                }
                $state = if ($last.state -ceq 'completed') { 'completed' } elseif ($timedOut) { 'timed_out' } else { 'failed' }
                $CasePhases.Add([pscustomobject]@{
                    name = "$HealthPhasePrefix.$name"; start_ms = $startMs; end_ms = $endMs
                    duration_ms = $endMs - $startMs; remaining_ms = [Math]::Max(0, $CaseMaxMs - $endMs)
                    status = $state; diagnostic = if ($state -ceq 'completed') { $null } else { $LastHostQueryEvidence.diagnostic }
                })
            }
        }
    }
    if ($null -ne $failure) { throw $failure }
    if ($clock.ElapsedMilliseconds -ge $TimeoutMs) { throw [TimeoutException]::new('host proof helper completed after its allowance') }
    if ($null -ne $CaseClock) { Get-RemainingCaseMs 'host proof' | Out-Null }
    $results = @($events | Where-Object { $_.kind -ceq 'result' })
    if ($results.Count -ne 1 -or $null -eq $results[0].process) { throw 'host proof helper omitted its unique complete result' }
    if (@($events | Where-Object { $_.kind -ceq 'phase' -and $_.state -ceq 'failed' }).Count) { throw 'host proof helper reported a query failure' }
    return $results[0]
}

function Get-EditorProcessRow([int]$ProcessId, [int]$TimeoutMs = 0) {
    if ($ProcessId -ne $EditorPid) { throw 'host proof query must target the exact owned editor PID' }
    return (Invoke-HostProofQuery -TimeoutMs $TimeoutMs).process
}

function New-EditorIdentity([int]$ProcessId, [object]$ProcessRow = $null, [int]$TimeoutMs = 0) {
    $row = if ($null -eq $ProcessRow) { Get-EditorProcessRow $ProcessId $TimeoutMs } else { $ProcessRow }
    if ([int]$row.ProcessId -ne $ProcessId) { throw 'queried PID mismatch' }
    $actualExe = Resolve-FullPath ([string]$row.ExecutablePath)
    $expectedExe = Resolve-FullPath $EditorExe
    if ($actualExe -cne $expectedExe) {
        throw "Refusing PID ${ProcessId}: executable mismatch (expected $expectedExe, got $actualExe)"
    }
    if ($row.ExactSessionArgument -isnot [bool] -or -not $row.ExactSessionArgument) {
        throw "Refusing PID ${ProcessId}: command line lacks the exact survival-session argument"
    }
    if ($row.ExactProjectArgument -isnot [bool] -or -not $row.ExactProjectArgument) {
        throw "Refusing PID ${ProcessId}: command line lacks the exact disposable project argument"
    }
    if ([string]$row.CommandLineSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'process command-line digest missing' }
    return [pscustomobject]@{
        pid = $ProcessId
        executable_path = $actualExe
        creation_utc = ([DateTime]$row.CreationDate).ToUniversalTime().ToString('o')
        command_line_sha256 = [string]$row.CommandLineSha256
        session_token_sha256 = Get-SanitizedHash $SessionToken
        project_path = $ProjectPath
    }
}

function Assert-EditorIdentity {
    param([object]$ProcessRow = $null, [int]$TimeoutMs = 0)
    if ($null -eq $EditorIdentity) { throw 'editor identity was not captured' }
    $current = New-EditorIdentity $EditorPid $ProcessRow $TimeoutMs
    foreach ($field in @('pid', 'executable_path', 'creation_utc', 'command_line_sha256', 'session_token_sha256', 'project_path')) {
        if ([string]$current.$field -cne [string]$EditorIdentity.$field) {
            throw "editor identity changed at $field; refusing to continue or terminate by PID alone"
        }
    }
    return $current
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

function Get-CrashRoots {
    $roots = [Collections.Generic.List[string]]::new()
    foreach ($candidate in @(
        $CrashDir,
        (Join-Path $env:LOCALAPPDATA 'CrashReportClient\Saved\Crashes'),
        (Join-Path $env:LOCALAPPDATA 'UnrealEngine\Common\CrashReportClient\Saved\Crashes')
    )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            $full = Resolve-FullPath $candidate
            if (-not $roots.Contains($full)) { $roots.Add($full) }
        }
    }
    return @($roots)
}

function Get-CrashEvidence {
    $scanClock = [Diagnostics.Stopwatch]::StartNew()
    $scanLimitMs = $CrashScanTimeoutMs
    if ($null -ne $CaseClock) { $scanLimitMs = [Math]::Min($scanLimitMs, $CaseMaxMs - $CaseClock.ElapsedMilliseconds - 250) }
    if ($scanLimitMs -le 0) { throw 'no bounded case budget remained for crash evidence' }
    $artifacts = 0
    $filesSeen = 0
    $signatureSet = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $manifest = [Collections.Generic.List[string]]::new()
    foreach ($root in Get-CrashRoots) {
        if ($scanClock.ElapsedMilliseconds -ge $scanLimitMs) { throw 'crash evidence scan exceeded its bounded deadline' }
        if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
        $remainingDirectories = $MaxCrashDirectories - $artifacts
        $directories = @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Select-Object -First ($remainingDirectories + 1))
        foreach ($dir in $directories) {
            $artifacts++
            if ($artifacts -gt $MaxCrashDirectories) { throw "crash evidence exceeded $MaxCrashDirectories directories" }
            $dirManifest = [Collections.Generic.List[string]]::new()
            $remainingFiles = $MaxCrashFiles - $filesSeen
            $files = @(Get-ChildItem -LiteralPath $dir.FullName -File -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First ($remainingFiles + 1))
            foreach ($file in $files) {
                if ($scanClock.ElapsedMilliseconds -ge $scanLimitMs) { throw 'crash evidence scan exceeded its bounded deadline' }
                $filesSeen++
                if ($filesSeen -gt $MaxCrashFiles) { throw "crash evidence exceeded $MaxCrashFiles files" }
                $relative = [IO.Path]::GetRelativePath($root, $file.FullName)
                $entry = "$(Get-SanitizedHash $relative)|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)"
                $dirManifest.Add($entry)
                if ($file.Name -like 'CrashContext*.xml') {
                    $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read,
                        [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
                    try {
                        $readLength = [int][Math]::Min([long]$MaxCrashContextBytes, $stream.Length)
                        $bytes = [byte[]]::new($readLength)
                        $read = $stream.Read($bytes, 0, $readLength)
                        $xml = [Text.Encoding]::UTF8.GetString($bytes, 0, $read)
                    }
                    finally { $stream.Dispose() }
                    $match = [regex]::Match([string]$xml, '<PCallStackHash>([^<]+)</PCallStackHash>')
                    if ($match.Success) { [void]$signatureSet.Add((Get-SanitizedHash $match.Groups[1].Value)) }
                }
            }
            $dirState = Get-SanitizedHash @($dirManifest | Sort-Object)
            $manifest.Add("$(Get-SanitizedHash $dir.Name)|$dirState")
            if ($dirManifest.Count -eq 0) { [void]$signatureSet.Add($dirState) }
        }
    }
    if ($scanClock.ElapsedMilliseconds -ge $scanLimitMs) { throw 'crash evidence scan exceeded its bounded deadline' }
    return [pscustomobject]@{
        artifact_count = $artifacts
        scanned_file_count = $filesSeen
        signature_count = $signatureSet.Count
        state_sha256 = Get-SanitizedHash @($manifest | Sort-Object)
    }
}

function Assert-CrashEvidenceUnchanged {
    $now = Get-CrashEvidence
    if ($now.artifact_count -ne $InitialCrashEvidence.artifact_count -or
        $now.signature_count -ne $InitialCrashEvidence.signature_count -or
        $now.state_sha256 -cne $InitialCrashEvidence.state_sha256) {
        throw "crash evidence changed (artifacts $($InitialCrashEvidence.artifact_count)->$($now.artifact_count), signatures $($InitialCrashEvidence.signature_count)->$($now.signature_count))"
    }
    return $now
}

function Get-ProjectFilesystemEvidence {
    $scanClock = [Diagnostics.Stopwatch]::StartNew()
    $scanLimitMs = $FilesystemScanTimeoutMs
    if ($null -ne $CaseClock) { $scanLimitMs = [Math]::Min($scanLimitMs, $CaseMaxMs - $CaseClock.ElapsedMilliseconds - 250) }
    if ($scanLimitMs -le 0) { throw 'no bounded case budget remained for project filesystem evidence' }
    $root = Split-Path -Parent $ProjectPath
    $manifest = [Collections.Generic.List[string]]::new()
    $filesVisited = 0
    foreach ($candidate in @($ProjectPath, (Join-Path $root 'Content'), (Join-Path $root 'Config'))) {
        if ($scanClock.ElapsedMilliseconds -ge $scanLimitMs) { throw 'project filesystem evidence scan exceeded its bounded deadline' }
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $file = Get-Item -LiteralPath $candidate
            $manifest.Add("$(Get-SanitizedHash ([IO.Path]::GetRelativePath($root, $file.FullName)))|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
        }
        elseif (Test-Path -LiteralPath $candidate -PathType Container) {
            $remainingFiles = $MaxTrackedProjectFiles - $filesVisited
            $files = @(Get-ChildItem -LiteralPath $candidate -File -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First ($remainingFiles + 1))
            $filesVisited += $files.Count
            if ($filesVisited -gt $MaxTrackedProjectFiles) {
                throw "project filesystem evidence exceeded $MaxTrackedProjectFiles visited files"
            }
            foreach ($file in @($files | Where-Object { $_.Extension -in @('.uasset', '.umap', '.ini') })) {
                if ($scanClock.ElapsedMilliseconds -ge $scanLimitMs) { throw 'project filesystem evidence scan exceeded its bounded deadline' }
                $manifest.Add("$(Get-SanitizedHash ([IO.Path]::GetRelativePath($root, $file.FullName)))|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
            }
        }
    }
    if ($scanClock.ElapsedMilliseconds -ge $scanLimitMs) { throw 'project filesystem evidence scan exceeded its bounded deadline' }
    return [pscustomobject]@{
        tracked_file_count = $manifest.Count
        state_sha256 = Get-SanitizedHash @($manifest | Sort-Object)
    }
}

function Assert-ProjectFilesystemUnchanged {
    $now = Get-ProjectFilesystemEvidence
    if ($now.tracked_file_count -ne $InitialFilesystemEvidence.tracked_file_count -or
        $now.state_sha256 -cne $InitialFilesystemEvidence.state_sha256) {
        throw 'project Content/Config/.uproject filesystem baseline changed'
    }
    return $now
}

function Initialize-LogEvidence {
    $script:LogCursors = @{}
    $logs = Join-Path (Split-Path -Parent $ProjectPath) 'Saved\Logs'
    if (-not (Test-Path -LiteralPath $logs -PathType Container)) { return }
    $files = @(Get-ChildItem -LiteralPath $logs -File -Filter '*.log' -ErrorAction SilentlyContinue |
        Select-Object -First ($MaxLogFiles + 1))
    if ($files.Count -gt $MaxLogFiles) { throw "log evidence exceeded $MaxLogFiles files" }
    foreach ($file in $files) {
        $script:LogCursors[$file.FullName] = [long]$file.Length
    }
}

function Read-NewCriticalLogEvidence {
    $scanClock = [Diagnostics.Stopwatch]::StartNew()
    $scanLimitMs = $LogScanTimeoutMs
    if ($null -ne $CaseClock) { $scanLimitMs = [Math]::Min($scanLimitMs, $CaseMaxMs - $CaseClock.ElapsedMilliseconds - 250) }
    if ($scanLimitMs -le 0) { throw 'no bounded case budget remained for log evidence' }
    $logs = Join-Path (Split-Path -Parent $ProjectPath) 'Saved\Logs'
    if (-not (Test-Path -LiteralPath $logs -PathType Container)) {
        return [pscustomobject]@{ critical_count = 0; delta_bytes = 0; evidence_sha256 = Get-SanitizedHash @() }
    }
    $critical = [Collections.Generic.List[string]]::new()
    [long]$deltaBytes = 0
    $files = @(Get-ChildItem -LiteralPath $logs -File -Filter '*.log' -ErrorAction SilentlyContinue |
        Select-Object -First ($MaxLogFiles + 1))
    if ($files.Count -gt $MaxLogFiles) { throw "log evidence exceeded $MaxLogFiles files" }
    foreach ($file in $files) {
        if ($scanClock.ElapsedMilliseconds -ge $scanLimitMs) { throw 'log evidence scan exceeded its bounded deadline' }
        [long]$start = 0
        if ($LogCursors.ContainsKey($file.FullName)) { $start = [long]$LogCursors[$file.FullName] }
        if ($file.Length -lt $start) { $start = 0 }
        [long]$available = $file.Length - $start
        if ($available -gt $MaxTotalLogDeltaBytes -or $deltaBytes + $available -gt $MaxTotalLogDeltaBytes) {
            throw 'log delta exceeded the bounded total 8 MiB evidence window'
        }
        if ($available -gt 0) {
            $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read,
                [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
            try {
                $stream.Position = $start
                $bytes = [byte[]]::new([int]$available)
                $read = $stream.Read($bytes, 0, $bytes.Length)
                if ($scanClock.ElapsedMilliseconds -ge $scanLimitMs) { throw 'log evidence scan exceeded its bounded deadline' }
                $deltaBytes += $read
                $utf8 = [Text.Encoding]::UTF8.GetString($bytes, 0, $read)
                $utf16 = [Text.Encoding]::Unicode.GetString($bytes, 0, $read - ($read % 2))
                foreach ($pattern in @('Assertion failed:', 'Ensure condition failed:', 'Fatal error:', 'Unhandled Exception:', '=== Critical error:', 'LogWindows: Error:')) {
                    if ($utf8.Contains($pattern, [StringComparison]::OrdinalIgnoreCase) -or
                        $utf16.Contains($pattern, [StringComparison]::OrdinalIgnoreCase)) {
                        $critical.Add((Get-SanitizedHash "$($file.Name)|$pattern|$($file.Length)"))
                    }
                }
            }
            finally { $stream.Dispose() }
        }
        $LogCursors[$file.FullName] = [long]$file.Length
    }
    if ($scanClock.ElapsedMilliseconds -ge $scanLimitMs) { throw 'log evidence scan exceeded its bounded deadline' }
    $script:LogCriticalCount += $critical.Count
    return [pscustomobject]@{
        critical_count = $critical.Count
        delta_bytes = $deltaBytes
        evidence_sha256 = Get-SanitizedHash @($critical)
    }
}

function Get-RequiredTransportLimit([object]$Limits, [string]$Name, [int]$Minimum, [int]$Maximum) {
    if ($null -eq $Limits) { throw 'ping omitted the active transport_limits object' }
    $property = $Limits.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) { throw "active transport_limits omitted $Name" }
    [long]$value = 0
    if (-not [long]::TryParse([string]$property.Value, [ref]$value) -or $value -lt $Minimum -or $value -gt $Maximum) {
        throw "active transport limit $Name was outside the harness safety range"
    }
    return [int]$value
}

function Get-EnvironmentEvidence([object]$PingResponse) {
    $marker = '__HAYBA_ENV__'
    # Native Python policy refuses try/except to protect the cooperative
    # deadline. Metadata API failures must fail setup rather than be hidden.
    $environmentScript = @'
import json, unreal
def cv(name):
    return str(unreal.SystemLibrary.get_console_variable_string_value(name))
meta = {
    "engine_version": str(unreal.SystemLibrary.get_engine_version()),
    "project_file_path": str(unreal.Paths.get_project_file_path()),
    "project_dir": str(unreal.Paths.project_dir()),
    "rhi_name": cv("r.RHI.Name"),
    "graphics_adapter": cv("r.GraphicsAdapter"),
}
print("__HAYBA_ENV__" + json.dumps(meta, sort_keys=True))
'@
    $response = Invoke-HaybaCommand -Command 'python_run' -Params @{ script = $environmentScript; read_only = $true }
    if ($response.ok -ne $true) { throw "environment metadata probe failed: $($response.error)" }
    $match = [regex]::Match([string]$response.data.stdout, [regex]::Escape($marker) + '(\{[^\r\n]+\})')
    if (-not $match.Success) { throw 'environment metadata probe returned no parseable marker' }
    $native = $match.Groups[1].Value | ConvertFrom-Json
    $nativeProjectPath = Resolve-FullPath ([string]$native.project_file_path)
    if ($nativeProjectPath -cne $ProjectPath) {
        throw "native project identity mismatch (expected $ProjectPath, got $nativeProjectPath)"
    }

    $projectRoot = Split-Path -Parent $ProjectPath
    Assert-EditorIdentity | Out-Null
    $binaries = @()
    try {
        $binaries = @(
            (Get-Process -Id $EditorPid -ErrorAction Stop).Modules |
                Where-Object { $_.ModuleName -like 'UnrealEditor-HaybaMCP*.dll' } |
                Sort-Object FileName -Unique | ForEach-Object {
                [pscustomobject]@{
                    file_name = [IO.Path]::GetFileName($_.FileName)
                    path_sha256 = Get-SanitizedHash (Resolve-FullPath $_.FileName)
                    bytes = (Get-Item -LiteralPath $_.FileName).Length
                    file_version_sha256 = Get-SanitizedHash ([string]$_.FileVersionInfo.FileVersion)
                    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FileName).Hash.ToLowerInvariant()
                }
            }
        )
    }
    catch { throw "could not enumerate exact loaded Hayba plugin modules: $($_.Exception.Message)" }
    if ($binaries.Count -eq 0) {
        throw 'no loaded UnrealEditor-HaybaMCP*.dll module was visible in the owned editor process'
    }

    $actualByName = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($binary in $binaries) {
        if ($actualByName.ContainsKey($binary.file_name)) {
            throw "owned editor loaded duplicate Hayba module filenames: $($binary.file_name)"
        }
        $actualByName.Add($binary.file_name, $binary)
    }
    if ($actualByName.Count -ne $ArtifactExpectation.expected_dlls.Count) {
        throw 'Loaded Hayba plugin DLL set does not exactly match the operator-supplied artifact expectation'
    }
    foreach ($entry in $ArtifactExpectation.expected_dlls.GetEnumerator()) {
        if (-not $actualByName.ContainsKey($entry.Key)) {
            throw "Expected Hayba plugin DLL was not loaded: $($entry.Key)"
        }
        if ([string]$actualByName[$entry.Key].sha256 -cne [string]$entry.Value) {
            throw "Loaded Hayba plugin DLL hash mismatch: $($entry.Key)"
        }
    }

    $exeInfo = (Get-Item -LiteralPath $EditorExe).VersionInfo
    $pluginVersion = [string]$PingResponse.data.pluginVersion
    if ($pluginVersion.Length -gt 64 -or $pluginVersion -cnotmatch '^[0-9A-Za-z._+-]*$') {
        throw 'ping returned an invalid pluginVersion evidence value'
    }
    return [pscustomobject]@{
        captured_utc = [DateTime]::UtcNow.ToString('o')
        artifact_attestation_mode = $ArtifactExpectation.mode
        source_commit = $ArtifactExpectation.source_commit
        source_worktree_clean = $ArtifactExpectation.source_worktree_clean
        artifact_manifest_sha256 = $ArtifactExpectation.manifest_sha256
        editor_file_version = [string]$exeInfo.FileVersion
        editor_product_version = [string]$exeInfo.ProductVersion
        editor_identity = $EditorIdentity
        project_name = [IO.Path]::GetFileNameWithoutExtension($ProjectPath)
        project_path = $ProjectPath
        disposable_marker_sha256 = Get-SanitizedHash (Get-Content -Raw -LiteralPath (Join-Path $projectRoot $DisposableMarkerName))
        engine = [pscustomobject]@{
            engine_version_sha256 = Get-SanitizedHash ([string]$native.engine_version)
            project_file_path_sha256 = Get-SanitizedHash ([string]$native.project_file_path)
            project_dir_sha256 = Get-SanitizedHash ([string]$native.project_dir)
            rhi_name_sha256 = Get-SanitizedHash ([string]$native.rhi_name)
            graphics_adapter_sha256 = Get-SanitizedHash ([string]$native.graphics_adapter)
        }
        plugin_version_sha256 = Get-SanitizedHash $pluginVersion
        capabilities_sha256 = Get-SanitizedHash $PingResponse.data.capabilities
        transport_limits = $ActiveTransportLimits
        loaded_plugin_binaries = $binaries
        loaded_plugin_binary_count = $binaries.Count
        rhi_evidence_kind = 'python_console_variable_readback'
    }
}

try {
if (-not (Test-Path -LiteralPath $EditorExe -PathType Leaf)) {
    throw "Editor executable not found: $EditorExe"
}
$EditorExe = (Resolve-Path -LiteralPath $EditorExe).Path
if ([string]::IsNullOrWhiteSpace($ProjectPath) -or
    -not (Test-Path -LiteralPath $ProjectPath -PathType Leaf)) {
    throw 'ProjectPath must name the exact disposable .uproject in launch and attach modes'
}
$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
if ([IO.Path]::GetExtension($ProjectPath) -cne '.uproject') {
    throw "ProjectPath is not a .uproject: $ProjectPath"
}
Assert-DisposableProject $ProjectPath
$ArtifactExpectation = Resolve-ArtifactExpectation

$expectedCrashDir = Resolve-FullPath (Join-Path (Split-Path -Parent $ProjectPath) 'Saved\Crashes')
if ([string]::IsNullOrWhiteSpace($CrashDir)) { $CrashDir = $expectedCrashDir }
else {
    $CrashDir = Resolve-FullPath $CrashDir
    if ($CrashDir -cne $expectedCrashDir) {
        throw "CrashDir must be the disposable project's Saved\Crashes directory: $expectedCrashDir"
    }
}
# Snapshot before launch/hostile traffic. Startup crashes and modifications to
# an existing artifact are evidence, not just newly-named child directories.
$InitialCrashEvidence = Get-CrashEvidence
$InitialFilesystemEvidence = Get-ProjectFilesystemEvidence
Initialize-LogEvidence

# One clock covers launch/attach setup, identity, listener and game-thread
# readiness. Opening the listener alone does not mean frame-zero work is done.
$StartupClock = [Diagnostics.Stopwatch]::StartNew()
if ($EditorPid -eq 0) {
    if ([string]::IsNullOrWhiteSpace($SessionToken)) {
        $SessionToken = [guid]::NewGuid().ToString('N')
    }
    Assert-SessionTokenShape $SessionToken

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
    $OwnsTarget = $true
}
else {
    Assert-SessionTokenShape $SessionToken
    if (-not $TakeOwnership) {
        throw 'Attach mode requires -TakeOwnership because hostile mode always tears down its disposable target'
    }
    if (-not (Get-Process -Id $EditorPid -ErrorAction SilentlyContinue)) {
        throw "editor PID $EditorPid does not exist"
    }
    $OwnsTarget = $true
}

if ($Port -ne 0 -and ($Port -lt 52342 -or $Port -gt 52350)) {
    throw "Port must be 0 for owned discovery or an explicit Hayba port in 52342-52350; got $Port"
}

function Get-ListenerOwner {
    param([object[]]$Owners, [int]$TimeoutMs = 0)
    if (-not $PSBoundParameters.ContainsKey('Owners')) {
        $proof = Invoke-HostProofQuery -IncludeListener -TimeoutMs $TimeoutMs
        Assert-EditorIdentity -ProcessRow $proof.process | Out-Null
        $Owners = @($proof.listener_owners)
    }
    $unique = @($Owners | Select-Object -Unique)
    if ($unique.Count -ne 1) { throw "Expected exactly one listener on port $Port; found $($unique.Count)" }
    if ([int]$unique[0] -ne $EditorPid) { throw "listener ownership changed: expected PID $EditorPid, got $($unique[0])" }
    return [int]$unique[0]
}

function Get-RemainingStartupMs {
    $remaining = $StartupTimeoutMs - $StartupClock.ElapsedMilliseconds
    # The transport accepts 100..60000ms. Never round the remaining allowance
    # up, reset it on retry, or borrow from a subsequent hostile case.
    if ($remaining -lt 100) { throw "exhausted the absolute ${StartupTimeoutMs}ms startup deadline" }
    return [int][Math]::Min($remaining, 60000)
}

function Wait-EditorReady {
    $script:StartupReadinessEvidence = [pscustomobject]@{
        ready = $false
        request_id_correlated = $false
        attempts = 0
        transport_timeouts = 0
        elapsed_ms = 0
        timeout_ms = $StartupTimeoutMs
    }
    try {
        # Capture identity even if launch consumed the deadline, so failure
        # cleanup can still verify and close the owned process safely.
        $script:EditorIdentity = New-EditorIdentity $EditorPid
        while ($true) {
            Get-RemainingStartupMs | Out-Null
            Assert-EditorIdentity -TimeoutMs (Get-RemainingStartupMs) | Out-Null
            if ($Port -eq 0) {
                $script:Port = Find-OwnedMcpPort $EditorPid
                if ($Port -eq 0) {
                    Start-Sleep -Milliseconds ([Math]::Min(250, (Get-RemainingStartupMs)))
                    continue
                }
            }
            if ((Get-ListenerOwner -TimeoutMs (Get-RemainingStartupMs)) -ne $EditorPid) { throw 'startup listener ownership changed' }
            $timeout = Get-RemainingStartupMs
            $StartupReadinessEvidence.attempts++
            try {
                # Each invocation generates a fresh ID and validates its reply.
                $text = & $Invoker -Cmd 'ping' -ParamsJson '{}' -Port $Port -TimeoutMs $timeout -Auth $Auth -Owner $SurvivalOwner -ThrowOnTimeout
            }
            catch [TimeoutException] {
                $StartupReadinessEvidence.transport_timeouts++
                continue
            }
            if ($LASTEXITCODE -ne 0) { throw 'startup transport failed for ping' }
            $response = $text | ConvertFrom-Json
            if ($response.ok -isnot [bool] -or $response.ok -ne $true) { throw 'startup readiness ping was malformed or refused' }
            Get-RemainingStartupMs | Out-Null
            Assert-EditorIdentity -TimeoutMs (Get-RemainingStartupMs) | Out-Null
            if ((Get-ListenerOwner -TimeoutMs (Get-RemainingStartupMs)) -ne $EditorPid) { throw 'startup listener ownership changed' }
            Get-RemainingStartupMs | Out-Null
            $StartupReadinessEvidence.ready = $true
            $StartupReadinessEvidence.request_id_correlated = $true
            return $response
        }
    }
    finally { $StartupReadinessEvidence.elapsed_ms = $StartupClock.ElapsedMilliseconds }
}

function Get-RemainingCaseMs([string]$Operation = 'case operation') {
    if ($null -eq $CaseClock) { return $MaxCaseMs }
    $remaining = $CaseMaxMs - [long]$CaseClock.ElapsedMilliseconds
    if ($remaining -lt 100) { throw [TimeoutException]::new("$Operation exhausted the absolute ${CaseMaxMs}ms case deadline") }
    return [Math]::Min($remaining, 60000)
}

function Invoke-HaybaCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [hashtable]$Params = @{}
    )
    $json = $Params | ConvertTo-Json -Compress -Depth 30
    $timeout = Get-RemainingCaseMs "transport for $Command"
    $text = & $Invoker -Cmd $Command -ParamsJson $json -Port $Port -TimeoutMs $timeout -Auth $Auth -Owner $SurvivalOwner
    if ($LASTEXITCODE -ne 0) { throw "transport failed for $Command" }
    if ($null -ne $CaseClock) { Get-RemainingCaseMs "transport for $Command" | Out-Null }
    $response = $text | ConvertFrom-Json
    $isPlanModeRequired = [string]$response.data.status -ceq 'plan_mode_required' -or
        [string]$response.status -ceq 'plan_mode_required' -or
        [string]$response.code -ceq 'plan_mode_required'
    if ($isPlanModeRequired) {
        throw "Plan Mode blocked $Command; the survival harness will not disable, bypass, or auto-approve production policy. Preconfigure only the marked disposable project for this opt-in run, restart it, and preserve that setting in the evidence bundle."
    }
    return $response
}

function Get-EditorState {
    $response = Invoke-HaybaCommand -Command 'editor_get_state'
    if ($response.ok -ne $true) { throw "editor-state probe failed: $($response.error)" }
    return [pscustomobject]@{
        map = [string]$response.data.map
        pie_running = [bool]$response.data.pie_running
        dirty_packages = @($response.data.dirty_packages | ForEach-Object { [string]$_ } | Sort-Object -Unique)
        dirty_count = [int]$response.data.dirty_count
    }
}

function Test-BenignPythonNonce {
    param([bool]$ExpectPolicyRefusal = $false)
    $nonce = [guid]::NewGuid().ToString('N')
    $marker = "__HAYBA_NONCE__$nonce"
    $response = Invoke-HaybaCommand -Command 'python_run' -Params @{ script = "print('$marker')"; read_only = $true }
    if ($ExpectPolicyRefusal) {
        if ($response.ok -isnot [bool] -or $response.ok -ne $false -or
            $response.code -isnot [string] -or $response.code -cne 'pie_active' -or
            -not [string]::IsNullOrEmpty([string]$response.data.stdout) -or
            -not [string]::IsNullOrEmpty([string]$response.stdout) -or
            ($response | ConvertTo-Json -Compress -Depth 30).Contains($marker, [StringComparison]::Ordinal)) {
            throw 'PIE Python admission probe did not prove the exact unexecuted pie_active refusal'
        }
        return [pscustomobject]@{ executed = $false; nonce_ok = $null; nonce_sha256 = $null; policy_refusal_ok = $true }
    }
    if ($response.ok -ne $true) { throw "benign Python nonce failed: $($response.error)" }
    if (-not ([string]$response.data.stdout).Contains($marker, [StringComparison]::Ordinal)) {
        throw 'benign Python nonce response did not correlate to the generated nonce'
    }
    return [pscustomobject]@{ executed = $true; nonce_ok = $true; nonce_sha256 = Get-SanitizedHash $nonce; policy_refusal_ok = $false }
}

function Assert-CaseTarget([object]$ExpectedPieRunning = $null) {
    # Use the same complete health proof both before and after every case. This
    # prevents a previous case's delayed failure from being attributed to the
    # next hostile input and gives each result correlated native pre/post proof
    # plus nonce execution outside PIE or exact admission refusal during PIE.
    return Assert-EditorHealthy -ExpectedPieRunning $ExpectedPieRunning
}

function Assert-EditorHealthy {
    param([object]$ExpectedPieRunning = $null)
    $proof = Invoke-CasePhase "$HealthPhasePrefix.host_query" { Invoke-HostProofQuery -IncludeListener }
    Invoke-CasePhase "$HealthPhasePrefix.identity_validation" { Assert-EditorIdentity -ProcessRow $proof.process } | Out-Null
    $owner = Invoke-CasePhase "$HealthPhasePrefix.listener_validation" { Get-ListenerOwner -Owners @($proof.listener_owners) }
    $ping = Invoke-CasePhase "$HealthPhasePrefix.ping" { Invoke-HaybaCommand -Command 'ping' }
    if ($ping.ok -ne $true) { throw "fresh correlated ping failed: $($ping | ConvertTo-Json -Compress)" }
    $state = Invoke-CasePhase "$HealthPhasePrefix.state" { Get-EditorState }
    $expectedPie = if ($null -eq $ExpectedPieRunning) { $InitialEditorState.pie_running } else { [bool]$ExpectedPieRunning }
    if ($state.map -cne $InitialEditorState.map -or $state.pie_running -ne $expectedPie) {
        throw "editor world baseline changed (map '$($InitialEditorState.map)' -> '$($state.map)', expected PIE $expectedPie, got $($state.pie_running))"
    }
    $dirtyNow = @($state.dirty_packages)
    $dirtyBefore = @($InitialEditorState.dirty_packages)
    $addedDirty = @($dirtyNow | Where-Object { $_ -notin $dirtyBefore })
    $removedDirty = @($dirtyBefore | Where-Object { $_ -notin $dirtyNow })
    if ($addedDirty.Count -gt 0 -or $removedDirty.Count -gt 0) {
        throw "dirty-package baseline changed (added: $($addedDirty -join ', '); removed: $($removedDirty -join ', '))"
    }
    # An unexpected PIE state is fatal before selecting the Python admission
    # expectation. The successful native read is correlated by the invoker.
    $pythonProof = Invoke-CasePhase "$HealthPhasePrefix.python" { Test-BenignPythonNonce -ExpectPolicyRefusal $expectedPie }
    $crash = Invoke-CasePhase "$HealthPhasePrefix.crash" { Assert-CrashEvidenceUnchanged }
    $filesystem = Invoke-CasePhase "$HealthPhasePrefix.filesystem" { Assert-ProjectFilesystemUnchanged }
    $log = Invoke-CasePhase "$HealthPhasePrefix.log" { Read-NewCriticalLogEvidence }
    if ($log.critical_count -gt 0) {
        throw "new Unreal fatal/assert/ensure log evidence detected ($($log.critical_count) bounded signature(s))"
    }
    return [pscustomobject]@{
        same_pid_alive = $true
        exact_identity = $true
        listener_owner = $owner
        nonce_correlated_ping_ok = $true
        native_state_request_id_correlated = $true
        python_nonce_executed = $pythonProof.executed
        python_nonce_ok = $pythonProof.nonce_ok
        python_nonce_sha256 = $pythonProof.nonce_sha256
        python_policy_refusal_ok = $pythonProof.policy_refusal_ok
        pie_state_expected = $expectedPie
        map_baseline_unchanged = $true
        crash_artifact_delta = $crash.artifact_count - $InitialCrashEvidence.artifact_count
        crash_signature_delta = $crash.signature_count - $InitialCrashEvidence.signature_count
        critical_log_delta = $log.critical_count
        dirty_package_delta = 0
        filesystem_delta = 0
        tracked_file_count = $filesystem.tracked_file_count
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
    $safeDetail = New-DiagnosticDigest $Detail 'case_detail'
    $Results.Add([pscustomobject]@{
        test_id = $Name
        name = $Name
        command = $Command
        sanitized_params_sha256 = $ParamsHash
        passed = $Passed
        duration_ms = $DurationMs
        case_deadline_ms = if ($null -ne $CaseClock) { $CaseMaxMs } else { $null }
        editor_pid = $EditorPid
        recovery = $Recovery
        preflight = if ($null -ne $CaseClock) { $CasePreflight } else { $null }
        hostile_duration_ms = if ($null -ne $CaseClock) { $HostileDurationMs } else { $null }
        phases = if ($null -ne $CaseClock) { @($CasePhases.ToArray()) } else { @() }
        host_query = $LastHostQueryEvidence
        detail = $safeDetail
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
    Start-CaseBudget
    $clock = $CaseClock
    $paramsHash = Get-SanitizedHash $Params
    try {
        $preflight = Assert-CaseTarget
        $script:CasePreflight = $preflight
        $response = Invoke-CasePhase 'hostile.command' { Invoke-HaybaCommand -Command $Command -Params $Params }
        if ($response.ok -ne $false) {
            throw "expected ok:false, got $($response | ConvertTo-Json -Compress -Depth 20)"
        }
        if ($ErrorPattern -and [string]$response.error -notmatch $ErrorPattern) {
            throw "error did not match /$ErrorPattern/: $($response.error)"
        }
        if ($HostileDurationMs -lt $MinDurationMs) {
            throw "hostile command returned in ${HostileDurationMs}ms; expected the runtime deadline path after at least ${MinDurationMs}ms"
        }
        $script:HealthPhasePrefix = 'recovery'
        $recovery = Assert-EditorHealthy
        $recovery | Add-Member -NotePropertyName preflight -NotePropertyValue $preflight -Force
        if ($clock.ElapsedMilliseconds -gt $CaseMaxMs) { throw "case exceeded ${CaseMaxMs}ms" }
        Add-Result $Name $true $clock.ElapsedMilliseconds ([string]$response.error) $Command $paramsHash $recovery
    }
    catch {
        Add-Result $Name $false $clock.ElapsedMilliseconds $_.Exception.Message $Command $paramsHash
        throw
    }
    finally { $script:CaseClock = $null }
}

function Test-CommandSuccess {
    param(
        [string]$Name,
        [string]$Command,
        [hashtable]$Params = @{},
        [int]$SettleMs = 0,
        [object]$ExpectedPrePieRunning = $null,
        [object]$ExpectedPieRunning = $null,
        [scriptblock]$VerifyResponse = $null
    )
    Start-CaseBudget
    $clock = $CaseClock
    $paramsHash = Get-SanitizedHash $Params
    try {
        $preflight = Assert-CaseTarget -ExpectedPieRunning $ExpectedPrePieRunning
        $script:CasePreflight = $preflight
        $response = Invoke-CasePhase 'hostile.command' { Invoke-HaybaCommand -Command $Command -Params $Params }
        if ($response.ok -ne $true) {
            throw "expected ok:true, got $($response | ConvertTo-Json -Compress -Depth 20)"
        }
        if ($null -ne $VerifyResponse) { & $VerifyResponse $response }
        if ($SettleMs -gt 0) {
            if ((Get-RemainingCaseMs 'settle') -le $SettleMs) { throw 'settle would exceed the case deadline' }
            Start-Sleep -Milliseconds $SettleMs
        }
        $script:HealthPhasePrefix = 'recovery'
        $recovery = Assert-EditorHealthy -ExpectedPieRunning $ExpectedPieRunning
        $recovery | Add-Member -NotePropertyName preflight -NotePropertyValue $preflight -Force
        if ($clock.ElapsedMilliseconds -gt $CaseMaxMs) { throw "case exceeded ${CaseMaxMs}ms" }
        Add-Result $Name $true $clock.ElapsedMilliseconds 'command completed; editor, listener, dirty baseline, and fresh ping survived' $Command $paramsHash $recovery
    }
    catch {
        Add-Result $Name $false $clock.ElapsedMilliseconds $_.Exception.Message $Command $paramsHash
        throw
    }
    finally { $script:CaseClock = $null }
}

function Wait-RawTask([Threading.Tasks.Task]$Task, [string]$Operation) {
    $remaining = Get-RemainingCaseMs $Operation
    if (-not $Task.Wait($remaining)) { throw "$Operation exceeded the absolute case deadline" }
    return $Task.GetAwaiter().GetResult()
}

function Open-BoundedClient {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        Wait-RawTask ($client.ConnectAsync('127.0.0.1', $Port)) 'raw connect' | Out-Null
        return $client
    }
    catch {
        $client.Dispose()
        throw
    }
}

function Write-BoundedBytes([Net.Sockets.NetworkStream]$Stream, [byte[]]$Bytes, [string]$Operation) {
    if ($Bytes.Length -gt 0) {
        Wait-RawTask ($Stream.WriteAsync($Bytes, 0, $Bytes.Length)) $Operation | Out-Null
    }
}

function Read-BoundedExact([Net.Sockets.NetworkStream]$Stream, [byte[]]$Bytes, [int]$Count, [string]$Operation) {
    $read = 0
    while ($read -lt $Count) {
        $bytesRead = Wait-RawTask ($Stream.ReadAsync($Bytes, $read, $Count - $read)) $Operation
        if ($bytesRead -le 0) { throw "connection closed before $Operation" }
        $read += $bytesRead
    }
}

function Send-RawFrame {
    param(
        [byte[]]$Header,
        [byte[]]$Body = @(),
        [bool]$ReadResponse = $false,
        [switch]$HalfCloseSend,
        [switch]$ExpectPeerClose
    )
    $client = Open-BoundedClient
    try {
        $stream = $client.GetStream()
        Write-BoundedBytes $stream $Header 'raw header write'
        Write-BoundedBytes $stream $Body 'raw body write'
        Wait-RawTask ($stream.FlushAsync()) 'raw flush' | Out-Null
        if ($HalfCloseSend) {
            $client.Client.Shutdown([Net.Sockets.SocketShutdown]::Send)
        }
        if ($ExpectPeerClose) {
            Wait-ForBoundedPeerClose $stream 'malformed frame peer close' | Out-Null
            return ''
        }
        if (-not $ReadResponse) { return '' }

        $lengthBytes = [byte[]]::new(4)
        Read-BoundedExact $stream $lengthBytes 4 'response header'
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($lengthBytes) }
        $length = [BitConverter]::ToInt32($lengthBytes, 0)
        if ($length -le 0 -or $length -gt 8MB) { throw "invalid response length $length" }
        $bytes = [byte[]]::new($length)
        Read-BoundedExact $stream $bytes $length 'response body'
        return ([Text.UTF8Encoding]::new($false, $true)).GetString($bytes)
    }
    finally {
        $client.Dispose()
    }
}

function Get-BigEndianHeader([uint32]$Length) {
    return [byte[]]@(
        (($Length -shr 24) -band 0xff),
        (($Length -shr 16) -band 0xff),
        (($Length -shr 8) -band 0xff),
        ($Length -band 0xff)
    )
}

function New-RawCommandFrame([string]$Command, [hashtable]$Params, [string]$Id) {
    $request = @{ cmd = $Command; id = $Id; params = $Params; owner = $SurvivalOwner }
    if ($Auth) { $request.auth = $Auth }
    $body = [Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Compress -Depth 30))
    return [pscustomobject]@{ header = Get-BigEndianHeader $body.Length; body = $body; id = $Id }
}

function Wait-ForBoundedPeerClose([Net.Sockets.NetworkStream]$Stream, [string]$Operation) {
    # The caller retains its valid stream across send-side half-close; asking
    # TcpClient.GetStream again after Shutdown(Send) can reject that socket.
    $buffer = [byte[]]::new(4096)
    while ($true) {
        $count = Wait-RawTask ($Stream.ReadAsync($buffer, 0, $buffer.Length)) $Operation
        if ($count -eq 0) { return $true }
    }
}

function Get-RawTerminalSocketError([Exception]$Exception) {
    $cause = $Exception
    while ($null -ne $cause -and $cause -isnot [Net.Sockets.SocketException]) { $cause = $cause.InnerException }
    if ($null -ne $cause -and $cause.SocketErrorCode -in @(
        [Net.Sockets.SocketError]::ConnectionReset, [Net.Sockets.SocketError]::ConnectionAborted)) { return $cause }
    return $null
}

function Get-RawCloseEvidence([Threading.Tasks.Task]$Task, [string]$Operation) {
    try {
        $count = Wait-RawTask $Task $Operation
    }
    catch {
        # Only demonstrated terminal socket errors are close evidence. Deadline,
        # binding, disposal, and unrelated helper failures must remain fatal.
        $cause = Get-RawTerminalSocketError $_.Exception
        if ($null -eq $cause) { throw }
        return [pscustomobject]@{ kind='socket_error'; socket_error=[string]$cause.SocketErrorCode }
    }
    if ($count -ne 0) { throw "$Operation received response bytes instead of peer closure" }
    return [pscustomobject]@{ kind='eof'; socket_error=$null }
}

function Initialize-RawCloseObservation {
    if ('HaybaRawCloseObservation' -as [type]) { return }
    # Capture monotonic time in the async read completion, before PowerShell
    # polling. A Task.Delay race measures timer scheduling rather than expiry.
    Add-Type -TypeDefinition @'
using System.Diagnostics;
using System.Net.Sockets;
using System.Threading.Tasks;
public sealed class HaybaRawCloseObservation {
    public long ElapsedMs;
    public Task<int> ReadTask;
    public static HaybaRawCloseObservation Start(NetworkStream stream, Stopwatch clock) {
        var observation = new HaybaRawCloseObservation();
        observation.ReadTask = observation.ReadAsync(stream, clock);
        return observation;
    }
    private async Task<int> ReadAsync(NetworkStream stream, Stopwatch clock) {
        try { return await stream.ReadAsync(new byte[1], 0, 1).ConfigureAwait(false); }
        finally { ElapsedMs = clock.ElapsedMilliseconds; }
    }
}
'@
}

function New-AdmittedRawHolder($Clients, [string]$Operation) {
    $client = Open-BoundedClient
    # Own the current iteration before GetStream or either write can fail.
    $Clients.Add($client)
    $stream = $client.GetStream()
    $frame = New-RawCommandFrame 'ping' @{} ('admission_' + [guid]::NewGuid().ToString('N'))
    Write-BoundedBytes $stream $frame.header "$Operation admission header"
    Write-BoundedBytes $stream $frame.body "$Operation admission body"
    $header = [byte[]]::new(4)
    Read-BoundedExact $stream $header 4 "$Operation admission response header"
    if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($header) }
    $length = [BitConverter]::ToInt32($header, 0)
    if ($length -le 0 -or $length -gt 8MB) { throw "$Operation admission response length was invalid" }
    $body = [byte[]]::new($length)
    Read-BoundedExact $stream $body $length "$Operation admission response body"
    $response = ([Text.UTF8Encoding]::new($false, $true)).GetString($body) | ConvertFrom-Json
    if ($response.ok -isnot [bool] -or $response.ok -ne $true -or [string]$response.id -cne $frame.id) {
        throw "$Operation admission ping was refused or uncorrelated"
    }
    return [pscustomobject]@{
        stream=$stream; id=$frame.id; clock=$null; close_task=$null; close_observation=$null;
        drips=0; last_progress_ms=0; max_progress_gap_ms=0
    }
}

function New-PartialFrameHolders($Clients, [string]$Operation) {
    Initialize-RawCloseObservation
    $holders = [Collections.Generic.List[object]]::new()
    # Finish admission before starting any partial-frame clock. TCP connection
    # or a successful write alone never proves application participation.
    for ($i = 0; $i -lt $ConfiguredMaxClients; $i++) {
        $holder = New-AdmittedRawHolder $Clients $Operation
        $holders.Add($holder)
        $script:RawProbeEvidence.admitted++
    }
    foreach ($holder in $holders) {
        $holder.clock = [Diagnostics.Stopwatch]::StartNew()
        Write-BoundedBytes $holder.stream (Get-BigEndianHeader 512) "$Operation partial header"
        Write-BoundedBytes $holder.stream ([byte[]]@(0x7b)) "$Operation initial body byte"
        $holder.last_progress_ms = $holder.clock.ElapsedMilliseconds
        $holder.close_observation = [HaybaRawCloseObservation]::Start($holder.stream, $holder.clock)
        $holder.close_task = $holder.close_observation.ReadTask
    }
    return ,$holders
}

function Assert-PartialHoldersActive($Holders, [string]$Operation) {
    foreach ($holder in $Holders) {
        if ($holder.close_task.IsCompleted -or $holder.clock.ElapsedMilliseconds -ge $FrameReadTimeoutMs) {
            throw "$Operation lost an admitted holder or exceeded its active partial-frame lifetime"
        }
    }
}

function Invoke-PartialFrameCapacityProbe([int]$OverflowCount, [string]$Operation) {
    $clients = [Collections.Generic.List[Net.Sockets.TcpClient]]::new()
    $script:RawProbeEvidence = [pscustomobject]@{
        configured_max_clients=$ConfiguredMaxClients; frame_timeout_ms=$FrameReadTimeoutMs;
        admitted=0; closures=[Collections.Generic.List[object]]::new(); disposed=0
    }
    try {
        $holders = New-PartialFrameHolders $clients $Operation
        for ($i = 0; $i -lt $OverflowCount; $i++) {
            Assert-PartialHoldersActive $holders $Operation
            $extra = Open-BoundedClient
            $clients.Add($extra)
            $stream = $extra.GetStream()
            $closeTask = $stream.ReadAsync([byte[]]::new(1), 0, 1)
            $frame = New-RawCommandFrame 'ping' @{} ('overflow_' + [guid]::NewGuid().ToString('N'))
            try {
                Write-BoundedBytes $stream $frame.header "$Operation overflow header"
                Write-BoundedBytes $stream $frame.body "$Operation overflow body"
            }
            catch {
                # A terminal write error is not by itself rejection evidence;
                # still require EOF/reset from the retained valid stream.
                if ($null -eq (Get-RawTerminalSocketError $_.Exception)) { throw }
            }
            $closure = Get-RawCloseEvidence $closeTask "$Operation overflow close"
            Assert-PartialHoldersActive $holders $Operation
            $script:RawProbeEvidence.closures.Add($closure)
        }
    }
    finally {
        foreach ($client in $clients) { $client.Dispose(); $script:RawProbeEvidence.disposed++ }
    }
}

function Invoke-SlowlorisDeadlineProbe {
    $clients = [Collections.Generic.List[Net.Sockets.TcpClient]]::new()
    $closed = [Collections.Generic.HashSet[int]]::new()
    $script:RawProbeEvidence = [pscustomobject]@{
        configured_max_clients=$ConfiguredMaxClients; frame_timeout_ms=$FrameReadTimeoutMs;
        admitted=0; drips=0; closures=[Collections.Generic.List[object]]::new(); disposed=0
    }
    try {
        $holders = New-PartialFrameHolders $clients 'slowloris'
        $interval = [Math]::Max(20, [Math]::Min(500, [int]($FrameReadTimeoutMs / 3)))
        $nextDrip = $interval
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while ($closed.Count -lt $holders.Count) {
            Get-RemainingCaseMs 'slowloris observation' | Out-Null
            for ($i = 0; $i -lt $holders.Count; $i++) {
                if ($closed.Contains($i)) { continue }
                $holder = $holders[$i]
                if ($holder.close_task.IsCompleted) {
                    $elapsed = $holder.close_observation.ElapsedMs
                    if ($elapsed -lt $FrameReadTimeoutMs) { throw 'slowloris holder closed prematurely before the total-frame deadline' }
                    $closure = Get-RawCloseEvidence $holder.close_task 'slowloris total-deadline peer close'
                    $gap = $elapsed - $holder.last_progress_ms
                    if ($holder.drips -eq 0 -or $gap -ge $FrameReadTimeoutMs) { throw 'slowloris closure did not demonstrate continued partial-frame progress' }
                    $closure | Add-Member -NotePropertyName elapsed_ms -NotePropertyValue $elapsed
                    $closure | Add-Member -NotePropertyName drips -NotePropertyValue $holder.drips
                    $closure | Add-Member -NotePropertyName max_progress_gap_ms -NotePropertyValue ([Math]::Max($gap, $holder.max_progress_gap_ms))
                    $script:RawProbeEvidence.closures.Add($closure)
                    [void]$closed.Add($i)
                    continue
                }
                if ($clock.ElapsedMilliseconds -ge $nextDrip) {
                    try {
                        Write-BoundedBytes $holder.stream ([byte[]]@(0x20)) 'slowloris drip byte'
                        $completedMs = $holder.clock.ElapsedMilliseconds
                        if (-not $holder.close_task.IsCompleted) {
                            # The gap spans successful completions, including
                            # all time spent awaiting this write.
                            $gap = $completedMs - $holder.last_progress_ms
                            if ($gap -ge $FrameReadTimeoutMs) { throw 'slowloris drip interval exceeded the active frame timeout' }
                            $holder.max_progress_gap_ms = [Math]::Max($gap, $holder.max_progress_gap_ms)
                            $holder.last_progress_ms = $completedMs
                            $holder.drips++
                            $script:RawProbeEvidence.drips++
                        }
                    }
                    catch {
                        if ($null -eq (Get-RawTerminalSocketError $_.Exception)) { throw }
                        # The pending read and its completion time must prove expiry.
                    }
                }
            }
            if ($clock.ElapsedMilliseconds -ge $nextDrip) { $nextDrip = $clock.ElapsedMilliseconds + $interval }
            if ($closed.Count -lt $holders.Count) {
                $remaining = Get-RemainingCaseMs 'slowloris observation sleep'
                Start-Sleep -Milliseconds ([Math]::Min(20, $remaining))
            }
        }
    }
    finally {
        foreach ($client in $clients) { $client.Dispose(); $script:RawProbeEvidence.disposed++ }
    }
}

function Get-SlowlorisCaseBudgetMs {
    # This probe must wait for the server's total-frame timeout while all
    # admitted clients continue making progress. Keep complete preflight and
    # postflight health proofs inside the same finite case deadline; the
    # ordinary MaxCaseMs remains unchanged for every other hostile case.
    return [Math]::Max($MaxCaseMs, ($FrameReadTimeoutMs + 12000))
}

function Test-RawCase {
    param(
        [string]$Name,
        [scriptblock]$Action,
        [int]$BudgetMs = $MaxCaseMs
    )
    Start-CaseBudget -BudgetMs $BudgetMs
    $clock = $CaseClock
    $script:RawProbeEvidence = $null
    try {
        $preflight = Assert-CaseTarget
        $script:CasePreflight = $preflight
        Invoke-CasePhase 'hostile.action' $Action | Out-Null
        if ((Get-RemainingCaseMs 'raw settle') -le 150) { throw 'raw settle would exceed the case deadline' }
        Start-Sleep -Milliseconds 150
        $script:HealthPhasePrefix = 'recovery'
        $recovery = Assert-EditorHealthy
        $recovery | Add-Member -NotePropertyName preflight -NotePropertyValue $preflight -Force
        if ($clock.ElapsedMilliseconds -gt $CaseMaxMs) { throw "case exceeded ${CaseMaxMs}ms" }
        Add-Result $Name $true $clock.ElapsedMilliseconds 'connection rejected; editor and listener survived' 'raw_frame' (Get-SanitizedHash @{ case = $Name }) $recovery
    }
    catch {
        Add-Result $Name $false $clock.ElapsedMilliseconds $_.Exception.Message 'raw_frame' (Get-SanitizedHash @{ case = $Name })
        throw
    }
    finally {
        if ($null -ne $RawProbeEvidence) {
            $Results[$Results.Count - 1] | Add-Member -NotePropertyName probe_evidence -NotePropertyValue $RawProbeEvidence
        }
        $script:CaseClock = $null
    }
}

function Wait-OwnedProcessExit([int]$TimeoutMs) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.ElapsedMilliseconds -lt $TimeoutMs) {
        if (-not (Get-Process -Id $EditorPid -ErrorAction SilentlyContinue)) { return $true }
        try { Assert-EditorIdentity -TimeoutMs ([int][Math]::Min($MaxCaseMs, $TimeoutMs - $clock.ElapsedMilliseconds)) | Out-Null }
        catch {
            # A graceful exit can race the identity read. Treat only confirmed
            # absence as success; a live mismatched/reused PID remains fatal.
            if (-not (Get-Process -Id $EditorPid -ErrorAction SilentlyContinue)) { return $true }
            throw
        }
        Start-Sleep -Milliseconds 250
    }
    return -not [bool](Get-Process -Id $EditorPid -ErrorAction SilentlyContinue)
}

function Stop-OwnedEditorWithEvidence {
    $script:CleanupAttempted = $true
    if (-not $OwnsTarget) {
        return [pscustomobject]@{ passed = $false; mode = 'not_owned'; exited = $false; forced_recovery = $false }
    }
    if (-not (Get-Process -Id $EditorPid -ErrorAction SilentlyContinue)) {
        return [pscustomobject]@{ passed = $false; mode = 'unexpected_prior_exit'; exited = $true; forced_recovery = $false }
    }

    Assert-EditorIdentity | Out-Null
    # Query/identity failure stops cleanup. Only listener availability may
    # select the already-authorized owned-window fallback below.
    $proof = Invoke-HostProofQuery -IncludeListener
    Assert-EditorIdentity -ProcessRow $proof.process | Out-Null
    $listenerOwned = $false
    try {
        $listenerOwned = (Get-ListenerOwner -Owners @($proof.listener_owners)) -eq $EditorPid
    }
    catch {}
    $state = $null
    if ($listenerOwned) { try { $state = Get-EditorState } catch {} }
    $cleanForGraceful = $null -ne $state -and -not $state.pie_running -and $state.dirty_count -eq 0
    $gracefulRequested = $false
    $gracefulMethod = ''
    $shutdownResponseHash = ''
    if ($cleanForGraceful -and $listenerOwned) {
        try {
            $response = Invoke-HaybaCommand -Command 'editor_save_all_and_quit' -Params @{ quit = $true }
            $shutdownResponseHash = Get-SanitizedHash $response
            if ($response.ok -eq $true -and $response.data.quit_scheduled -eq $true) {
                $gracefulRequested = $true
                $gracefulMethod = 'editor_save_all_and_quit_clean_verified'
            }
        }
        catch {}
    }

    $exited = $false
    if ($gracefulRequested) { $exited = Wait-OwnedProcessExit $GracefulShutdownTimeoutMs }
    if (-not $exited) {
        Assert-EditorIdentity | Out-Null
        $owned = Get-Process -Id $EditorPid -ErrorAction Stop
        $windowCloseRequested = $false
        try {
            $windowCloseRequested = $owned.CloseMainWindow()
        }
        catch {}
        if ($windowCloseRequested) {
            $gracefulRequested = $true
            $gracefulMethod = if ($gracefulMethod) { $gracefulMethod + '+wm_close' } else { 'wm_close' }
            # A failed identity proof while waiting must not enable force.
            $exited = Wait-OwnedProcessExit $GracefulShutdownTimeoutMs
        }
    }

    $forced = $false
    if (-not $exited) {
        # Failed recovery only. Revalidate every immutable identity field just
        # before force termination so PID reuse can never retarget cleanup.
        Assert-EditorIdentity | Out-Null
        Stop-Process -Id $EditorPid -Force -ErrorAction Stop
        $forced = $true
        $exited = Wait-OwnedProcessExit 10000
    }

    Start-Sleep -Milliseconds 500
    $postCrash = Get-CrashEvidence
    $postFilesystem = Get-ProjectFilesystemEvidence
    $postLog = Read-NewCriticalLogEvidence
    $crashUnchanged = $postCrash.state_sha256 -ceq $InitialCrashEvidence.state_sha256
    $filesystemUnchanged = $postFilesystem.state_sha256 -ceq $InitialFilesystemEvidence.state_sha256
    $passed = $exited -and $gracefulRequested -and -not $forced -and $crashUnchanged -and `
        $filesystemUnchanged -and $postLog.critical_count -eq 0
    return [pscustomobject]@{
        passed = $passed
        mode = $gracefulMethod
        clean_before_exit = $cleanForGraceful
        graceful_requested = $gracefulRequested
        shutdown_response_sha256 = $shutdownResponseHash
        exited = $exited
        forced_recovery = $forced
        crash_evidence_unchanged = $crashUnchanged
        crash_artifact_count_after = $postCrash.artifact_count
        crash_signature_count_after = $postCrash.signature_count
        filesystem_unchanged = $filesystemUnchanged
        critical_shutdown_log_count = $postLog.critical_count
    }
}

    if (-not (Test-Path -LiteralPath $Invoker)) { throw "missing invoker: $Invoker" }
    $transportProbe = Wait-EditorReady
    $rawLimits = $transportProbe.data.transport_limits
    if ([string]$rawLimits.applies -cne 'active_tcp_server_snapshot') {
        throw 'ping transport_limits were not the active TCP server snapshot'
    }
    $ActiveMaxRequestBytes = Get-RequiredTransportLimit $rawLimits 'max_request_bytes' 65536 16777216
    $maxResponseBytes = Get-RequiredTransportLimit $rawLimits 'max_response_bytes' 65536 67108864
    $ConfiguredMaxClients = Get-RequiredTransportLimit $rawLimits 'max_clients' 1 256
    $maxPendingCommands = Get-RequiredTransportLimit $rawLimits 'max_pending_commands' 1 1024
    $ActiveMaxJsonNestingDepth = Get-RequiredTransportLimit $rawLimits 'max_json_nesting_depth' 8 256
    $FrameReadTimeoutMs = Get-RequiredTransportLimit $rawLimits 'frame_read_timeout_ms' 100 60000
    $sendTimeoutMs = Get-RequiredTransportLimit $rawLimits 'send_timeout_ms' 100 60000
    $maxPipelined = Get-RequiredTransportLimit $rawLimits 'max_pipelined_requests_per_client' 1 1024
    $maxQueuedResponseChars = Get-RequiredTransportLimit $rawLimits 'max_queued_response_chars_per_client' 65536 67108864
    $maxOutboundMemoryBytes = Get-RequiredTransportLimit $rawLimits 'max_outbound_memory_bytes_per_client' 262144 268435456
    $maxGlobalOutboundMemoryBytes = Get-RequiredTransportLimit $rawLimits 'max_global_outbound_memory_bytes' 262144 268435456
    if ($rawLimits.outbound_budget_includes_in_flight -ne $true) { throw 'TCP outbound budget does not include in-flight responses' }
    $PipelinedRequestProbeCount = $maxPipelined + 1
    $ActiveTransportLimits = [pscustomobject]@{
        applies = 'active_tcp_server_snapshot'
        max_request_bytes = $ActiveMaxRequestBytes
        max_response_bytes = $maxResponseBytes
        max_clients = $ConfiguredMaxClients
        max_pending_commands = $maxPendingCommands
        max_json_nesting_depth = $ActiveMaxJsonNestingDepth
        frame_read_timeout_ms = $FrameReadTimeoutMs
        send_timeout_ms = $sendTimeoutMs
        max_pipelined_requests_per_client = $maxPipelined
        max_queued_response_chars_per_client = $maxQueuedResponseChars
        max_outbound_memory_bytes_per_client = $maxOutboundMemoryBytes
        max_global_outbound_memory_bytes = $maxGlobalOutboundMemoryBytes
        outbound_budget_includes_in_flight = $true
    }
    if ($MaxCaseMs -le ($FrameReadTimeoutMs + 1500)) {
        throw "MaxCaseMs (${MaxCaseMs}) must exceed the configured frame-read timeout (${FrameReadTimeoutMs}) by at least 1500ms"
    }
    $startupLog = Read-NewCriticalLogEvidence
    if ($startupLog.critical_count -gt 0) {
        throw "editor startup produced $($startupLog.critical_count) new fatal/assert/ensure log signature(s)"
    }
    Assert-CrashEvidenceUnchanged | Out-Null
    Assert-ProjectFilesystemUnchanged | Out-Null
    $InitialEditorState = Get-EditorState
    if ($InitialEditorState.pie_running) { throw 'disposable editor must start outside PIE' }
    if ($InitialEditorState.dirty_count -ne 0) {
        throw "disposable editor must start clean; found $($InitialEditorState.dirty_count) dirty package(s)"
    }
    $EnvironmentEvidence = Get-EnvironmentEvidence $transportProbe
    Assert-EditorHealthy | Out-Null

    if ($CanaryKill) {
        if ($null -eq $LaunchedProcess) {
            throw '-CanaryKill is launch-mode only; it will never terminate an attached process'
        }
        Start-CaseBudget
        $clock = $CaseClock
        $script:CasePreflight = Assert-CaseTarget
        Assert-EditorIdentity | Out-Null
        Invoke-CasePhase 'hostile.action' {
            Stop-Process -Id $EditorPid -Force
            if (-not $LaunchedProcess.WaitForExit((Get-RemainingCaseMs 'canary owned exit'))) {
                throw 'canary owned process exit was not confirmed inside the case budget'
            }
        } | Out-Null
        $ordinaryGateWouldFail = $false
        try {
            Assert-EditorHealthy | Out-Null
        }
        catch {
            $ordinaryGateWouldFail = $true
            Add-Result 'canary_detects_editor_exit' $true $clock.ElapsedMilliseconds `
                "detected disposable editor exit: $($_.Exception.Message)" 'harness_canary' `
                (Get-SanitizedHash @{ token = 'redacted'; mode = 'kill_owned_process' }) `
                ([pscustomobject]@{
                    editor_exit_detected = $true
                    user_process_targeted = $false
                    ordinary_gate_would_fail = $true
                    canary_self_test_expected_exit_code = 0
                    ordinary_gate_simulated_exit_code = 1
                    ordinary_gate_exit_code = 1
                })
        }
        if (-not $ordinaryGateWouldFail) {
            Add-Result 'canary_detects_editor_exit' $false $clock.ElapsedMilliseconds `
                'harness failed to convert its deliberately killed editor into an ordinary hard gate failure' 'harness_canary'
            throw 'canary did not prove ordinary gate failure'
        }
        $CleanupAttempted = $true
        $CleanupEvidence = [pscustomobject]@{ mode = 'canary_force_termination'; graceful = $false; forced_recovery = $false; exited = $true }
        $script:CaseClock = $null
    }
    else {

    # The allow_unsafe=true probes are intentional: crash prevention must live
    # below policy and must survive callers that bypass the TypeScript wrapper.
    $fatalCases = @(
        @{ Name='world_switch_new_blank_map'; Script='import unreal; unreal.EditorLoadingAndSavingUtils.new_blank_map(False)' },
        @{ Name='world_switch_load_map'; Script='import unreal; unreal.EditorLoadingAndSavingUtils.load_map("/Game/Nope")' },
        @{ Name='self_socket_deadlock'; Script="import socket; s=socket.socket(); s.connect((`"127.0.0.1`",$Port))" },
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

    # This script would write and remove a bounded project Saved/ file if it
    # ever reached Execute. Both compatibility shapes must refuse it first;
    # Test-CommandRejection then proves fresh nonce/listener/PID recovery.
    $tier3FilesystemScript = @"
from pathlib import Path
import unreal
p = Path(unreal.Paths.project_saved_dir()) / 'HaybaMCP' / 'Survival' / 'must-not-exist.tmp'
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text('this line must never execute', encoding='utf-8')
"@
    Test-CommandRejection -Name 'python_tier3_filesystem_denied' -Command 'python_run' -Params @{
        script = $tier3FilesystemScript
    } -ErrorPattern 'HCR-SANDBOX-001.*allow_unsafe_requested:false.*allow_unsafe_effective:false'

    Test-CommandRejection -Name 'python_tier3_legacy_override_denied' -Command 'python_run' -Params @{
        script = $tier3FilesystemScript
        allow_unsafe = $true
    } -ErrorPattern 'HCR-SANDBOX-001.*allow_unsafe_requested:true.*allow_unsafe_effective:false'

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
        Send-RawFrame -Header (Get-BigEndianHeader 0) -ExpectPeerClose
    }
    Test-RawCase 'oversized_declared_frame' {
        Send-RawFrame -Header (Get-BigEndianHeader ([uint32]($ActiveMaxRequestBytes + 1))) -ExpectPeerClose
    }
    Test-RawCase 'truncated_header' {
        Send-RawFrame -Header ([byte[]]@(0, 0)) -HalfCloseSend -ExpectPeerClose
    }
    Test-RawCase 'truncated_body' {
        Send-RawFrame -Header (Get-BigEndianHeader 100) -Body ([Text.Encoding]::UTF8.GetBytes('{')) -HalfCloseSend -ExpectPeerClose
    }
    Test-RawCase 'malformed_json' {
        $body = [Text.Encoding]::UTF8.GetBytes('{not-json}')
        $raw = Send-RawFrame -Header (Get-BigEndianHeader $body.Length) -Body $body -ReadResponse $true
        $response = $raw | ConvertFrom-Json
        if ($response.ok -ne $false) { throw "malformed JSON was not rejected: $raw" }
    }
    Test-RawCase 'excessive_json_nesting' {
        $probeDepth = $ActiveMaxJsonNestingDepth + 1
        $json = ('[' * $probeDepth) + '0' + (']' * $probeDepth)
        $body = [Text.Encoding]::UTF8.GetBytes($json)
        Send-RawFrame -Header (Get-BigEndianHeader $body.Length) -Body $body -ExpectPeerClose
    }
    Test-RawCase 'embedded_nul_frame' {
        $prefix = [Text.Encoding]::UTF8.GetBytes('{"cmd":"ping"}')
        $body = [byte[]]::new($prefix.Length + 2)
        [Array]::Copy($prefix, $body, $prefix.Length)
        $body[$prefix.Length] = 0
        $body[$prefix.Length + 1] = [byte][char]'x'
        Send-RawFrame -Header (Get-BigEndianHeader $body.Length) -Body $body -ExpectPeerClose
    }
    Test-RawCase 'malformed_utf8_frame' {
        # Overlong UTF-8 encoding of NUL. Conversion APIs commonly replace it;
        # the transport must reject the original bytes so authenticated/framed
        # identity cannot differ from the JSON text handlers receive.
        $body = [byte[]]@(0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0x80, 0x22, 0x7d)
        Send-RawFrame -Header (Get-BigEndianHeader $body.Length) -Body $body -ExpectPeerClose
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
        Invoke-PartialFrameCapacityProbe 8 'partial-flood'
    }

    Test-RawCase 'client_limit_accounting_recovery' {
        Invoke-PartialFrameCapacityProbe 1 'client-limit'
    }

    Test-RawCase 'slowloris_total_frame_deadline' {
        Invoke-SlowlorisDeadlineProbe
    } -BudgetMs (Get-SlowlorisCaseBudgetMs)

    Test-RawCase 'pipelined_request_limit' {
        $client = Open-BoundedClient
        try {
            $stream = $client.GetStream()
            $writeRejected = $false
            for ($i = 0; $i -lt $PipelinedRequestProbeCount; $i++) {
                $frame = New-RawCommandFrame 'ping' @{} ("pipeline_$i" + '_' + [guid]::NewGuid().ToString('N'))
                try {
                    Write-BoundedBytes $stream $frame.header 'pipeline header write'
                    Write-BoundedBytes $stream $frame.body 'pipeline body write'
                }
                catch {
                    if ($i -lt 8) { throw }
                    $writeRejected = $true
                    break
                }
            }
            if (-not $writeRejected) { Wait-ForBoundedPeerClose $stream 'pipeline-limit peer close' | Out-Null }
        }
        finally { $client.Dispose() }
    }

    Test-RawCase 'disconnect_after_dispatch' {
        $client = Open-BoundedClient
        try {
            $frame = New-RawCommandFrame 'python_run' @{ script = 'sum(range(1000000))' } `
                ('disconnect_' + [guid]::NewGuid().ToString('N'))
            Write-BoundedBytes ($client.GetStream()) $frame.header 'disconnect probe header write'
            Write-BoundedBytes ($client.GetStream()) $frame.body 'disconnect probe body write'
            Wait-RawTask ($client.GetStream().FlushAsync()) 'disconnect probe flush' | Out-Null
        }
        finally { $client.Dispose() }
    }


    # PIE transitions exercise the lifetime boundary that dominates the local
    # crash corpus. Both requests are followed by the same PID/listener/ping/
    # crash/dirty checks as hostile inputs; the stop case also leaves the
    # disposable session in an editor-only state for deterministic teardown.
    Test-CommandSuccess -Name 'pie_start_transition' -Command 'editor_start_pie' -SettleMs 750 -ExpectedPieRunning $true
    Test-CommandSuccess -Name 'pie_stop_transition' -Command 'editor_stop_pie' -SettleMs 750 `
        -ExpectedPrePieRunning $true -ExpectedPieRunning $false
    }

    if (-not $CanaryKill) {
        $CleanupEvidence = Stop-OwnedEditorWithEvidence
        Add-Result 'owned_editor_graceful_cleanup' ([bool]$CleanupEvidence.passed) 0 `
            ($CleanupEvidence | ConvertTo-Json -Compress -Depth 10) 'harness_cleanup' `
            (Get-SanitizedHash @{ mode = 'graceful_then_failed_recovery'; token = 'redacted' }) $CleanupEvidence
    }
    $failed = @($Results | Where-Object { -not $_.passed })
    $report = [pscustomobject]@{
        schema_version = 4
        mode = $CanaryKill ? 'canary' : 'survival'
        editor_pid = $EditorPid
        port = $Port
        environment = $EnvironmentEvidence
        startup_readiness = $StartupReadinessEvidence
        crash_evidence_before = $InitialCrashEvidence
        editor_state_before = [pscustomobject]@{
            map_sha256 = Get-SanitizedHash $InitialEditorState.map
            pie_running = $InitialEditorState.pie_running
            dirty_count = $InitialEditorState.dirty_count
            dirty_packages_sha256 = Get-SanitizedHash $InitialEditorState.dirty_packages
        }
        filesystem_evidence_before = $InitialFilesystemEvidence
        critical_log_signatures_seen = $LogCriticalCount
        cleanup = $CleanupEvidence
        pending_acceptance_matrix = $PendingAcceptanceMatrix
        canary_exit_contract = $CanaryKill ? [pscustomobject]@{
            canary_self_test_expected_exit_code = 0
            ordinary_gate_simulated_exit_code = 1
            meaning = 'zero means the canary correctly detected the intentional owned-process exit; ordinary survival mode returns one for the same exit'
        } : $null
        passed = $Results.Count - $failed.Count
        failed = $failed.Count
        cases = $Results
    }
    Write-SurvivalReports $report
    if ($failed.Count -gt 0) { $ExitCode = 1 }
}
catch {
    $script:CaseClock = $null
    $fatalMessage = $_.Exception.Message
    $fatalDigest = New-DiagnosticDigest $fatalMessage 'fatal_exception'
    [Console]::Error.WriteLine("editor-survival gate failed: sanitized diagnostic sha256=$($fatalDigest.sha256)")
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
            detail = $fatalDigest
        })
    }
    if (-not $CleanupAttempted -and $OwnsTarget) {
        try {
            $CleanupEvidence = Stop-OwnedEditorWithEvidence
            Add-Result 'owned_editor_failure_cleanup' ([bool]$CleanupEvidence.passed) 0 `
                ($CleanupEvidence | ConvertTo-Json -Compress -Depth 10) 'harness_cleanup' '' $CleanupEvidence
        }
        catch {
            $CleanupEvidence = [pscustomobject]@{
                passed = $false
                mode = 'cleanup_exception_identity_safe_refusal'
                error_sha256 = Get-SanitizedHash $_.Exception.Message
                exited = -not [bool](Get-Process -Id $EditorPid -ErrorAction SilentlyContinue)
            }
        }
    }
    $failedCases = @($Results | Where-Object { -not $_.passed })
    $failedReport = [pscustomobject]@{
        schema_version = 4
        mode = $CanaryKill ? 'canary' : 'survival'
        editor_pid = $EditorPid
        port = $Port
        fatal_error = $fatalDigest
        environment = $EnvironmentEvidence
        startup_readiness = $StartupReadinessEvidence
        crash_evidence_before = $InitialCrashEvidence
        filesystem_evidence_before = $InitialFilesystemEvidence
        critical_log_signatures_seen = $LogCriticalCount
        cleanup = $CleanupEvidence
        pending_acceptance_matrix = $PendingAcceptanceMatrix
        canary_exit_contract = $CanaryKill ? [pscustomobject]@{
            canary_self_test_expected_exit_code = 0
            ordinary_gate_simulated_exit_code = 1
        } : $null
        passed = $Results.Count - $failedCases.Count
        failed = $failedCases.Count
        cases = $Results
    }
    Write-SurvivalReports $failedReport
    $ExitCode = 1
}
finally {
    if (-not $CleanupAttempted -and $OwnsTarget) {
        try { $CleanupEvidence = Stop-OwnedEditorWithEvidence } catch {
            $cleanupDigest = New-DiagnosticDigest $_.Exception.Message 'cleanup_exception'
            [Console]::Error.WriteLine("identity-safe emergency cleanup refused or failed: sanitized diagnostic sha256=$($cleanupDigest.sha256)")
            $ExitCode = 1
        }
    }
}

exit $ExitCode
