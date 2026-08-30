import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const toolkitPrivate = join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');

const tcpCpp = readFileSync(join(toolkitPrivate, 'HaybaMCPTcpServer.cpp'), 'utf8');
const tcpHeader = readFileSync(join(toolkitPrivate, 'HaybaMCPTcpServer.h'), 'utf8');
const joinableWorker = readFileSync(join(toolkitPrivate, 'HaybaMCPJoinableWorker.h'), 'utf8');
const transportPolicyTest = readFileSync(
  join(toolkitPrivate, 'Tests', 'HaybaMCPTransportPolicyTest.cpp'),
  'utf8',
);
const moduleCpp = readFileSync(join(toolkitPrivate, 'HaybaMCPModule.cpp'), 'utf8');
const settingsCpp = readFileSync(join(toolkitPrivate, 'HaybaMCPSettings.cpp'), 'utf8');
const developerSettings = readFileSync(join(toolkitPrivate, 'HaybaMCPDeveloperSettings.h'), 'utf8');
const legacyCpp = readFileSync(join(toolkitPrivate, 'handlers', 'HaybaMCPLegacyHandler.cpp'), 'utf8');
const paramsHeader = readFileSync(
  join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Public', 'HaybaMCPParams.h'),
  'utf8',
);
const paramsTest = readFileSync(join(toolkitPrivate, 'Tests', 'HaybaMCPParamsTest.cpp'), 'utf8');
const moduleHeader = readFileSync(
  join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Public', 'HaybaMCPModule.h'),
  'utf8',
);
const pythonCpp = readFileSync(join(toolkitPrivate, 'handlers', 'HaybaMCPPythonHandler.cpp'), 'utf8');
const invoker = readFileSync(join(root, 'mcp-tools', 'hayba-mcp', 'scripts', 'invoke-tcp-command.ps1'), 'utf8');
const survivalHarness = readFileSync(
  join(root, 'mcp-tools', 'hayba-mcp', 'scripts', 'test-editor-survival.ps1'),
  'utf8',
);

describe('TCP crash-resilience contract', () => {
  it('does not let connection workers retain a raw server pointer', () => {
    expect(tcpHeader).toContain('TSharedFromThis<FHaybaMCPTcpServer, ESPMode::ThreadSafe>');
    expect(moduleHeader).toContain('TSharedPtr<FHaybaMCPTcpServer, ESPMode::ThreadSafe> TcpServer');
    expect(moduleCpp).toContain('MakeShared<FHaybaMCPTcpServer, ESPMode::ThreadSafe>');
    expect(tcpCpp).toContain('[Self, Conn]()');
    expect(tcpCpp).not.toContain('[this, Conn]()');
  });

  it('truly joins and destroys every client-worker capture before module-owned code can unload', () => {
    expect(tcpHeader).toContain('TArray<TUniquePtr<FHaybaMCPJoinableWorker>> Workers');
    expect(tcpCpp.match(/MakeUnique<FHaybaMCPJoinableWorker>/g)).toHaveLength(2);
    expect(tcpCpp).not.toContain('EAsyncExecution::ThreadPool');
    expect(tcpCpp).not.toContain('Async(EAsyncExecution::Thread');
    expect(tcpHeader).not.toContain('TFuture');
    expect(tcpCpp).toContain('WorkersToJoin = MoveTemp(Workers)');
    expect(tcpCpp).toContain('Worker->JoinAndDestroy()');
    const wait = joinableWorker.indexOf('Thread->WaitForCompletion();');
    const deleteThread = joinableWorker.indexOf('delete Thread;', wait);
    const destroyCaptures = joinableWorker.indexOf('Callable.Reset();', deleteThread);
    expect(wait).toBeGreaterThan(-1);
    expect(deleteThread).toBeGreaterThan(wait);
    expect(destroyCaptures).toBeGreaterThan(deleteThread);
    expect(transportPolicyTest).toContain('true join destroys callable captures before returning');
    expect(transportPolicyTest).toContain('a fresh worker starts after exact prior teardown');
    expect(transportPolicyTest).toContain('restart capture also dies before join returns');
    expect(tcpCpp).not.toContain('ClientWorkersDoneEvent');
    expect(tcpCpp).toMatch(/ReadBounded[\s\S]*while \(TotalRead < NumBytes && bIsRunning && Conn->bAlive\)/);
    expect(tcpCpp).toContain('BytesRead <= 0');
  });

  it('bounds all attacker-controlled transport queues and frames', () => {
    for (const bound of [
      'MaxRequestBytes = 1024 * 1024',
      'MaxResponseBytes = 8 * 1024 * 1024',
      'MaxClientConnections = 16',
      'MaxPendingCommands = 128',
      'MaxJsonNestingDepth = 64',
      'FrameReadTimeoutMs = 5000',
      'SendTimeoutMs = 1000',
    ]) {
      expect(tcpHeader).toContain(bound);
    }
    for (const setting of [
      'TcpMaxRequestBytes',
      'TcpMaxResponseBytes',
      'TcpMaxClientConnections',
      'TcpMaxPendingCommands',
      'TcpMaxJsonNestingDepth',
      'TcpFrameReadTimeoutMs',
      'TcpSendTimeoutMs',
    ]) {
      expect(developerSettings).toContain(setting);
      expect(settingsCpp).toContain(`DevSettings->${setting}`);
      expect(tcpCpp).toContain(`Settings.${setting}`);
    }
    expect(tcpCpp).toContain('HasSafeJsonNesting(OutMessage, MaxJsonNestingDepth)');
    expect(tcpCpp).toContain('HasStrictUtf8(Buffer.GetData()');
    expect(tcpCpp).toContain('Rejecting request with malformed UTF-8 or embedded NUL');
    expect(tcpCpp).toContain('FUTF8ToTCHAR Converted');
    expect(tcpCpp).toContain('FHaybaMCPSendDeadlinePolicy Deadline');
    expect(tcpCpp).toContain('Deadline.ShouldAbort(FPlatformTime::Seconds())');
    expect(tcpCpp).toContain('MaxPipelinedRequestsPerClient');
    expect(tcpCpp).toContain('FHaybaMCPOutboundBudgetReservation::TryCreate');
    expect(tcpCpp).toContain('MaxGlobalOutboundMemoryBytes = static_cast<int64>(MaxResponseBytes) * 4');
    expect(tcpCpp).toMatch(/GetCountAfterAcquire\(\) > MaxPendingCommands[\s\S]*break;/);
    expect(tcpCpp).toContain('.Listening(MaxClientConnections)');
    expect(tcpCpp).toContain('GetTransportLimitsSnapshot() const');
    expect(legacyCpp).toContain('Module->GetTcpTransportLimits()');
    expect(tcpCpp).toContain('active_tcp_server_snapshot');
    expect(legacyCpp).toContain('next_tcp_server_start');
  });

  it('handles partial stream sends instead of assuming one send is complete', () => {
    expect(tcpCpp).toContain('SetNonBlocking(true)');
    expect(tcpCpp).toContain('WaitForWrite');
    expect(tcpCpp).toContain('static_cast<double>(SendTimeoutMs) / 1000.0');
    expect(tcpCpp).toMatch(/while \(TotalSent < NumBytes && bIsRunning && Conn->bAlive\)/);
    expect(tcpCpp).toContain('BytesSent <= 0');
    expect(tcpCpp).toContain('Shutdown(ESocketShutdownMode::ReadWrite)');
  });

  it('does not drain an attacker-controlled queue without a frame budget', () => {
    expect(tcpCpp).toContain('MaxCommandsPerTick = 4');
    expect(tcpCpp).toContain('MaxDrainSeconds = 0.008');
    expect(tcpCpp).toMatch(/Processed < MaxCommandsPerTick && PendingCommands\.Dequeue/);
    expect(tcpCpp).toContain('FPlatformTime::Seconds() >= Deadline');
  });

  it('keeps the diagnostic client under the same allocation ceilings', () => {
    expect(invoker).toContain('$MaxFrameBytes = 1MB');
    expect(invoker).toMatch(/\$length -le 0 -or \$length -gt 8MB/);
    expect(invoker).toContain('[ValidateRange(100, 60000)]');
    expect(invoker).toContain("ConnectAsync('127.0.0.1', $Port)");
    expect(invoker).toContain('$stream.WriteAsync(');
    expect(invoker).toContain('$Stream.ReadAsync(');
    expect(invoker).toContain('Get-RemainingTimeoutMs');
    expect(invoker).toContain('[System.Text.UTF8Encoding]::new($false, $true)');
    expect(invoker).toContain('[string]$response.id -cne $requestId');
    expect(invoker).toContain('Get-DiagnosticHash $_.Exception.Message');
    expect(invoker).not.toContain('invoke-tcp-command failed: $($_.Exception.Message)');
    expect(invoker).toMatch(/catch \{[\s\S]*exit 1[\s\S]*exit 0/);
  });

  it('requires disposable ownership and revalidates immutable process identity', () => {
    expect(survivalHarness).toContain('-HaybaSurvivalSession=$SessionToken');
    expect(survivalHarness).toContain('[switch]$ConfirmDisposableProject');
    expect(survivalHarness).toContain('[switch]$TakeOwnership');
    expect(survivalHarness).toContain('HAYBA_DISPOSABLE_PROJECT_V1');
    expect(survivalHarness).toContain('Assert-DisposableProject $ProjectPath');
    expect(survivalHarness).toContain('Test-ExactCommandLineArgument');
    expect(survivalHarness).toContain('[string]$row.ExecutablePath');
    expect(survivalHarness).toContain('([DateTime]$row.CreationDate).ToUniversalTime()');
    expect(survivalHarness).toContain("foreach ($field in @('pid', 'executable_path', 'creation_utc'");
    expect(survivalHarness).toContain('Assert-CaseTarget');
    expect(survivalHarness).toMatch(/function Assert-CaseTarget[\s\S]*return Assert-EditorHealthy/);
    expect(survivalHarness).toMatch(/function Assert-EditorHealthy[\s\S]*Assert-EditorIdentity/);
    expect(survivalHarness).toContain('-NotePropertyName preflight');
    expect(survivalHarness).toContain(
      'the survival harness will not disable, bypass, or auto-approve production policy',
    );
    expect(survivalHarness).toMatch(/Failed recovery only[\s\S]*Assert-EditorIdentity[\s\S]*Stop-Process/);
    expect(survivalHarness).toContain('Start-Process -FilePath $EditorExe');
    expect(survivalHarness).toContain('-WindowStyle Hidden -PassThru');
    expect(survivalHarness).toContain('Find-OwnedMcpPort $EditorPid');
    expect(survivalHarness).toContain("Invoke-HaybaCommand -Command 'editor_save_all_and_quit'");
    expect(survivalHarness).toContain('$owned.CloseMainWindow()');
    expect(survivalHarness).not.toContain('[switch]$KeepEditor');
    expect(survivalHarness).not.toContain("'D:\\Projects\\aphrosia");
  });

  it('serializes null evidence explicitly instead of dropping it through the PowerShell pipeline', () => {
    expect(survivalHarness).toContain('ConvertTo-Json -InputObject $Value -Compress -Depth 30');
    expect(survivalHarness).not.toContain('$Value | ConvertTo-Json -Compress -Depth 30');
  });

  it('attests exact clean source and loaded plugin artifacts before accepting evidence', () => {
    for (const marker of [
      '[string]$ExpectedSourceCommit',
      '[string[]]$ExpectedPluginDllSha256',
      '[string]$ExpectedArtifactManifest',
      'Resolve-ArtifactExpectation',
      'status --porcelain=v1 --untracked-files=all',
      'source_worktree_clean = $true',
      'UnrealEditor-HaybaMCPToolkit.dll',
      'Loaded Hayba plugin DLL set does not exactly match',
      'Loaded Hayba plugin DLL hash mismatch',
      'artifact_attestation_mode',
      'artifact_manifest_sha256',
    ]) {
      expect(survivalHarness).toContain(marker);
    }
    expect(survivalHarness).toMatch(/manifestInfo\.Length[\s\S]*-gt 64KB/);
    expect(survivalHarness).toMatch(/Get-FileHash -Algorithm SHA256[\s\S]*expected_dlls\.GetEnumerator/);
  });

  it('emits auditable state/evidence and proves the canary trips the ordinary gate', () => {
    for (const marker of [
      '[switch]$List',
      '[switch]$CanaryKill',
      '[string]$OutputJUnit',
      'sanitized_params_sha256',
      'python_nonce_ok',
      'python_nonce_sha256',
      'map_baseline_unchanged',
      'pie_state_expected',
      'dirty_package_delta',
      'listener_owner',
      'crash_signature_delta',
      'critical_log_delta',
      'filesystem_delta',
      'canary_detects_editor_exit',
      'ordinary_gate_would_fail',
      'canary_self_test_expected_exit_code = 0',
      'ordinary_gate_simulated_exit_code = 1',
      'ordinary_gate_exit_code = 1',
      'slowloris_total_frame_deadline',
      'client_limit_accounting_recovery',
      'pipelined_request_limit',
      'disconnect_after_dispatch',
      'python_deadline_exhaustion',
      'python_tier3_filesystem_denied',
      'python_tier3_legacy_override_denied',
      'pie_start_transition',
      'pie_stop_transition',
      "'-CanaryKill is launch-mode only",
      'New-DiagnosticDigest',
      'chars_hashed',
      'fatal_error = $fatalDigest',
      '$MaxCrashDirectories = 256',
      '$MaxCrashFiles = 4096',
      '$MaxCrashContextBytes = 1MB',
      '$CrashScanTimeoutMs = 2000',
      '$FilesystemScanTimeoutMs = 2000',
      '$MaxTrackedProjectFiles = 25000',
      '$MaxLogFiles = 64',
      '$MaxTotalLogDeltaBytes = 8MB',
      '$LogScanTimeoutMs = 1000',
    ]) {
      expect(survivalHarness).toContain(marker);
    }
    expect(survivalHarness).toContain('Write-SurvivalReports');
    expect(survivalHarness).toContain('<testsuite name=');
    expect(survivalHarness).toContain('Get-EditorState');
    expect(survivalHarness).toContain('Get-ProjectFilesystemEvidence');
    expect(survivalHarness).toContain('Get-CrashEvidence');
    expect(survivalHarness).toContain('Read-NewCriticalLogEvidence');
    expect(survivalHarness).toContain('Get-EnvironmentEvidence');
    expect(survivalHarness).toContain('(Get-Process -Id $EditorPid -ErrorAction Stop).Modules');
    expect(survivalHarness).toContain('loaded_plugin_binaries');
    expect(survivalHarness).toContain('native project identity mismatch');
    expect(survivalHarness).toContain('pending_acceptance_matrix');
    expect(survivalHarness).toContain("issue = '#406'");
    expect(survivalHarness).toContain(
      'execute Hayba.MCP.Transport.OutboundAdmissionAndAccounting',
    );
    expect(survivalHarness).not.toContain('fatal_error = $fatalMessage');
    expect(survivalHarness).not.toContain('detail = $fatalMessage');
  });

  it('derives hostile transport dimensions from the active listener snapshot', () => {
    expect(survivalHarness).toContain("[string]$rawLimits.applies -cne 'active_tcp_server_snapshot'");
    for (const limit of [
      'max_request_bytes',
      'max_response_bytes',
      'max_clients',
      'max_pending_commands',
      'max_json_nesting_depth',
      'frame_read_timeout_ms',
      'send_timeout_ms',
      'max_pipelined_requests_per_client',
      'max_queued_response_chars_per_client',
      'max_outbound_memory_bytes_per_client',
      'max_global_outbound_memory_bytes',
    ]) {
      expect(survivalHarness).toContain(`Get-RequiredTransportLimit $rawLimits '${limit}'`);
    }
    expect(survivalHarness).toContain('($ActiveMaxRequestBytes + 1)');
    expect(survivalHarness).toContain('$probeDepth = $ActiveMaxJsonNestingDepth + 1');
    expect(survivalHarness).toContain('$PipelinedRequestProbeCount = $maxPipelined + 1');
    expect(survivalHarness).not.toContain('Get-BigEndianHeader (1MB + 1)');
    expect(survivalHarness).not.toContain("('[' * 65)");
  });

  it('treats Plan Mode as a hard gate for legacy and top-level failure shapes', () => {
    expect(survivalHarness).toContain("[string]$response.data.status -ceq 'plan_mode_required'");
    expect(survivalHarness).toContain("[string]$response.status -ceq 'plan_mode_required'");
    expect(survivalHarness).toContain("[string]$response.code -ceq 'plan_mode_required'");
    expect(survivalHarness).toContain('will not disable, bypass, or auto-approve production policy');
  });

  it('centralizes hostile JSON shapes before handlers reach Unreal APIs', () => {
    for (const primitive of [
      'RequiredInt',
      'RequiredArray',
      'RequiredObject',
      'RequiredVec3',
      'RequiredEnum',
      'RequiredGamePath',
      'OptionalColor',
      'OptionalTransform',
      'RequiredRadius',
      'OptionalDensity',
    ]) {
      expect(paramsHeader).toContain(`${primitive}(`);
      expect(paramsTest).toContain(`${primitive}(`);
    }
    expect(paramsHeader).toContain('observed %s');
    expect(paramsHeader).toContain("'%s[%d]' must be a finite number");
    expect(paramsTest).toContain('transform.location[1]');
    expect(paramsTest).toContain('diagnostic never echoes untrusted');
  });
});

describe('authoritative python_run crash boundary', () => {
  it('rejects structural crashers in C++ even when callers bypass the TS wrapper', () => {
    const source = pythonCpp.toLowerCase();
    for (const pattern of [
      'new_blank_map',
      'editorloadingandsavingutils.load_map',
      'unreal.register_',
      'threading.thread',
      'time.sleep(',
      'whiletrue',
      'ctypes',
      'os._exit',
      'exec(',
      'socket.socket(',
    ]) {
      expect(source, pattern).toContain(pattern);
    }
    expect(pythonCpp).toContain('allow_unsafe is deprecated and ineffective');
    expect(pythonCpp).toContain('allow_unsafe_effective:false');
    expect(pythonCpp).toContain('isolation remains tracked by #392/#414');
    expect(pythonCpp).toContain('MaxPythonScriptChars = 256 * 1024');
  });

  it('never turns the legacy Tier-3 compatibility field into survival-harness authority', () => {
    expect(survivalHarness).toContain("Test-CommandRejection -Name 'python_tier3_filesystem_denied'");
    expect(survivalHarness).toContain("Test-CommandRejection -Name 'python_tier3_legacy_override_denied'");
    expect(survivalHarness).toContain('allow_unsafe_requested:true.*allow_unsafe_effective:false');
    expect(survivalHarness).not.toContain('python_tier3_scratch_allowed_and_removed');
    expect(survivalHarness).not.toContain('__HAYBA_SCRATCH_CLEAN__');
  });
});
