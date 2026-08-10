import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const toolkitPrivate = join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');

const tcpCpp = readFileSync(join(toolkitPrivate, 'HaybaMCPTcpServer.cpp'), 'utf8');
const tcpHeader = readFileSync(join(toolkitPrivate, 'HaybaMCPTcpServer.h'), 'utf8');
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

  it('waits for every client worker before module-owned code can unload', () => {
    expect(tcpHeader).toContain('TArray<TFuture<void>> Workers');
    expect(tcpCpp.match(/RetainWorker\(Async\(EAsyncExecution::Thread/g)).toHaveLength(2);
    expect(tcpCpp).not.toContain('EAsyncExecution::ThreadPool');
    expect(tcpCpp).toContain('WorkersToJoin = MoveTemp(Workers)');
    expect(tcpCpp).toContain('Worker.Wait()');
    expect(tcpCpp).toMatch(/Thread->WaitForCompletion\(\)[\s\S]*WorkersToJoin = MoveTemp\(Workers\)/);
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
    expect(tcpCpp).toContain('QueuedChars > MaxQueuedResponseCharsPerClient');
    expect(tcpCpp).toMatch(/NewPending > MaxPendingCommands[\s\S]*break;/);
    expect(tcpCpp).toContain('.Listening(MaxClientConnections)');
    expect(legacyCpp).toContain('SetObjectField(TEXT("transport_limits"), Limits)');
    expect(legacyCpp).toContain('captured_at_tcp_server_start');
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
    expect(invoker).toMatch(/catch \{[\s\S]*exit 1[\s\S]*exit 0/);
  });

  it('never aims hostile probes at an untagged user editor', () => {
    expect(survivalHarness).toContain('-HaybaSurvivalSession=$SessionToken');
    expect(survivalHarness).toContain('Assert-SurvivalTag $EditorPid $SessionToken');
    expect(survivalHarness).toContain('Start-Process -FilePath $EditorExe');
    expect(survivalHarness).toContain('-WindowStyle Hidden -PassThru');
    expect(survivalHarness).toContain('Find-OwnedMcpPort $EditorPid');
    expect(survivalHarness).toContain('Stop-Process -Id $EditorPid -Force');
    expect(survivalHarness).not.toContain("'D:\\Projects\\aphrosia");
  });

  it('emits auditable survival evidence and has a safe self-test mode', () => {
    for (const marker of [
      '[switch]$List',
      '[switch]$CanaryKill',
      '[string]$OutputJUnit',
      'sanitized_params_sha256',
      'dirty_package_delta',
      'same_pid_alive',
      'listener_owner',
      'crash_delta',
      'canary_detects_editor_exit',
      'slowloris_frame_timeout',
      'python_deadline_exhaustion',
      'pie_start_transition',
      'pie_stop_transition',
      "'-CanaryKill is launch-mode only",
    ]) {
      expect(survivalHarness).toContain(marker);
    }
    expect(survivalHarness).toContain('Write-SurvivalReports');
    expect(survivalHarness).toContain('<testsuite name=');
    expect(survivalHarness).toContain('Get-DirtyPackages');
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
    expect(pythonCpp).toContain('allow_unsafe only overrides filesystem/subprocess policy');
    expect(pythonCpp).toContain('MaxPythonScriptChars = 256 * 1024');
  });
});
