param(
    [Parameter(Mandatory=$true)]
    [string]$HarnessPath,
    [Parameter(Mandatory=$true)]
    [string]$InvokerPath
)

$ErrorActionPreference = 'Stop'
$parseErrors = $null
$tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($HarnessPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Survival harness did not parse' }
# Load only the exact helper definitions. Never evaluate the editor launch or
# hostile cases, and never open a socket to an editor's MCP port.
foreach ($name in @('Get-BigEndianHeader', 'Read-BoundedExact', 'Wait-RawTask', 'Get-RemainingCaseMs',
    'Open-BoundedClient', 'Write-BoundedBytes', 'Send-RawFrame', 'Wait-ForBoundedPeerClose')) {
    $definitions = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw "Expected exactly one helper: $name" }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
$ast = [Management.Automation.Language.Parser]::ParseFile($InvokerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Command invoker did not parse' }
foreach ($name in @('Read-ExactAsync', 'Wait-IoTask', 'Get-RemainingTimeoutMs')) {
    $definitions = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw "Expected exactly one invoker helper: $name" }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}

Add-Type -TypeDefinition @'
using System.Net.Sockets;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
public static class HaybaSurvivalRawFixture {
    public static async Task WriteRestAsync(NetworkStream stream) {
        await Task.Delay(150);
        await stream.WriteAsync(new byte[] { 0x42, 0x43, 0x44 }, 0, 3);
    }
}
public sealed class HaybaHalfClosePeer {
    public byte[] ReceivedBytes;
    public bool SawEof;
    public bool SentEof;
    public async Task ServeAsync(TcpListener listener, int closeDelayMs, CancellationToken token) {
        using (var client = await listener.AcceptTcpClientAsync(token))
        using (var stream = client.GetStream())
        using (var received = new MemoryStream()) {
            var buffer = new byte[64];
            while (true) {
                int count = await stream.ReadAsync(buffer, 0, buffer.Length, token);
                if (count == 0) break;
                received.Write(buffer, 0, count);
            }
            ReceivedBytes = received.ToArray();
            SawEof = true;
            // Data before EOF ensures the helper drains reads until real EOF.
            await stream.WriteAsync(new byte[] { 0x41 }, 0, 1, token);
            await Task.Delay(closeDelayMs, token);
            client.Client.Shutdown(SocketShutdown.Send);
            SentEof = true;
        }
    }
}
'@

$MaxCaseMs = 1000
$CaseClock = $null
$results = [Collections.Generic.List[object]]::new()
function Start-IsolatedLoopbackListener([Net.Sockets.TcpListener]$Listener) {
    for ($attempt = 0; $attempt -lt 32; $attempt++) {
        $Listener.Start()
        $selectedPort = $Listener.LocalEndpoint.Port
        if ($selectedPort -lt 52342 -or $selectedPort -gt 52350) { return }
        $Listener.Stop()
    }
    throw 'Unable to bind an isolated ephemeral loopback port'
}
$endianPassed = $true
try {
    foreach ($case in @(
        @{ value=[uint32]0; expected='0,0,0,0' },
        @{ value=[uint32]1; expected='0,0,0,1' },
        @{ value=[uint32]255; expected='0,0,0,255' },
        @{ value=[uint32]256; expected='0,0,1,0' },
        @{ value=[uint32]65535; expected='0,0,255,255' },
        @{ value=[uint32]305419896; expected='18,52,86,120' },
        @{ value=[uint32]::MaxValue; expected='255,255,255,255' }
    )) {
        $header = Get-BigEndianHeader $case.value
        if ($header.Count -ne 4 -or ($header -join ',') -cne $case.expected) { $endianPassed = $false }
    }
}
catch { $endianPassed = $false }
$results.Add([pscustomobject]@{ name='endian_boundaries'; passed=$endianPassed })

foreach ($scenario in @('fragmented_read', 'early_eof', 'stalled_deadline', 'invoker_fragmented_read', 'invoker_early_eof', 'invoker_stalled_deadline')) {
    $isInvoker = $scenario.StartsWith('invoker_')
    $behavior = $scenario -replace '^invoker_', ''
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $client = [Net.Sockets.TcpClient]::new()
    $peer = $null
    $writeRest = $null
    $passed = $false
    $elapsed = 0
    try {
        Start-IsolatedLoopbackListener $listener
        $selectedPort = $listener.LocalEndpoint.Port
        $accept = $listener.AcceptTcpClientAsync()
        $client.Connect('127.0.0.1', $listener.LocalEndpoint.Port)
        $peer = $accept.GetAwaiter().GetResult()
        $writer = $peer.GetStream()
        $writer.Write([byte[]]@(0x41), 0, 1)
        if ($behavior -ceq 'fragmented_read') {
            $writeRest = [HaybaSurvivalRawFixture]::WriteRestAsync($writer)
        }
        elseif ($behavior -ceq 'early_eof') {
            $peer.Client.Shutdown([Net.Sockets.SocketShutdown]::Send)
        }
        [byte[]]$buffer = if ($isInvoker) { [byte[]]@(238,0,0,0,0,238) } else { [byte[]]::new(4) }
        $timeoutMs = if ($behavior -ceq 'stalled_deadline') { 250 } else { 1000 }
        $MaxCaseMs = $timeoutMs; $CaseClock = [Diagnostics.Stopwatch]::StartNew()
        $Clock = [Diagnostics.Stopwatch]::StartNew()
        $caseTimer = [Diagnostics.Stopwatch]::StartNew()
        try {
            if ($isInvoker) { Read-ExactAsync $client.GetStream() $buffer 1 4 $scenario }
            else { Read-BoundedExact $client.GetStream() $buffer 4 $scenario }
            $elapsed = $caseTimer.ElapsedMilliseconds
            $expectedBytes = if ($isInvoker) { '238,65,66,67,68,238' } else { '65,66,67,68' }
            $passed = $behavior -ceq 'fragmented_read' -and ($buffer -join ',') -ceq $expectedBytes -and $elapsed -ge 100 -and $elapsed -lt 1000
        }
        catch {
            $elapsed = $caseTimer.ElapsedMilliseconds
            $expectedEof = if ($isInvoker) { "Connection closed before $scenario completed" } else { 'connection closed before early_eof' }
            $expectedDeadline = if ($isInvoker) { "$scenario exceeded the absolute ${timeoutMs}ms command deadline" } else { 'stalled_deadline exceeded the absolute case deadline' }
            $passed = ($behavior -ceq 'early_eof' -and $_.Exception.Message -ceq $expectedEof) -or
                ($behavior -ceq 'stalled_deadline' -and $_.Exception.Message -ceq $expectedDeadline -and $elapsed -ge 150 -and $elapsed -lt 1000)
        }
        if ($isInvoker -and ($buffer[0] -ne 238 -or $buffer[5] -ne 238)) { $passed = $false }
        if ($null -ne $writeRest) {
            if (-not $writeRest.Wait(1000)) { throw 'Loopback writer exceeded its bounded deadline' }
            $writeRest.GetAwaiter().GetResult() | Out-Null
        }
    }
    finally {
        $CaseClock = $null
        if ($null -ne $peer) { $peer.Dispose() }
        $client.Dispose()
        $listener.Stop()
    }
    $results.Add([pscustomobject]@{ name=$scenario; passed=$passed; elapsed_ms=$elapsed; port=$selectedPort })
}
foreach ($scenario in @('truncated_header_halfclose', 'truncated_body_halfclose',
    'delayed_peer_eof', 'nonclosing_peer_deadline')) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $peer = [HaybaHalfClosePeer]::new()
    $cancel = [Threading.CancellationTokenSource]::new(2000)
    $peerTask = $null
    $passed = $false
    $diagnostic = ''
    $peerDiagnostic = ''
    $elapsed = 0
    try {
        Start-IsolatedLoopbackListener $listener
        $Port = $listener.LocalEndpoint.Port
        $neverCloses = $scenario -ceq 'nonclosing_peer_deadline'
        $closeDelay = if ($neverCloses) { -1 } elseif ($scenario -ceq 'delayed_peer_eof') { 150 } else { 0 }
        $peerTask = $peer.ServeAsync($listener, $closeDelay, $cancel.Token)
        $header = if ($scenario -ceq 'truncated_header_halfclose') { [byte[]]@(0, 0) } else { Get-BigEndianHeader 100 }
        $body = if ($scenario -ceq 'truncated_header_halfclose') { [byte[]]@() } else { [byte[]]@(0x7b) }
        $expected = if ($scenario -ceq 'truncated_header_halfclose') { '0,0' } else { '0,0,0,100,123' }
        $timeoutMs = if ($neverCloses) { 250 } else { 1000 }
        $MaxCaseMs = $timeoutMs; $CaseClock = [Diagnostics.Stopwatch]::StartNew()
        $caseTimer = [Diagnostics.Stopwatch]::StartNew()
        try {
            $response = Send-RawFrame -Header $header -Body $body -HalfCloseSend -ExpectPeerClose
            $elapsed = $caseTimer.ElapsedMilliseconds
            $passed = -not $neverCloses -and $response -ceq '' -and $elapsed -lt $timeoutMs
            if ($scenario -ceq 'delayed_peer_eof' -and $elapsed -lt 150) { $passed = $false }
        }
        catch {
            $elapsed = $caseTimer.ElapsedMilliseconds
            $diagnostic = $_.Exception.Message
            $passed = $neverCloses -and $diagnostic -ceq 'malformed frame peer close exceeded the absolute case deadline' -and
                $elapsed -ge 150 -and $elapsed -lt 1000
        }
        if (-not $neverCloses) {
            try {
                if (-not $peerTask.Wait(1000)) { throw 'Half-close peer exceeded its bounded deadline' }
                $peerTask.GetAwaiter().GetResult() | Out-Null
            }
            catch { $passed = $false; $peerDiagnostic = $_.Exception.Message }
        }
        $passed = $passed -and $peer.SawEof -and ($peer.ReceivedBytes -join ',') -ceq $expected -and
            ($peer.SentEof -eq (-not $neverCloses))
    }
    finally {
        $CaseClock = $null
        $cancel.Cancel()
        if ($null -ne $peerTask) {
            try { $peerTask.GetAwaiter().GetResult() | Out-Null }
            catch {
                if ($_.Exception.InnerException -isnot [OperationCanceledException]) {
                    $passed = $false
                    $peerDiagnostic = $_.Exception.Message
                }
            }
        }
        $cancel.Dispose()
        $listener.Stop()
    }
    $results.Add([pscustomobject]@{ name=$scenario; passed=$passed; elapsed_ms=$elapsed; port=$Port; diagnostic=$diagnostic; peer_diagnostic=$peerDiagnostic })
}
$results | ConvertTo-Json -Compress
if (@($results | Where-Object { -not $_.passed }).Count) { exit 1 }
exit 0
