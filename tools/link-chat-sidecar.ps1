<# Link a source checkout's built chat server into an installed Windows plugin. #>
param([Parameter(Mandatory = $true)][string]$Project)
$ErrorActionPreference = 'Stop'

$projectFile = Get-Item -LiteralPath $Project
if ($projectFile.PSIsContainer -or $projectFile.Extension -ne '.uproject') {
    throw '-Project must point to an existing .uproject file.'
}
$plugin = Join-Path $projectFile.DirectoryName 'Plugins/HaybaMCPToolkit'
if (-not (Test-Path -LiteralPath (Join-Path $plugin 'HaybaMCPToolkit.uplugin'))) {
    throw "Install the HaybaMCPToolkit plugin in $plugin first."
}
$server = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../mcp-tools/hayba-mcp'))
if (-not (Test-Path -LiteralPath (Join-Path $server 'dist/index.js'))) {
    throw 'Build the server first: npm install, then npm run build:server -w @hayba/mcp from the Hayba checkout.'
}
$thirdParty = Join-Path $plugin 'ThirdParty'
$destination = Join-Path $thirdParty 'mcp_server'
if (Test-Path -LiteralPath $destination) {
    $existing = Get-Item -LiteralPath $destination
    if ($existing.LinkType -ne 'Junction' -or $existing.Target -ne $server) {
        throw "Refusing to replace the existing server at $destination. Check this installation manually."
    }
} else {
    New-Item -ItemType Directory -Path $thirdParty -Force | Out-Null
    New-Item -ItemType Junction -Path $destination -Target $server | Out-Null
}
Write-Output "Chat server linked: $destination -> $server"
Write-Output 'Keep this checkout in place. Retry chat (older plugin builds need an editor restart).'
