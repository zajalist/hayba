# Test-only CIM adapter for the owned host-proof fixture on Linux. It reads
# live /proc data so the production helper still has to prove the exact
# process, command line, and listening socket on each separate query.
function Get-CimInstance {
    param([string]$ClassName, [string]$Namespace, [string]$Filter, [string]$ErrorAction)

    if ($ClassName -ceq 'MSFT_NetTCPConnection') {
        if ($Namespace -cne 'root/StandardCimv2' -or
            $Filter -cnotmatch '^LocalPort = (\d+) AND State = 2$') {
            throw 'Unexpected listener query in Linux fixture'
        }
        $requestedPort = [int]$Matches[1]
        $socketInodes = [Collections.Generic.HashSet[string]]::new()
        foreach ($table in @('/proc/net/tcp', '/proc/net/tcp6')) {
            if (-not [IO.File]::Exists($table)) { continue }
            foreach ($line in [IO.File]::ReadLines($table)) {
                $fields = $line.Trim() -split '\s+'
                if ($fields.Length -lt 10 -or $fields[3] -cne '0A') { continue }
                $hexPort = ($fields[1] -split ':')[-1]
                if ([Convert]::ToInt32($hexPort, 16) -eq $requestedPort) {
                    [void]$socketInodes.Add($fields[9])
                }
            }
        }
        if ($socketInodes.Count -eq 0) { return }
        foreach ($fd in [IO.Directory]::EnumerateFileSystemEntries("/proc/$ProcessId/fd")) {
            $target = & readlink -- $fd 2>$null
            if ($LASTEXITCODE -ne 0 -or $target -cnotmatch '^socket:\[(\d+)\]$') { continue }
            if ($socketInodes.Contains($Matches[1])) {
                return [pscustomobject]@{ LocalPort=$requestedPort; State=2; OwningProcess=$ProcessId }
            }
        }
        return
    }

    if ($Namespace -or $ClassName -cne 'Win32_Process' -or $Filter -cnotmatch '^ProcessId = (\d+)$') {
        throw 'Unexpected process query in Linux fixture'
    }
    $requestedPid = [int]$Matches[1]
    $process = [Diagnostics.Process]::GetProcessById($requestedPid)
    try {
        $commandLine = [Text.Encoding]::UTF8.GetString(
            [IO.File]::ReadAllBytes("/proc/$requestedPid/cmdline")
        ).TrimEnd([char]0).Replace([char]0, ' ')
        # Process.StartTime on Linux is recomputed from wall time and uptime;
        # its fractional ticks may drift between fresh helper processes. The
        # kernel's boot time plus start tick is a stable process identity.
        $stat = [IO.File]::ReadAllText("/proc/$requestedPid/stat")
        $fields = $stat.Substring($stat.LastIndexOf(')') + 2) -split '\s+'
        if ($fields.Length -lt 20) { throw 'Incomplete Linux process stat' }
        $startTicks = [long]$fields[19]
        $bootLine = [IO.File]::ReadLines('/proc/stat') |
            Where-Object { $_ -match '^btime \d+$' } | Select-Object -First 1
        if ($bootLine -notmatch '^btime (\d+)$') { throw 'Linux boot time unavailable' }
        $bootSeconds = [long]$Matches[1]
        $clockTicksPerSecond = [int](& getconf CLK_TCK)
        if ($clockTicksPerSecond -le 0) { throw 'Linux clock tick rate unavailable' }
        $startDate = [DateTimeOffset]::FromUnixTimeSeconds($bootSeconds).UtcDateTime.AddTicks(
            [long]([decimal]$startTicks * [TimeSpan]::TicksPerSecond / $clockTicksPerSecond)
        )
        return [pscustomobject]@{
            ProcessId=$requestedPid
            ExecutablePath=$process.MainModule.FileName
            CreationDate=$startDate
            CommandLine=$commandLine
        }
    }
    finally { $process.Dispose() }
}
