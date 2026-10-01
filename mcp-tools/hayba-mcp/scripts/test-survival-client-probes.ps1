param([Parameter(Mandatory=$true)][string]$HarnessPath)

$ErrorActionPreference = 'Stop'
$errors = $null
$tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($HarnessPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Survival harness did not parse' }
# Definitions and the three actual case actions only; never evaluate launch,
# health, cleanup, or any connection to an existing editor.
foreach ($name in @('Get-BigEndianHeader', 'Read-BoundedExact', 'Wait-RawTask', 'Get-RemainingCaseMs',
    'Open-BoundedClient', 'Write-BoundedBytes', 'New-RawCommandFrame', 'Get-RawTerminalSocketError', 'Get-RawCloseEvidence',
    'Initialize-RawCloseObservation', 'New-AdmittedRawHolder', 'New-PartialFrameHolders',
    'Assert-PartialHoldersActive', 'Invoke-PartialFrameCapacityProbe', 'Invoke-SlowlorisDeadlineProbe')) {
    $definitions = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw "Expected exactly one client probe helper: $name" }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
$actions = @{}
$actualWriteBoundedBytes = (Get-Item Function:Write-BoundedBytes).ScriptBlock
foreach ($command in $ast.FindAll({ param($node)
    $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -ceq 'Test-RawCase'
}, $true)) {
    $name = $command.CommandElements[1].Value
    if ($name -in @('partial_frame_client_flood', 'client_limit_accounting_recovery', 'slowloris_total_frame_deadline')) {
        $actions[$name] = [scriptblock]::Create($command.CommandElements[2].ScriptBlock.Extent.Text.Trim('{', '}'))
    }
}
if ($actions.Count -ne 3) { throw 'Expected exactly three client probe actions' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
public sealed class HaybaClientProbePeer : IDisposable {
    public readonly TcpListener Listener = new TcpListener(IPAddress.Loopback, 0);
    public int Pings, Partials, Drips, ClosedClients;
    public bool SawAuth;
    private int active;
    private readonly object gate = new object();
    private readonly List<TcpClient> clients = new List<TcpClient>();
    private readonly List<Task> workers = new List<Task>();
    private readonly CancellationTokenSource cancel = new CancellationTokenSource(12000);
    private Task accept;
    private readonly string mode;
    private readonly int limit, frameMs;
    public HaybaClientProbePeer(string mode, int limit, int frameMs) {
        this.mode = mode; this.limit = limit; this.frameMs = frameMs;
        while (true) {
            Listener.Start();
            int port = ((IPEndPoint)Listener.LocalEndpoint).Port;
            if (port < 52342 || port > 52350) break;
            Listener.Stop();
            cancel.Token.ThrowIfCancellationRequested();
        }
        accept = AcceptAsync();
    }
    private async Task AcceptAsync() {
        try {
            while (!cancel.IsCancellationRequested) {
                var client = await Listener.AcceptTcpClientAsync(cancel.Token);
                lock (gate) { clients.Add(client); workers.Add(ServeAsync(client)); }
            }
        } catch (OperationCanceledException) { }
    }
    private async Task<byte[]> ReadExact(NetworkStream stream, int count) {
        byte[] bytes = new byte[count]; int offset = 0;
        while (offset < count) {
            int n = await stream.ReadAsync(bytes, offset, count-offset, cancel.Token);
            if (n == 0) return null;
            offset += n;
        }
        return bytes;
    }
    private async Task ServeAsync(TcpClient client) {
        bool admitted = Interlocked.Increment(ref active) <= limit;
        try {
            using (client)
            using (var stream = client.GetStream()) {
                if (!admitted && mode == "reset_overflow") {
                    await ReadExact(stream,4);
                    client.Client.LingerState = new LingerOption(true,0);
                    client.Client.Close();
                    return;
                }
                if (!admitted && mode == "late_overflow") { await Task.Delay(frameMs+100,cancel.Token); return; }
                if (!admitted && mode != "admit_overflow") return;
                if (mode == "silent") { await Task.Delay(-1, cancel.Token); return; }
                var header = await ReadExact(stream, 4);
                if (header == null) return;
                int length = (header[0]<<24)|(header[1]<<16)|(header[2]<<8)|header[3];
                if (length < 1 || length > 4096) return;
                var body = await ReadExact(stream, length);
                if (body == null) return;
                string json = Encoding.UTF8.GetString(body);
                string id = Regex.Match(json, "\"id\"\\s*:\\s*\"([^\"]+)\"").Groups[1].Value;
                if (!json.Contains("\"ping\"")) throw new Exception("Expected admission ping");
                Interlocked.Increment(ref Pings);
                if (json.Contains("synthetic-auth")) SawAuth = true;
                if (mode == "wrong_id") id = "uncorrelated";
                byte[] reply = Encoding.UTF8.GetBytes("{\"ok\":true,\"id\":\"" + id + "\"}");
                byte[] response = new byte[reply.Length+4];
                response[2]=(byte)(reply.Length>>8); response[3]=(byte)reply.Length;
                Buffer.BlockCopy(reply,0,response,4,reply.Length);
                await stream.WriteAsync(response,0,response.Length,cancel.Token);
                // A wrongly admitted overflow returns real response bytes, then
                // closes: the probe must not drain and call that rejection.
                if (!admitted) return;
                if (mode == "wrong_id") {
                    while (await stream.ReadAsync(new byte[64],0,64,cancel.Token) != 0) { }
                    return;
                }
                byte[] first = new byte[1];
                if (await stream.ReadAsync(first,0,1,cancel.Token) == 0) return;
                Interlocked.Increment(ref Partials);
                using (var expiry = CancellationTokenSource.CreateLinkedTokenSource(cancel.Token)) {
                    int expiryMs = mode == "premature" ? 60 : frameMs;
                    var frameClock = Stopwatch.StartNew();
                    expiry.CancelAfter(expiryMs);
                    var buffer = new byte[64];
                    try {
                        while (true) {
                            int n = await stream.ReadAsync(buffer,0,buffer.Length,expiry.Token);
                            if (n == 0) break;
                            Interlocked.Increment(ref Drips);
                        }
                    } catch (OperationCanceledException) when (!cancel.IsCancellationRequested) {
                        // CancelAfter can fire just before its nominal interval.
                        // This synthetic peer must not pretend that early timer
                        // scheduling is a correctly enforced total-frame expiry.
                        while (frameClock.ElapsedMilliseconds < expiryMs)
                            await Task.Delay((int)Math.Max(1,expiryMs-frameClock.ElapsedMilliseconds),cancel.Token);
                    }
                }
            }
        } catch (IOException) { }
        finally { Interlocked.Decrement(ref active); Interlocked.Increment(ref ClosedClients); }
    }
    public void Dispose() {
        cancel.Cancel();
        accept.GetAwaiter().GetResult();
        Task[] pending;
        lock (gate) { foreach (var client in clients) client.Dispose(); pending = workers.ToArray(); }
        try { Task.WhenAll(pending).GetAwaiter().GetResult(); }
        catch (OperationCanceledException) { }
        Listener.Stop(); cancel.Dispose();
    }
}
'@

$MaxCaseMs = 10000
$Auth = 'synthetic-auth'
$results = [Collections.Generic.List[object]]::new()
foreach ($test in @(
    @{ name='flood_admission_and_capacity'; action='partial_frame_client_flood'; mode='capacity'; expected='success' },
    @{ name='limit_admission_and_capacity'; action='client_limit_accounting_recovery'; mode='capacity'; expected='success' },
    @{ name='limit_reset_capacity'; action='client_limit_accounting_recovery'; mode='reset_overflow'; expected='success' },
    @{ name='slowloris_admitted_expiry'; action='slowloris_total_frame_deadline'; mode='capacity'; expected='success' },
    @{ name='slowloris_delayed_successful_drip_rejected'; action='slowloris_total_frame_deadline'; mode='capacity'; expected='drip interval exceeded'; clients=1; peer_frame_ms=900; drip_delay_ms=450 },
    @{ name='slowloris_delayed_successful_drip_gap_recorded'; action='slowloris_total_frame_deadline'; mode='capacity'; expected='success'; clients=1; drip_delay_ms=80 },
    @{ name='slowloris_premature_close'; action='slowloris_total_frame_deadline'; mode='premature'; expected='premature' },
    @{ name='uncorrelated_admission_cleanup'; action='client_limit_accounting_recovery'; mode='wrong_id'; expected='admission' },
    @{ name='overflow_response_is_not_rejection'; action='client_limit_accounting_recovery'; mode='admit_overflow'; expected='response bytes' },
    @{ name='expired_holders_are_not_capacity_proof'; action='client_limit_accounting_recovery'; mode='late_overflow'; expected='active partial-frame lifetime' },
    @{ name='flood_deadline_is_not_rejection'; action='partial_frame_client_flood'; mode='silent'; expected='deadline' },
    @{ name='slowloris_default_limits'; action='slowloris_total_frame_deadline'; mode='capacity'; expected='success'; clients=16; frame_ms=5000 },
    @{ name='limit_minimum_client_count'; action='client_limit_accounting_recovery'; mode='capacity'; expected='success'; clients=1 }
)) {
    $ConfiguredMaxClients = if ($test.clients) { $test.clients } else { 2 }
    $FrameReadTimeoutMs = if ($test.frame_ms) { $test.frame_ms } else { 350 }
    $timeout = if ($test.mode -ceq 'silent') { 250 } elseif ($test.frame_ms) { $MaxCaseMs } else { 2500 }
    $CaseDeadline = [DateTime]::UtcNow.AddMilliseconds($timeout)
    $RawProbeEvidence = $null
    $peerFrameMs = if ($test.peer_frame_ms) { $test.peer_frame_ms } else { $FrameReadTimeoutMs }
    $peer = [HaybaClientProbePeer]::new($test.mode, $ConfiguredMaxClients, $peerFrameMs)
    $Port = $peer.Listener.LocalEndpoint.Port
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $diagnostic = ''
    $threw = $false
    $script:DelayedDripGapMs = $null
    $script:DelayedDripReadPending = $false
    if ($test.drip_delay_ms) {
        # Exercise the actual extracted action/write helper. One-byte socket
        # backpressure is not deterministic: explicitly delay the first successful
        # helper return, after its real socket write, while its close read is pending.
        function Write-BoundedBytes([Net.Sockets.NetworkStream]$Stream, [byte[]]$Bytes, [string]$Operation) {
            & $actualWriteBoundedBytes $Stream $Bytes $Operation
            if ($Operation -ceq 'slowloris drip byte' -and $null -eq $script:DelayedDripGapMs) {
                Wait-RawTask ([Threading.Tasks.Task]::Delay($test.drip_delay_ms)) 'controlled successful drip delay' | Out-Null
                $script:DelayedDripGapMs = $holder.clock.ElapsedMilliseconds - $holder.last_progress_ms
                $script:DelayedDripReadPending = -not $holder.close_task.IsCompleted
            }
        }
    }
    try { & $actions[$test.action] | Out-Null }
    catch { $threw = $true; $diagnostic = $_.Exception.Message }
    finally {
        Set-Item Function:Write-BoundedBytes $actualWriteBoundedBytes
        $peer.Dispose(); $CaseDeadline = $null
    }
    $passed = if ($test.expected -ceq 'success') {
        -not $threw -and $peer.Pings -eq $ConfiguredMaxClients -and $peer.Partials -eq $ConfiguredMaxClients -and $peer.SawAuth
    } else { $threw -and $diagnostic -match $test.expected }
    if ($test.name -ceq 'slowloris_admitted_expiry') { $passed = $passed -and $peer.Drips -ge 4 }
    if ($test.drip_delay_ms) {
        $passed = $passed -and $null -ne $script:DelayedDripGapMs -and $script:DelayedDripReadPending
        if ($test.expected -ceq 'success') {
            $passed = $passed -and $script:DelayedDripGapMs -lt $FrameReadTimeoutMs -and
                $RawProbeEvidence.closures[0].max_progress_gap_ms -ge $script:DelayedDripGapMs
        } else {
            $passed = $passed -and $script:DelayedDripGapMs -ge $FrameReadTimeoutMs -and $RawProbeEvidence.drips -eq 0
        }
    }
    if ($test.name -ceq 'uncorrelated_admission_cleanup') { $passed = $passed -and $peer.ClosedClients -eq 1 }
    if ($test.mode -ceq 'reset_overflow') { $passed = $passed -and $RawProbeEvidence.closures[0].kind -ceq 'socket_error' }
    $results.Add([pscustomobject]@{ name=$test.name; passed=$passed; elapsed_ms=$timer.ElapsedMilliseconds;
        port=$Port; diagnostic=$diagnostic; pings=$peer.Pings; partials=$peer.Partials; drips=$peer.Drips;
        controlled_drip_gap_ms=$script:DelayedDripGapMs; controlled_drip_read_pending=$script:DelayedDripReadPending;
        closed_clients=$peer.ClosedClients; evidence=$RawProbeEvidence })
}
$clients = [Collections.Generic.List[Net.Sockets.TcpClient]]::new()
$RawProbeEvidence = [pscustomobject]@{ admitted=0 }
$ConfiguredMaxClients = 1
$FrameReadTimeoutMs = 350
$CaseDeadline = [DateTime]::UtcNow.AddMilliseconds(2000)
$peer = [HaybaClientProbePeer]::new('premature', 1, $FrameReadTimeoutMs)
$Port = $peer.Listener.LocalEndpoint.Port
try {
    $holders = New-PartialFrameHolders $clients 'completion timestamp'
    Start-Sleep -Milliseconds 450
    $holder = $holders[0]
    $passed = $holder.close_task.IsCompleted -and $holder.close_observation.ElapsedMs -lt $FrameReadTimeoutMs -and
        $holder.clock.ElapsedMilliseconds -ge 450
    $results.Add([pscustomobject]@{ name='early_close_completion_timestamp'; passed=$passed; port=$Port;
        completion_ms=$holder.close_observation.ElapsedMs; observation_ms=$holder.clock.ElapsedMilliseconds })
}
finally {
    foreach ($client in $clients) { $client.Dispose() }
    $peer.Dispose(); $CaseDeadline = $null
}
foreach ($test in @(
    @{ name='null_close_task_is_not_closure'; task=$null },
    @{ name='unrelated_error_is_not_closure'; task=[Threading.Tasks.Task]::FromException([InvalidOperationException]::new('synthetic unrelated error')) },
    @{ name='socket_timeout_is_not_closure'; task=[Threading.Tasks.Task]::FromException([Net.Sockets.SocketException]::new(10060)) }
)) {
    $passed = $false
    $diagnostic = ''
    try { Get-RawCloseEvidence $test.task 'synthetic close' | Out-Null }
    catch { $passed = $true; $diagnostic = $_.Exception.Message }
    $results.Add([pscustomobject]@{ name=$test.name; passed=$passed; diagnostic=$diagnostic })
}
foreach ($test in @(
    @{ name='wrapped_reset_is_close_evidence'; code=10054; expected='ConnectionReset' },
    @{ name='wrapped_aborted_is_close_evidence'; code=10053; expected='ConnectionAborted' }
)) {
    $terminalException = [IO.IOException]::new('synthetic terminal socket error', [Net.Sockets.SocketException]::new($test.code))
    $task = [Threading.Tasks.Task]::FromException($terminalException)
    $CaseDeadline = [DateTime]::UtcNow.AddMilliseconds(1000)
    $passed = $false
    $diagnostic = ''
    try {
        $closure = Get-RawCloseEvidence $task 'synthetic terminal close'
        $passed = $closure.kind -ceq 'socket_error' -and $closure.socket_error -ceq $test.expected
    }
    catch { $diagnostic = $_.Exception.Message }
    finally { $CaseDeadline = $null }
    $results.Add([pscustomobject]@{ name=$test.name; passed=$passed; diagnostic=$diagnostic })
}
$results | ConvertTo-Json -Depth 10 -Compress
if (@($results | Where-Object { -not $_.passed }).Count) { exit 1 }
exit 0
