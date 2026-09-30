param(
    [Parameter(Mandatory=$true)]
    [string]$HarnessPath
)

$ErrorActionPreference = 'Stop'
$parseErrors = $null
$tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($HarnessPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Survival harness did not parse' }
# Load only the exact helper definitions. Never evaluate the editor launch or
# hostile cases, and never open a socket to an editor's MCP port.
foreach ($name in @('Get-BigEndianHeader', 'Read-BoundedExact', 'Wait-RawTask', 'Get-RemainingCaseMs')) {
    $definitions = @($ast.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw "Expected exactly one helper: $name" }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}

Add-Type -TypeDefinition @'
using System.Net.Sockets;
using System.Threading.Tasks;
public static class HaybaSurvivalRawFixture {
    public static async Task WriteRestAsync(NetworkStream stream) {
        await Task.Delay(150);
        await stream.WriteAsync(new byte[] { 0x42, 0x43, 0x44 }, 0, 3);
    }
}
'@

$MaxCaseMs = 1000
$CaseDeadline = $null
$results = [Collections.Generic.List[object]]::new()
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

foreach ($scenario in @('fragmented_read', 'early_eof', 'stalled_deadline')) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $client = [Net.Sockets.TcpClient]::new()
    $peer = $null
    $writeRest = $null
    $passed = $false
    $elapsed = 0
    try {
        $listener.Start()
        $accept = $listener.AcceptTcpClientAsync()
        $client.Connect('127.0.0.1', $listener.LocalEndpoint.Port)
        $peer = $accept.GetAwaiter().GetResult()
        $writer = $peer.GetStream()
        $writer.Write([byte[]]@(0x41), 0, 1)
        if ($scenario -ceq 'fragmented_read') {
            $writeRest = [HaybaSurvivalRawFixture]::WriteRestAsync($writer)
        }
        elseif ($scenario -ceq 'early_eof') {
            $peer.Client.Shutdown([Net.Sockets.SocketShutdown]::Send)
        }
        $buffer = [byte[]]::new(4)
        $timeoutMs = if ($scenario -ceq 'stalled_deadline') { 250 } else { 1000 }
        $CaseDeadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        try {
            Read-BoundedExact $client.GetStream() $buffer 4 $scenario
            $elapsed = $clock.ElapsedMilliseconds
            $passed = $scenario -ceq 'fragmented_read' -and ($buffer -join ',') -ceq '65,66,67,68' -and $elapsed -ge 100 -and $elapsed -lt 1000
        }
        catch {
            $elapsed = $clock.ElapsedMilliseconds
            $passed = ($scenario -ceq 'early_eof' -and $_.Exception.Message -ceq 'connection closed before early_eof') -or
                ($scenario -ceq 'stalled_deadline' -and $_.Exception.Message -ceq 'stalled_deadline exceeded the absolute case deadline' -and $elapsed -ge 150 -and $elapsed -lt 1000)
        }
        if ($null -ne $writeRest) {
            if (-not $writeRest.Wait(1000)) { throw 'Loopback writer exceeded its bounded deadline' }
            $writeRest.GetAwaiter().GetResult() | Out-Null
        }
    }
    finally {
        $CaseDeadline = $null
        if ($null -ne $peer) { $peer.Dispose() }
        $client.Dispose()
        $listener.Stop()
    }
    $results.Add([pscustomobject]@{ name=$scenario; passed=$passed; elapsed_ms=$elapsed })
}
$results | ConvertTo-Json -Compress
if (@($results | Where-Object { -not $_.passed }).Count) { exit 1 }
exit 0
