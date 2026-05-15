#!/usr/bin/env pwsh
<#
.SYNOPSIS
  HaybaOS UE plugin smoke test — fires one sample command per domain over TCP and asserts ok:true.

.PARAMETER Port
  TCP port the HaybaMCPToolkit server is listening on (default 52342).

.PARAMETER Auth
  Optional capability token (matches FHaybaMCPSettings::CapabilityToken).
#>
param(
    [int]$Port = 52342,
    [string]$Auth = ''
)

$ErrorActionPreference = 'Stop'

$client = New-Object System.Net.Sockets.TcpClient
try {
    $client.Connect('127.0.0.1', $Port)
} catch {
    Write-Error "Cannot connect to 127.0.0.1:$Port — is the UE editor open with HaybaMCPToolkit loaded? ($_)"
    exit 1
}
$stream = $client.GetStream()
$idCounter = 0

function Send-Command {
    param([string]$Cmd, [hashtable]$Params = @{})
    $script:idCounter++
    $req = @{ cmd = $Cmd; id = "smoke_$script:idCounter"; params = $Params }
    if ($Auth) { $req.auth = $Auth }
    $json = $req | ConvertTo-Json -Compress -Depth 10
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $header = [BitConverter]::GetBytes([Int32]$bytes.Length)
    if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($header) }
    $stream.Write($header, 0, 4)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()

    # Read length-prefixed response
    $lenBuf = New-Object byte[] 4
    $read = 0
    while ($read -lt 4) {
        $n = $stream.Read($lenBuf, $read, 4 - $read)
        if ($n -le 0) { throw "Connection closed mid-header" }
        $read += $n
    }
    if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($lenBuf) }
    $payloadLen = [BitConverter]::ToInt32($lenBuf, 0)
    $payload = New-Object byte[] $payloadLen
    $read = 0
    while ($read -lt $payloadLen) {
        $n = $stream.Read($payload, $read, $payloadLen - $read)
        if ($n -le 0) { throw "Connection closed mid-payload" }
        $read += $n
    }
    $resp = [System.Text.Encoding]::UTF8.GetString($payload) | ConvertFrom-Json
    return $resp
}

$commands = @(
    @{ Cmd = 'ping';                       Params = @{} },
    @{ Cmd = 'meta_list_domains';          Params = @{} },           # may not exist yet — see code-mode tools
    @{ Cmd = 'actor_list';                 Params = @{} },
    @{ Cmd = 'level_get_info';             Params = @{} },
    @{ Cmd = 'scene_export';               Params = @{ mode = 'flat'; max_items = 5 } },
    @{ Cmd = 'editor_get_performance_stats'; Params = @{} },
    @{ Cmd = 'editor_get_output_log';      Params = @{ lines = 5 } },
    @{ Cmd = 'docs_search';                Params = @{ query = 'StaticMesh' } },
    @{ Cmd = 'docs_lookup_class';          Params = @{ path = 'StaticMesh' } },
    @{ Cmd = 'asset_search';               Params = @{ path = '/Engine'; class_filter = 'StaticMesh' } },
    @{ Cmd = 'material_list';              Params = @{ path = '/Engine' } },
    @{ Cmd = 'foliage_list_types';         Params = @{} },
    @{ Cmd = 'wp_get_streaming_state';     Params = @{} },
    @{ Cmd = 'pcg_list_assets';            Params = @{} },
    @{ Cmd = 'list_node_classes';          Params = @{} },           # legacy alias
    @{ Cmd = 'seq_get_info';               Params = @{} },           # stub — should return ok:true with status:not_implemented
    @{ Cmd = 'mesh_list';                  Params = @{} }             # stub
)

$ok = 0
$err = 0
$skipped = 0
foreach ($c in $commands) {
    try {
        $resp = Send-Command -Cmd $c.Cmd -Params $c.Params
        if ($resp.ok -eq $true) {
            Write-Host "[OK]   $($c.Cmd)" -ForegroundColor Green
            $ok++
        } else {
            $msg = if ($resp.error) { $resp.error } else { '(no error message)' }
            # "not_implemented" is acceptable — stubs return ok:true with that status; if a command is genuinely unknown, the router returns ok:false
            if ($msg -match 'unknown|not registered') {
                Write-Host "[SKIP] $($c.Cmd) — $msg" -ForegroundColor Yellow
                $skipped++
            } else {
                Write-Host "[ERR]  $($c.Cmd) — $msg" -ForegroundColor Red
                $err++
            }
        }
    } catch {
        Write-Host "[ERR]  $($c.Cmd) — $_" -ForegroundColor Red
        $err++
    }
}

$client.Close()

Write-Host ''
Write-Host "Summary: $ok ok / $err err / $skipped skipped (of $($commands.Count) commands)"
if ($err -gt 0) { exit 1 } else { exit 0 }
