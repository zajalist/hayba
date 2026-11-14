$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Installer.Core.ps1"
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Expect-Failure([scriptblock]$action, [string]$pattern) {
    try { & $action | Out-Null } catch { if ($_.Exception.Message -notmatch $pattern) { throw }; return }
    throw "Expected failure: $pattern"
}
function Get-HaybaProcesses { @() }
$root = Join-Path ([IO.Path]::GetTempPath()) ('hayba-installer-test-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    $bundle = Join-Path $root 'Package with spaces'
    $payload = Join-Path $bundle 'payload/HaybaMCPToolkit'
    $engine = Join-Path $root 'Engine with spaces'
    $game = Join-Path $root 'My game'
    foreach ($dir in @($payload, "$engine/Engine/Build", "$engine/Engine/Binaries/Win64", $game)) { [IO.Directory]::CreateDirectory($dir) | Out-Null }
    [IO.File]::WriteAllText("$engine/Engine/Build/Build.version", '{"MajorVersion":5,"MinorVersion":9,"PatchVersion":0}')
    [IO.File]::WriteAllText("$engine/Engine/Binaries/Win64/UnrealEditor.modules", '{"BuildId":"foreign-machine"}')
    [IO.File]::WriteAllText("$game/Game.uproject", '{"FileVersion":3,"EngineAssociation":"5.9","Description":"Keep me","Plugins":[{"Name":"Other","Enabled":true},{"Name":"HaybaMCPToolkit","Enabled":false}]}')
    $relative = @('HaybaMCPToolkit.uplugin','Source/HaybaMCPToolkit/HaybaMCPToolkit.Build.cs','ThirdParty/node/node.exe','ThirdParty/mcp_server/dist/bootstrap.js','ThirdParty/mcp_server/dist/index.js','ThirdParty/mcp_server/run-mcp.cjs','Resources/chat/index.html')
    $files = @()
    foreach ($name in $relative) {
        $path = Join-Path $payload $name
        [IO.Directory]::CreateDirectory((Split-Path $path)) | Out-Null
        $value = if ($name.EndsWith('.uplugin')) { '{"VersionName":"test"}' } elseif ($name.EndsWith('.Build.cs')) { 'source' } else { 'fixture' }
        [IO.File]::WriteAllText($path, $value)
        $files += @{ path=$name; sha256=(Get-FileHash $path).Hash }
    }
    $manifest = @{ schemaVersion=1; version='test'; engine=@{ version='5.9.0'; verifiedBuildId='package-machine' }; files=$files }
    [IO.File]::WriteAllText("$bundle/manifest.json", ($manifest | ConvertTo-Json -Depth 20))
    $desktop = Join-Path $root 'Claude/config.json'
    [IO.Directory]::CreateDirectory((Split-Path $desktop)) | Out-Null
    [IO.File]::WriteAllText($desktop, '{"theme":"dark","mcpServers":{"existing":{"command":"keep","env":{"TOKEN":"do-not-log"}}}}')
    [IO.File]::WriteAllText("$game/.mcp.json", '{"mcpServers":{"existing":{"command":"keep"}}}')
    $installArgs = @{ Project="$game/Game.uproject"; Engine=$engine; PackageRoot=$bundle; ClaudeCode=$true; ClaudeDesktop=$true; DesktopConfig=$desktop }
    $script:HaybaBuildInvoker = {
        param($EnginePath, $ProjectPath, $PluginPath)
        Assert (-not (Test-Path "$PluginPath/Binaries/Win64/stale.dll")) 'Previous plugin binaries were not discarded before compile'
        $out = Join-Path $PluginPath 'Binaries/Win64'
        [IO.Directory]::CreateDirectory($out) | Out-Null
        [IO.File]::WriteAllText((Join-Path $out 'UnrealEditor-HaybaMCPToolkit.dll'), 'compiled-on-this-pc')
    }
    Invoke-HaybaInstall @installArgs -CheckOnly | Out-Null
    Assert (-not (Test-Path "$game/Plugins/HaybaMCPToolkit")) 'CheckOnly mutated project'
    [IO.File]::WriteAllText("$engine/Engine/Build/Build.version", '{"MajorVersion":5,"MinorVersion":8,"PatchVersion":0}')
    Expect-Failure { Invoke-HaybaInstall @installArgs } 'Unreal 5\.9'
    [IO.File]::WriteAllText("$engine/Engine/Build/Build.version", '{"MajorVersion":5,"MinorVersion":9,"PatchVersion":1}')
    Invoke-HaybaInstall @installArgs -CheckOnly | Out-Null
    [IO.File]::WriteAllText("$engine/Engine/Build/Build.version", '{"MajorVersion":5,"MinorVersion":9,"PatchVersion":0}')
    [IO.File]::WriteAllText("$payload/Resources/chat/index.html", 'tampered')
    Expect-Failure { Invoke-HaybaInstall @installArgs } 'integrity'
    [IO.File]::WriteAllText("$payload/Resources/chat/index.html", 'fixture')
    function Get-HaybaProcesses { @([pscustomobject]@{ Name='UnrealEditor.exe'; ProcessId=123; CommandLine='UnrealEditor.exe "' + $game + '/Game.uproject"' }) }
    Expect-Failure { Invoke-HaybaInstall @installArgs } 'Close Unreal'
    function Get-HaybaProcesses { @() }
    $result = Invoke-HaybaInstall @installArgs
    Assert $result.Compiled 'Install skipped compile'
    Assert (Test-Path "$game/Plugins/HaybaMCPToolkit/ThirdParty/node/node.exe") 'Payload missing'
    Assert (Test-Path "$game/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/HaybaMCPToolkit.Build.cs") 'Source missing'
    Assert ((Get-Content "$game/Plugins/HaybaMCPToolkit/Binaries/Win64/UnrealEditor-HaybaMCPToolkit.dll" -Raw) -eq 'compiled-on-this-pc') 'Compile did not produce a local DLL'
    $project = Get-Content "$game/Game.uproject" -Raw | ConvertFrom-Json
    Assert ($project.Description -eq 'Keep me') 'Project content lost'
    Assert (($project.Plugins | Where-Object Name -eq 'HaybaMCPToolkit').Enabled) 'Plugin not enabled'
    $config = Get-Content $desktop -Raw | ConvertFrom-Json
    Assert ($config.theme -eq 'dark' -and $config.mcpServers.existing.env.TOKEN -eq 'do-not-log') 'Existing MCP config lost'
    $entry = $config.mcpServers.($result.ServerName)
    Assert ($entry.command -eq "$game\Plugins\HaybaMCPToolkit\ThirdParty\node\node.exe") 'MCP executable is not project-local'
    Assert ($entry.args[0].EndsWith('run-mcp.cjs')) 'MCP launcher missing'
    Assert (Test-Path "$($result.Backup)/project.json") 'Project backup missing'
    Expect-Failure { Invoke-HaybaInstall @installArgs } 'already installed'
    [IO.Directory]::CreateDirectory("$game/Plugins/HaybaMCPToolkit/Binaries/Win64") | Out-Null
    [IO.File]::WriteAllText("$game/Plugins/HaybaMCPToolkit/Binaries/Win64/stale.dll", 'other-computer')
    $iniDir = Join-Path $game 'Saved/Config/WindowsEditor'
    [IO.Directory]::CreateDirectory($iniDir) | Out-Null
    [IO.File]::WriteAllText("$iniDir/EditorPerProjectUserSettings.ini", "[/Script/HaybaMCPToolkit]`r`nSidecarEntryPath=C:\\old-machine\\index.js`r`n")
    Invoke-HaybaInstall @installArgs -ReplaceExisting | Out-Null
    Assert ((Get-Content "$game/Plugins/HaybaMCPToolkit/Binaries/Win64/UnrealEditor-HaybaMCPToolkit.dll" -Raw) -eq 'compiled-on-this-pc') 'Update did not recompile'
    Assert (-not (Test-Path "$game/Plugins/HaybaMCPToolkit/Binaries/Win64/stale.dll")) 'Update kept previous binaries'
    Assert ((Get-Content "$iniDir/EditorPerProjectUserSettings.ini" -Raw) -notmatch 'old-machine') 'Stale sidecar path was not cleared'
    [IO.File]::WriteAllText($desktop, '{broken')
    $before = (Get-FileHash "$game/Game.uproject").Hash
    Expect-Failure { Invoke-HaybaInstall @installArgs -ReplaceExisting } 'JSON'
    Assert ((Get-FileHash "$game/Game.uproject").Hash -eq $before) 'Invalid config modified project'
    [IO.File]::WriteAllText($desktop, '{}')
    $originalWriter = (Get-Item function:Write-HaybaJsonChange).ScriptBlock
    function Write-HaybaJsonChange($Change) {
        if ($Change.BackupName -eq 'claude-desktop.json') { throw 'Injected config write failure' }
        & $originalWriter $Change
    }
    $before = (Get-FileHash "$game/Game.uproject").Hash
    [IO.File]::WriteAllText("$game/Plugins/HaybaMCPToolkit/old-install.txt", 'preserve')
    Expect-Failure { Invoke-HaybaInstall @installArgs -ReplaceExisting } 'rolled back'
    Assert ((Get-FileHash "$game/Game.uproject").Hash -eq $before) 'Rollback lost project settings'
    Assert (Test-Path "$game/Plugins/HaybaMCPToolkit/old-install.txt") 'Rollback lost original plugin'
    Set-Item function:Write-HaybaJsonChange $originalWriter
    $script:HaybaBuildInvoker = { throw 'Injected compile failure' }
    $before = (Get-FileHash "$game/Game.uproject").Hash
    Expect-Failure { Invoke-HaybaInstall @installArgs -ReplaceExisting } 'Injected compile failure'
    Assert ((Get-FileHash "$game/Game.uproject").Hash -eq $before) 'Compile failure mutated project'
    Assert (Test-Path "$game/Plugins/HaybaMCPToolkit/old-install.txt") 'Compile failure lost original plugin'
    $script:HaybaBuildInvoker = {
        param($EnginePath, $ProjectPath, $PluginPath)
        $out = Join-Path $PluginPath 'Binaries/Win64'
        [IO.Directory]::CreateDirectory($out) | Out-Null
        [IO.File]::WriteAllText((Join-Path $out 'UnrealEditor-HaybaMCPToolkit.dll'), 'compiled-on-this-pc')
    }
    $manifest.files[0].path = '../outside'
    [IO.File]::WriteAllText("$bundle/manifest.json", ($manifest | ConvertTo-Json -Depth 20))
    Expect-Failure { Invoke-HaybaInstall @installArgs -ReplaceExisting } 'path'
    $manifest.files[0].path = 'HaybaMCPToolkit.uplugin'
    [IO.File]::WriteAllText("$bundle/manifest.json", ($manifest | ConvertTo-Json -Depth 20))
    $real = Join-Path $root 'External plugin'
    Move-Item -LiteralPath "$game/Plugins/HaybaMCPToolkit" -Destination $real
    New-Item -ItemType Junction -Path "$game/Plugins/HaybaMCPToolkit" -Target $real | Out-Null
    Expect-Failure { Invoke-HaybaInstall @installArgs -ReplaceExisting } 'link|junction'
    Assert (Test-Path "$real/HaybaMCPToolkit.uplugin") 'Junction target damaged'
    [IO.Directory]::Delete("$game/Plugins/HaybaMCPToolkit")
    'All installer checks passed.'
} finally {
    $resolved = [IO.Path]::GetFullPath($root)
    if (-not $resolved.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $resolved -Leaf) -notlike 'hayba-installer-test-*') { throw 'Unsafe cleanup path' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
