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

try {
    $paramsObject = $ParamsJson | ConvertFrom-Json -AsHashtable
    if ($null -eq $paramsObject -or $paramsObject -isnot [hashtable]) {
        throw 'ParamsJson must decode to a JSON object'
    }

    $client = [System.Net.Sockets.TcpClient]::new()
    $client.SendTimeout = $TimeoutMs
    $client.ReceiveTimeout = $TimeoutMs
    $client.Connect('127.0.0.1', $Port)
    try {
        $stream = $client.GetStream()
        $request = @{
            cmd = $Cmd
            id = 'probe_' + [guid]::NewGuid().ToString('N')
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
        $stream.Write($header, 0, $header.Length)
        $stream.Write($payload, 0, $payload.Length)
        $stream.Flush()

        $lengthBytes = [byte[]]::new(4)
        $read = 0
        while ($read -lt 4) {
            $count = $stream.Read($lengthBytes, $read, 4 - $read)
            if ($count -le 0) { throw 'Connection closed before response header completed' }
            $read += $count
        }
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($lengthBytes) }
        $length = [BitConverter]::ToInt32($lengthBytes, 0)
        # The plugin caps responses at 8 MiB. Enforce the same boundary here so
        # a corrupted or hostile peer cannot make this diagnostic allocate an
        # attacker-controlled amount of memory before JSON validation.
        if ($length -le 0 -or $length -gt 8MB) {
            throw "Invalid response frame length: $length"
        }

        $responseBytes = [byte[]]::new($length)
        $read = 0
        while ($read -lt $length) {
            $count = $stream.Read($responseBytes, $read, $length - $read)
            if ($count -le 0) { throw 'Connection closed before response payload completed' }
            $read += $count
        }

        $responseText = [System.Text.Encoding]::UTF8.GetString($responseBytes)
        $response = $responseText | ConvertFrom-Json
        $response | ConvertTo-Json -Compress -Depth 30
    }
    finally {
        $client.Dispose()
    }
}
catch {
    [Console]::Error.WriteLine("invoke-tcp-command failed: $($_.Exception.Message)")
    exit 1
}

# When this script is invoked from another PowerShell script, a successful
# scriptblock does not reliably populate the caller's $LASTEXITCODE. The
# survival harness treats a missing exit status as a transport failure, so make
# the success contract explicit just as the catch path makes failure explicit.
exit 0
