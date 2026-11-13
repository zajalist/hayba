$ErrorActionPreference = 'Stop'

function Read-HaybaJson([string]$Path) {
    try {
        $value = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
        if ($null -eq $value -or $value -isnot [pscustomobject]) { throw 'Expected an object' }
        return $value
    } catch { throw "Cannot read JSON at $Path. Fix this file before installing; it was not changed." }
}

function Set-HaybaProperty($Object, [string]$Name, $Value) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Get-HaybaHash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','') }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Assert-HaybaLocalPath([string]$Path, [string]$Root, [hashtable]$Validated) {
    $full = [IO.Path]::GetFullPath($Path)
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\','/')
    if ($full -ne $base -and -not $full.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe path outside selected project: $full" }
    $cursor = $full
    while ($cursor.Length -ge $base.Length) {
        if ($Validated -and $Validated.ContainsKey($cursor)) { break }
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Folder links and junctions cannot be replaced by this installer: $cursor" }
        }
        if ($null -ne $Validated) { $Validated[$cursor] = $true }
        if ($cursor -eq $base) { break }
        $cursor = Split-Path -Parent $cursor
    }
}

function Get-HaybaProcesses { @(Get-CimInstance Win32_Process -ErrorAction Stop) }

function Assert-HaybaProjectClosed([string]$Project, [string]$Plugin) {
    $projectName = $Project.Replace('/','\')
    $pluginName = $Plugin.Replace('/','\')
    foreach ($process in @(Get-HaybaProcesses)) {
        $command = ([string]$process.CommandLine).Replace('/','\')
        if ($process.Name -like 'UnrealEditor*' -and $command.IndexOf($projectName, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw "Close Unreal for this project before installing (PID $($process.ProcessId)). Save your work first."
        }
        if ($process.Name -in @('node.exe','cl.exe','link.exe','dotnet.exe') -and
            ($command.IndexOf($pluginName, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $command.IndexOf($projectName, [StringComparison]::OrdinalIgnoreCase) -ge 0)) {
            throw "A Hayba server or build is using this project (PID $($process.ProcessId)). Close its Claude session or stop its sidecar/build before updating."
        }
    }
}

function Get-HaybaEngines {
    $found = @{}
    foreach ($key in @('HKLM:\SOFTWARE\EpicGames\Unreal Engine','HKLM:\SOFTWARE\WOW6432Node\EpicGames\Unreal Engine')) {
        if (Test-Path $key) {
            foreach ($child in Get-ChildItem $key) {
                $path = (Get-ItemProperty $child.PSPath -ErrorAction SilentlyContinue).InstalledDirectory
                if ($path) { $found[$path] = $true }
            }
        }
    }
    $custom = 'HKCU:\Software\Epic Games\Unreal Engine\Builds'
    if (Test-Path $custom) {
        foreach ($property in (Get-ItemProperty $custom).PSObject.Properties) {
            if ($property.Name -notlike 'PS*' -and $property.Value -is [string]) { $found[$property.Value] = $true }
        }
    }
    $default = Join-Path $env:ProgramFiles 'Epic Games'
    if (Test-Path $default) { foreach ($dir in Get-ChildItem $default -Directory -Filter 'UE_*') { $found[$dir.FullName] = $true } }
    foreach ($path in $found.Keys) { if (Test-Path -LiteralPath "$path/Engine/Build/Build.version") { $path } }
}

function Get-HaybaEngineInfo([string]$Engine) {
    $version = Read-HaybaJson "$Engine/Engine/Build/Build.version"
    $modules = Read-HaybaJson "$Engine/Engine/Binaries/Win64/UnrealEditor.modules"
    [pscustomobject]@{ Path=$Engine; MajorMinor="$($version.MajorVersion).$($version.MinorVersion)"; Version="$($version.MajorVersion).$($version.MinorVersion).$($version.PatchVersion)"; BuildId=[string]$modules.BuildId }
}

# The package's major.minor (e.g. 5.9) from a manifest engine version such as 5.9.0.
function Get-HaybaMajorMinor([string]$Version) { ($Version -split '\.')[0..1] -join '.' }

# Picks an installed engine for the package: same build first, else any matching major.minor (launcher hotfixes).
function Find-HaybaEngine($Manifest) {
    $want = Get-HaybaMajorMinor $Manifest.engine.version
    $found = @(foreach ($path in @(Get-HaybaEngines | Sort-Object)) { try { $info = Get-HaybaEngineInfo $path; if ($info.MajorMinor -eq $want) { $info } } catch { } })
    $best = @($found | Where-Object BuildId -eq $Manifest.engine.buildId) + @($found | Sort-Object Version -Descending)
    if (-not $best.Count) { throw "Unreal Engine $want was not found. Install Unreal Engine $want from the Epic Games Launcher, then run this installer again. No project files were changed." }
    return $best[0].Path
}

function Get-HaybaPayload([string]$PackageRoot, [string]$Engine) {
    $manifest = Read-HaybaJson (Join-Path $PackageRoot 'manifest.json')
    if ($manifest.schemaVersion -ne 1 -or -not $manifest.files -or -not $manifest.engine.buildId) { throw 'Invalid installer manifest.' }
    $engineInfo = Get-HaybaEngineInfo $Engine
    $want = Get-HaybaMajorMinor $manifest.engine.version
    if ($engineInfo.MajorMinor -ne $want) {
        throw "This Hayba build is for Unreal Engine $want.x. The selected engine is $($engineInfo.Version). Install Unreal Engine $want from the Epic Games Launcher; no project files were changed."
    }
    $payload = [IO.Path]::GetFullPath((Join-Path $PackageRoot 'payload/HaybaMCPToolkit'))
    $seen = @{}
    $validatedPaths = @{}
    foreach ($file in $manifest.files) {
        $name = [string]$file.path
        if (-not $name -or $name -match '(^[/\\]|:|(^|[/\\])\.\.?([/\\]|$))' -or $file.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid package file path or hash.' }
        if ($seen.ContainsKey($name)) { throw "Duplicate package path: $name" }
        $seen[$name] = $true
        $path = [IO.Path]::GetFullPath((Join-Path $payload $name))
        Assert-HaybaLocalPath $path $payload $validatedPaths
        if ((Get-HaybaHash $path) -ne $file.sha256) { throw "Package integrity check failed: $name. Extract a fresh copy of the installer." }
    }
    foreach ($required in @('HaybaMCPToolkit.uplugin','Binaries/Win64/UnrealEditor.modules','Binaries/Win64/UnrealEditor-HaybaMCPToolkit.dll','ThirdParty/node/node.exe','ThirdParty/mcp_server/dist/bootstrap.js','ThirdParty/mcp_server/dist/index.js','ThirdParty/mcp_server/run-mcp.cjs')) {
        if (-not $seen.ContainsKey($required)) { throw "Package is missing $required" }
    }
    if ((Read-HaybaJson "$payload/Binaries/Win64/UnrealEditor.modules").BuildId -ne $manifest.engine.buildId) { throw 'Bundled plugin build does not match the manifest.' }
    return [pscustomobject]@{ Manifest=$manifest; Root=$payload; Engine=$engineInfo }
}

function Get-HaybaServerName([string]$Project) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $suffix = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Project.ToLowerInvariant())))).Replace('-','').Substring(0,8).ToLowerInvariant() } finally { $sha.Dispose() }
    return 'hayba-' + $suffix
}

function Get-HaybaClientConfigs([string]$ProjectRoot, [string]$DesktopConfig, [string]$CursorConfig) {
    @(
        [pscustomobject]@{ Name='ClaudeCode'; Path="$ProjectRoot/.mcp.json"; Backup='claude-code.json'; Local=$true }
        [pscustomobject]@{ Name='ClaudeDesktop'; Path=$DesktopConfig; Backup='claude-desktop.json'; Local=$false }
        [pscustomobject]@{ Name='Cursor'; Path=$CursorConfig; Backup='cursor.json'; Local=$false }
    )
}

function New-HaybaJsonChange([string]$Path, [string]$BackupName, $Object, [string]$OriginalHash) {
    return [pscustomobject]@{ Path=$Path; BackupName=$BackupName; OriginalHash=$OriginalHash; Text=($Object | ConvertTo-Json -Depth 100); WrittenHash='' }
}

function New-HaybaMcpChange([string]$Path, [string]$BackupName, [string]$Name, $Entry) {
    $originalHash = Get-HaybaHash $Path
    $config = if ($originalHash) { Read-HaybaJson $Path } else { [pscustomobject]@{} }
    if ($config.PSObject.Properties['mcpServers'] -and $config.mcpServers -isnot [pscustomobject]) { throw "Invalid mcpServers JSON object: $Path" }
    if (-not $config.PSObject.Properties['mcpServers']) { Set-HaybaProperty $config 'mcpServers' ([pscustomobject]@{}) }
    $existing = $config.mcpServers.PSObject.Properties[$Name]
    if ($existing -and $existing.Value.command -ne $Entry.command) { throw "The MCP name $Name is already used by another server in $Path. Rename that entry before installing." }
    Set-HaybaProperty $config.mcpServers $Name $Entry
    return New-HaybaJsonChange $Path $BackupName $config $originalHash
}

function Write-HaybaJsonChange($Change) {
    if ((Get-HaybaHash $Change.Path) -ne $Change.OriginalHash) { throw "Configuration changed during installation: $($Change.Path). Retry after closing the app editing it." }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Change.Path)) | Out-Null
    $pending = $Change.Path + '.hayba-' + [Guid]::NewGuid().ToString('N')
    try {
        [IO.File]::WriteAllText($pending, $Change.Text + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
        if ($Change.OriginalHash) { [IO.File]::Replace($pending, $Change.Path, $pending + '.previous') }
        else { [IO.File]::Move($pending, $Change.Path) }
        $Change.WrittenHash = Get-HaybaHash $Change.Path
    } finally {
        foreach ($temporary in @($pending, $pending + '.previous')) { if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) } }
    }
}

function Invoke-HaybaInstall {
    param(
        [Parameter(Mandatory=$true)][string]$Project,
        [string]$Engine,
        [Parameter(Mandatory=$true)][string]$PackageRoot,
        [switch]$ClaudeCode, [switch]$ClaudeDesktop, [switch]$Cursor,
        [string]$DesktopConfig = (Join-Path $env:APPDATA 'Claude/claude_desktop_config.json'),
        [string]$CursorConfig = (Join-Path $env:USERPROFILE '.cursor/mcp.json'),
        [switch]$ReplaceExisting, [switch]$CheckOnly
    )
    if (-not $Engine) { $Engine = Find-HaybaEngine (Read-HaybaJson (Join-Path $PackageRoot 'manifest.json')) }
    $projectFile = Get-Item -LiteralPath $Project
    if ($projectFile.PSIsContainer -or $projectFile.Extension -ne '.uproject') { throw 'Choose an existing .uproject file.' }
    $Project = $projectFile.FullName
    $projectRoot = $projectFile.DirectoryName
    $plugin = Join-Path $projectRoot 'Plugins\HaybaMCPToolkit'
    $saved = Join-Path $projectRoot 'Saved\HaybaInstaller'
    foreach ($path in @($Project,$plugin,$saved,"$projectRoot/.mcp.json")) { Assert-HaybaLocalPath $path $projectRoot }
    Assert-HaybaProjectClosed $Project $plugin
    $exists = Test-Path -LiteralPath $plugin
    if ($exists -and -not $ReplaceExisting) { throw 'Hayba is already installed. Select Replace existing Hayba to back it up and update it.' }
    if ($exists -and -not (Test-Path -LiteralPath "$plugin/HaybaMCPToolkit.uplugin")) { throw 'The destination is not a Hayba plugin. It will not be replaced.' }
    Write-Host 'Checking Unreal build and package integrity...'
    $payload = Get-HaybaPayload $PackageRoot $Engine
    $projectHash = Get-HaybaHash $Project
    $descriptor = Read-HaybaJson $Project
    if ($descriptor.PSObject.Properties['Plugins'] -and $descriptor.Plugins -isnot [Array]) { throw 'Project Plugins must be a JSON array.' }
    $association = [string]$descriptor.EngineAssociation
    if ($association -match '^\d+\.\d+(\.\d+)?$' -and (Get-HaybaMajorMinor $association) -ne (Get-HaybaMajorMinor $payload.Manifest.engine.version)) {
        throw "This project uses Unreal $association, but this Hayba build is for Unreal $(Get-HaybaMajorMinor $payload.Manifest.engine.version). The installer does not upgrade projects; no files were changed."
    }
    $plugins = @($descriptor.Plugins | Where-Object { $null -ne $_ })
    foreach ($item in $plugins) { if ($item -isnot [pscustomobject] -or -not ($item.Name -is [string])) { throw 'Invalid plugin entry in project JSON.' } }
    $hayba = @($plugins | Where-Object Name -eq 'HaybaMCPToolkit')
    if ($hayba.Count -gt 1) { throw 'Project has duplicate Hayba plugin entries. Fix the project JSON first.' }
    if ($hayba.Count) { Set-HaybaProperty $hayba[0] 'Enabled' $true }
    else { $plugins += [pscustomobject]@{ Name='HaybaMCPToolkit'; Enabled=$true } }
    Set-HaybaProperty $descriptor 'Plugins' $plugins
    $name = Get-HaybaServerName $Project
    $entry = [pscustomobject]@{ command="$plugin\ThirdParty\node\node.exe"; args=@("$plugin\ThirdParty\mcp_server\run-mcp.cjs"); env=[pscustomobject]@{ DASHBOARD_PORT='0'; HAYBA_MCP_HTTP_PORT='0' } }
    $changes = @(New-HaybaJsonChange $Project 'project.json' $descriptor $projectHash)
    $wanted = @{ ClaudeCode=[bool]$ClaudeCode; ClaudeDesktop=[bool]$ClaudeDesktop; Cursor=[bool]$Cursor }
    foreach ($client in Get-HaybaClientConfigs $projectRoot $DesktopConfig $CursorConfig) {
        if (-not $wanted[$client.Name]) { continue }
        $path = [IO.Path]::GetFullPath($client.Path)
        if (-not $client.Local) { Assert-HaybaLocalPath $path ([IO.Path]::GetPathRoot($path)) }
        $changes += New-HaybaMcpChange $path $client.Backup $name $entry
    }
    if ($CheckOnly) { return [pscustomobject]@{ Project=$Project; Plugin=$plugin; ServerName=$name; Checked=$true } }
    $operation = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
    $stage = Join-Path $saved "staging-$operation"
    $backup = Join-Path $saved "backups/$operation"
    Assert-HaybaLocalPath $stage $projectRoot
    Assert-HaybaLocalPath $backup $projectRoot
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    [IO.Directory]::CreateDirectory($backup) | Out-Null
    $stagedPlugin = Join-Path $stage 'HaybaMCPToolkit'
    $movedOld = $false
    $installedNew = $false
    try {
        Write-Host 'Copying Hayba, bundled Node and MCP dependencies...'
        foreach ($file in $payload.Manifest.files) {
            $destination = Join-Path $stagedPlugin $file.path
            [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
            [IO.File]::Copy((Join-Path $payload.Root $file.path), $destination)
            if ((Get-HaybaHash $destination) -ne $file.sha256) { throw "Copied file failed integrity check: $($file.path)" }
        }
        if ($payload.Engine.BuildId -ne $payload.Manifest.engine.buildId) {
            # Launcher hotfixes of one minor version share an ABI (Epic keeps their CompatibleChangelist), which is how
            # Marketplace plugins load across 5.x.y. Stamp the engine's build so Unreal loads the prebuilt module.
            $modulesPath = Join-Path $stagedPlugin 'Binaries/Win64/UnrealEditor.modules'
            $modulesJson = Read-HaybaJson $modulesPath
            Set-HaybaProperty $modulesJson 'BuildId' $payload.Engine.BuildId
            [IO.File]::WriteAllText($modulesPath, ($modulesJson | ConvertTo-Json -Depth 10))
            Write-Host "Note: Hayba was built on Unreal $($payload.Manifest.engine.version) (build $($payload.Manifest.engine.buildId)); your engine is $($payload.Engine.Version) (build $($payload.Engine.BuildId)). It was marked compatible. If Unreal reports the plugin as incompatible, update Unreal from the Epic Games Launcher."
        }
        foreach ($change in $changes) {
            if ((Get-HaybaHash $change.Path) -ne $change.OriginalHash) { throw "Configuration changed during installation: $($change.Path)" }
            if ($change.OriginalHash) { [IO.File]::Copy($change.Path, (Join-Path $backup $change.BackupName)) }
        }
        Assert-HaybaProjectClosed $Project $plugin
        Assert-HaybaLocalPath $plugin $projectRoot
        Write-Host 'Installing plugin and saving configuration...'
        [IO.Directory]::CreateDirectory((Split-Path -Parent $plugin)) | Out-Null
        if ($exists) { [IO.Directory]::Move($plugin, "$backup/HaybaMCPToolkit"); $movedOld = $true }
        [IO.Directory]::Move($stagedPlugin, $plugin)
        $installedNew = $true
        foreach ($change in $changes) { Write-HaybaJsonChange $change }
        $receipt = @{ installedAt=[DateTime]::UtcNow.ToString('o'); version=$payload.Manifest.version; engine=$payload.Manifest.engine; installedEngine=$payload.Engine; project=$Project; backup=$backup; serverName=$name; configs=@($changes | ForEach-Object { @{ path=$_.Path; backup=$_.BackupName } }) }
        [IO.File]::WriteAllText("$backup/receipt.json", ($receipt | ConvertTo-Json -Depth 12))
        [IO.Directory]::Delete($stage)
        Write-Host "Installed. Backups: $backup"
        return [pscustomobject]@{ Project=$Project; Plugin=$plugin; ServerName=$name; Backup=$backup; Version=$payload.Manifest.version }
    } catch {
        $failure = $_.Exception.Message
        try {
            foreach ($change in $changes) {
                if ($change.WrittenHash) {
                    if ((Get-HaybaHash $change.Path) -ne $change.WrittenHash) { throw "Cannot roll back a concurrently edited file: $($change.Path)" }
                    if ($change.OriginalHash) { [IO.File]::Copy((Join-Path $backup $change.BackupName), $change.Path, $true) }
                    else { [IO.File]::Delete($change.Path) }
                }
            }
            if ($installedNew) { Assert-HaybaLocalPath $plugin $projectRoot; [IO.Directory]::Move($plugin, "$stage/failed-install") }
            if ($movedOld) { [IO.Directory]::Move("$backup/HaybaMCPToolkit", $plugin) }
        } catch { throw "$failure Rollback needs attention: $($_.Exception.Message). Backups: $backup" }
        throw "$failure Installation was rolled back. Diagnostic files: $stage. Backups: $backup"
    }
}

# Removes Hayba from one project: the plugin folder moves to Saved/HaybaInstaller (kept as a backup),
# the .uproject entry and this project's MCP entries are removed. Other settings are preserved.
function Invoke-HaybaUninstall {
    param(
        [Parameter(Mandatory=$true)][string]$Project,
        [string]$DesktopConfig = (Join-Path $env:APPDATA 'Claude/claude_desktop_config.json'),
        [string]$CursorConfig = (Join-Path $env:USERPROFILE '.cursor/mcp.json')
    )
    if (-not (Test-Path -LiteralPath $Project -PathType Leaf)) { Write-Host "Project not found, skipped: $Project"; return }
    $Project = (Get-Item -LiteralPath $Project).FullName
    $projectRoot = Split-Path -Parent $Project
    $plugin = Join-Path $projectRoot 'Plugins\HaybaMCPToolkit'
    Assert-HaybaLocalPath $plugin $projectRoot
    Assert-HaybaProjectClosed $Project $plugin
    $name = Get-HaybaServerName $Project
    $nodePath = "$plugin\ThirdParty\node\node.exe"
    foreach ($client in Get-HaybaClientConfigs $projectRoot $DesktopConfig $CursorConfig) {
        $path = [IO.Path]::GetFullPath($client.Path)
        $hash = Get-HaybaHash $path
        if (-not $hash) { continue }
        $config = Read-HaybaJson $path
        $entry = if ($config.PSObject.Properties['mcpServers']) { $config.mcpServers.PSObject.Properties[$name] } else { $null }
        if (-not $entry -or $entry.Value.command -ne $nodePath) { continue }
        $config.mcpServers.PSObject.Properties.Remove($name)
        Write-HaybaJsonChange (New-HaybaJsonChange $path $client.Backup $config $hash)
        Write-Host "Removed MCP server $name from $path"
    }
    $descriptor = Read-HaybaJson $Project
    if ($descriptor.PSObject.Properties['Plugins'] -and @($descriptor.Plugins | Where-Object Name -eq 'HaybaMCPToolkit').Count) {
        $hash = Get-HaybaHash $Project
        Set-HaybaProperty $descriptor 'Plugins' @($descriptor.Plugins | Where-Object { $_.Name -ne 'HaybaMCPToolkit' })
        Write-HaybaJsonChange (New-HaybaJsonChange $Project 'project.json' $descriptor $hash)
    }
    if ((Test-Path -LiteralPath "$plugin/HaybaMCPToolkit.uplugin")) {
        $removed = Join-Path $projectRoot ('Saved\HaybaInstaller\removed-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))
        [IO.Directory]::CreateDirectory($removed) | Out-Null
        [IO.Directory]::Move($plugin, "$removed\HaybaMCPToolkit")
        Write-Host "Removed Hayba from $Project (plugin kept at $removed)"
    }
}