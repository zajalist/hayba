#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Send one length-prefixed command to a running Hayba Unreal plugin.

.DESCRIPTION
  This is deliberately transport-only: an `ok:false` command response is still
  printed and exits zero because the editor survived and answered. Connection,
  framing, timeout, and malformed-response failures exit non-zero. Crash and
  adversarial tests can therefore distinguish a safe rejection from process
  death without parsing human console text.
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$Cmd,

    [string]$ParamsJson = '{}',
    [int]$Port = 52342,
    [ValidateRange(100, 60000)]
    [int]$TimeoutMs = 10000,
    [string]$Auth = ''
)

$ErrorActionPreference = 'Stop'
$MaxFrameBytes = 1MB

$Clock = [Diagnostics.Stopwatch]::StartNew()

function Get-DiagnosticHash([object]$Value) {
    $text = if ($null -eq $Value) { '' } else { [string]$Value }
    if ($text.Length -gt 4096) { $text = $text.Substring(0, 4096) }
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-RemainingTimeoutMs([string]$Operation) {
    $remaining = $TimeoutMs - [int]$Clock.ElapsedMilliseconds
    if ($remaining -le 0) {
        throw "$Operation exceeded the absolute ${TimeoutMs}ms command deadline"
    }
    return $remaining
}

function Wait-IoTask([System.Threading.Tasks.Task]$Task, [string]$Operation) {
    $remaining = Get-RemainingTimeoutMs $Operation
    if (-not $Task.Wait($remaining)) {
        throw "$Operation exceeded the absolute ${TimeoutMs}ms command deadline"
    }
    return $Task.GetAwaiter().GetResult()
}

function Read-ExactAsync(
    [System.Net.Sockets.NetworkStream]$Stream,
    [byte[]]$Buffer,
    [int]$Offset,
    [int]$Count,
    [string]$Operation
) {
    $read = 0
    while ($read -lt $Count) {
        $task = $Stream.ReadAsync($Buffer, $Offset + $read, $Count - $read)
        $count = Wait-IoTask $task $Operation
        if ($count -le 0) { throw "Connection closed before $Operation completed" }
        $read += $count
    }
}

try {
    $paramsObject = $ParamsJson | ConvertFrom-Json -AsHashtable
    if ($null -eq $paramsObject -or $paramsObject -isnot [hashtable]) {
        throw 'ParamsJson must decode to a JSON object'
    }

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        Wait-IoTask ($client.ConnectAsync('127.0.0.1', $Port)) 'connect' | Out-Null
        $stream = $client.GetStream()
        $requestId = 'probe_' + [guid]::NewGuid().ToString('N')
        $request = @{
            cmd = $Cmd
            id = $requestId
            params = $paramsObject
        }
        if ($Auth) { $request.auth = $Auth }

        $json = $request | ConvertTo-Json -Compress -Depth 30
        $payload = [System.Text.Encoding]::UTF8.GetBytes($json)
        if ($payload.Length -le 0 -or $payload.Length -gt $MaxFrameBytes) {
            throw "Request frame is $($payload.Length) bytes; the editor limit is $MaxFrameBytes"
        }
        $header = [BitConverter]::GetBytes([int]$payload.Length)
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($header) }
        Wait-IoTask ($stream.WriteAsync($header, 0, $header.Length)) 'request header write' | Out-Null
        Wait-IoTask ($stream.WriteAsync($payload, 0, $payload.Length)) 'request payload write' | Out-Null
        Wait-IoTask ($stream.FlushAsync()) 'request flush' | Out-Null

        $lengthBytes = [byte[]]::new(4)
        Read-ExactAsync $stream $lengthBytes 0 4 'response header read'
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($lengthBytes) }
        $length = [BitConverter]::ToInt32($lengthBytes, 0)
        # The plugin caps responses at 8 MiB. Enforce the same boundary here so
        # a corrupted or hostile peer cannot make this diagnostic allocate an
        # attacker-controlled amount of memory before JSON validation.
        if ($length -le 0 -or $length -gt 8MB) {
            throw "Invalid response frame length: $length"
        }

        $responseBytes = [byte[]]::new($length)
        Read-ExactAsync $stream $responseBytes 0 $length 'response payload read'

        $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
        $responseText = $strictUtf8.GetString($responseBytes)
        $response = $responseText | ConvertFrom-Json
        if ($null -eq $response.id -or [string]$response.id -cne $requestId) {
            throw "Response correlation failed: expected id $requestId"
        }
        $response | ConvertTo-Json -Compress -Depth 30
    }
    finally {
        $client.Dispose()
    }
}
catch {
    # This helper is often used by security probes. Never echo a peer-controlled
    # response fragment or request sentinel into captured CI/editor evidence.
    $digest = Get-DiagnosticHash $_.Exception.Message
    [Console]::Error.WriteLine("invoke-tcp-command failed: sanitized diagnostic sha256=$digest")
    exit 1
}

# When this script is invoked from another PowerShell script, a successful
# scriptblock does not reliably populate the caller's $LASTEXITCODE. The
# survival harness treats a missing exit status as a transport failure, so make
# the success contract explicit just as the catch path makes failure explicit.
exit 0
