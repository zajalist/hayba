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

function Get-HaybaEngineVersion([string]$Engine) {
    $version = Read-HaybaJson "$Engine/Engine/Build/Build.version"
    return [pscustomobject]@{
        Full = "$($version.MajorVersion).$($version.MinorVersion).$($version.PatchVersion)"
        Series = "$($version.MajorVersion).$($version.MinorVersion)"
    }
}

function Get-HaybaPayload([string]$PackageRoot, [string]$Engine) {
    $manifest = Read-HaybaJson (Join-Path $PackageRoot 'manifest.json')
    if ($manifest.schemaVersion -ne 1 -or -not $manifest.files -or -not $manifest.engine.version) { throw 'Invalid installer manifest.' }
    $engineVersion = Get-HaybaEngineVersion $Engine
    $wanted = [string]$manifest.engine.version
    $wantedSeries = if ($wanted -match '^(\d+\.\d+)') { $Matches[1] } else { $wanted }
    if ($engineVersion.Series -ne $wantedSeries) {
        throw "This package is for Unreal $wantedSeries. Selected engine is $($engineVersion.Full). Choose a matching Unreal folder; no project files were changed."
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
    foreach ($required in @('HaybaMCPToolkit.uplugin','Source/HaybaMCPToolkit/HaybaMCPToolkit.Build.cs','ThirdParty/node/node.exe','ThirdParty/mcp_server/dist/bootstrap.js','ThirdParty/mcp_server/dist/index.js','ThirdParty/mcp_server/run-mcp.cjs')) {
        if (-not $seen.ContainsKey($required)) { throw "Package is missing $required" }
    }
    return [pscustomobject]@{ Manifest=$manifest; Root=$payload; EngineVersion=$engineVersion }
}

function Get-HaybaEditorTarget([string]$ProjectRoot) {
    $source = Join-Path $ProjectRoot 'Source'
    if (Test-Path -LiteralPath $source) {
        $editor = Get-ChildItem -LiteralPath $source -Filter '*Editor.Target.cs' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($editor) { return [IO.Path]::GetFileNameWithoutExtension($editor.Name) }
    }
    return 'UnrealEditor'
}

function Invoke-HaybaPluginCompile([string]$Engine, [string]$Project, [string]$Plugin) {
    foreach ($stale in @('Binaries','Intermediate')) {
        $path = Join-Path $Plugin $stale
        if (Test-Path -LiteralPath $path) {
            Write-Host "Removing previous $stale so this machine compiles a fresh plugin..."
            Remove-Item -LiteralPath $path -Recurse -Force
        }
    }
    if ($script:HaybaBuildInvoker) {
        & $script:HaybaBuildInvoker $Engine $Project $Plugin
        return
    }
    $build = Join-Path $Engine 'Engine\Build\BatchFiles\Build.bat'
    if (-not (Test-Path -LiteralPath $build)) { throw "Unreal build tool not found at $build. Install this engine's C++ tools, then retry." }
    $target = Get-HaybaEditorTarget (Split-Path -Parent $Project)
    Write-Host "Compiling Hayba for $target on this Unreal install. This can take several minutes..."
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $build $target Win64 Development "-Project=$Project" -WaitMutex
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($code -ne 0) {
        throw "Unreal compile failed (exit $code). Install Visual Studio's Game development with C++ workload for this engine, then retry."
    }
    $dll = Join-Path $Plugin 'Binaries\Win64\UnrealEditor-HaybaMCPToolkit.dll'
    if (-not (Test-Path -LiteralPath $dll)) {
        throw 'Compile finished without producing UnrealEditor-HaybaMCPToolkit.dll. Open the Unreal build log, then retry.'
    }
    Write-Host 'Plugin compile succeeded.'
}

function Reset-HaybaLocalChatPaths([string]$ProjectRoot) {
    $ini = Join-Path $ProjectRoot 'Saved\Config\WindowsEditor\EditorPerProjectUserSettings.ini'
    if (-not (Test-Path -LiteralPath $ini)) { return }
    $text = [IO.File]::ReadAllText($ini)
    $updated = [regex]::Replace($text, '(?im)^SidecarEntryPath=.*$', 'SidecarEntryPath=')
    if ($updated -eq $text) { return }
    [IO.File]::WriteAllText($ini, $updated)
    Write-Host 'Cleared a previous Sidecar path so this install uses the bundled chat server.'
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
        [Parameter(Mandatory=$true)][string]$Engine,
        [Parameter(Mandatory=$true)][string]$PackageRoot,
        [switch]$ClaudeCode, [switch]$ClaudeDesktop,
        [string]$DesktopConfig = (Join-Path $env:APPDATA 'Claude/claude_desktop_config.json'),
        [switch]$ReplaceExisting, [switch]$CheckOnly, [switch]$SkipCompile
    )
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
    $wantedSeries = if ([string]$payload.Manifest.engine.version -match '^(\d+\.\d+)') { $Matches[1] } else { [string]$payload.Manifest.engine.version }
    if ($association -match '^(\d+\.\d+)' -and $Matches[1] -ne $wantedSeries) {
        throw "Project uses Unreal $association. Choose a package and engine matching this project; the installer does not upgrade projects."
    }
    $plugins = @($descriptor.Plugins | Where-Object { $null -ne $_ })
    foreach ($item in $plugins) { if ($item -isnot [pscustomobject] -or -not ($item.Name -is [string])) { throw 'Invalid plugin entry in project JSON.' } }
    $hayba = @($plugins | Where-Object Name -eq 'HaybaMCPToolkit')
    if ($hayba.Count -gt 1) { throw 'Project has duplicate Hayba plugin entries. Fix the project JSON first.' }
    if ($hayba.Count) { Set-HaybaProperty $hayba[0] 'Enabled' $true }
    else { $plugins += [pscustomobject]@{ Name='HaybaMCPToolkit'; Enabled=$true } }
    Set-HaybaProperty $descriptor 'Plugins' $plugins
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $suffix = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Project.ToLowerInvariant())))).Replace('-','').Substring(0,8).ToLowerInvariant() } finally { $sha.Dispose() }
    $name = 'hayba-' + $suffix
    $entry = [pscustomobject]@{ command="$plugin\ThirdParty\node\node.exe"; args=@("$plugin\ThirdParty\mcp_server\run-mcp.cjs"); env=[pscustomobject]@{ DASHBOARD_PORT='0'; HAYBA_MCP_HTTP_PORT='0' } }
    $changes = @(New-HaybaJsonChange $Project 'project.json' $descriptor $projectHash)
    if ($ClaudeCode) { $changes += New-HaybaMcpChange "$projectRoot/.mcp.json" 'claude-code.json' $name $entry }
    if ($ClaudeDesktop) {
        $DesktopConfig = [IO.Path]::GetFullPath($DesktopConfig)
        Assert-HaybaLocalPath $DesktopConfig ([IO.Path]::GetPathRoot($DesktopConfig))
        $changes += New-HaybaMcpChange $DesktopConfig 'claude-desktop.json' $name $entry
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
        Reset-HaybaLocalChatPaths $projectRoot
        if (-not $SkipCompile) { Invoke-HaybaPluginCompile $Engine $Project $plugin }
        $receipt = @{ installedAt=[DateTime]::UtcNow.ToString('o'); version=$payload.Manifest.version; engine=$payload.Manifest.engine; project=$Project; backup=$backup; serverName=$name; compiled=(-not [bool]$SkipCompile); configs=@($changes | ForEach-Object { @{ path=$_.Path; backup=$_.BackupName } }) }
        [IO.File]::WriteAllText("$backup/receipt.json", ($receipt | ConvertTo-Json -Depth 12))
        [IO.Directory]::Delete($stage)
        Write-Host "Installed. Open Plugins\HaybaMCPToolkit\Hayba.exe for the standalone chat app, or Tools > Hayba MCP Toolkit in Unreal. Enter your API key in Settings, then send. Backups: $backup"
        return [pscustomobject]@{ Project=$Project; Plugin=$plugin; ServerName=$name; Backup=$backup; Version=$payload.Manifest.version; Compiled=(-not [bool]$SkipCompile) }
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
