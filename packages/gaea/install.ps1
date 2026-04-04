#Requires -Version 5.0
<#
.SYNOPSIS
    Installs gaea-mcp as a Claude Desktop MCP server.
.DESCRIPTION
    Detects Gaea installation, builds the server, writes config,
    and patches claude_desktop_config.json automatically.
#>

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== gaea-mcp Installer ===" -ForegroundColor Cyan

# 1. Check Node.js >= 20
try
{
    $nodeVersion = (node --version 2>&1).ToString().TrimStart("v")
    $major = [int]($nodeVersion.Split(".")[0])
    if ($major -lt 20) { throw "Node.js 20+ required. Found: $nodeVersion" }
    Write-Host "[OK] Node.js $nodeVersion" -ForegroundColor Green
}
catch
{
    Write-Error "Node.js 20+ is required. Download from https://nodejs.org"
    exit 1
}

# 2. Detect Gaea.exe
$gaeaCandidates = @(
    "$env:LOCALAPPDATA\Programs\Gaea 2.0\Gaea.exe",
    "$env:LOCALAPPDATA\Programs\Gaea 2.2\Gaea.exe",
    "$env:LOCALAPPDATA\Programs\Gaea\Gaea.exe",
    "C:\Program Files\QuadSpinner\Gaea 2\Gaea.exe"
)
$gaeaExePath = $gaeaCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $gaeaExePath)
{
    Write-Host "Gaea.exe not auto-detected. Enter path manually (or press Enter to skip):" -ForegroundColor Yellow
    $manual = Read-Host
    if ($manual -and (Test-Path $manual)) { $gaeaExePath = $manual }
    else { $gaeaExePath = "" }
}

if ($gaeaExePath)
{
    Write-Host "[OK] Gaea found: $gaeaExePath" -ForegroundColor Green
}
else
{
    Write-Host "[WARN] Gaea not found. open_session will not launch Gaea automatically." -ForegroundColor Yellow
}

# 3. Detect Gaea.BuildManager.exe
$buildManagerPath = $gaeaExePath -replace "Gaea\.exe$", "Gaea.BuildManager.exe"
if (-not (Test-Path $buildManagerPath))
{
    $buildManagerPath = "C:\Program Files\QuadSpinner\Gaea 2\Gaea.BuildManager.exe"
}

# 4. Ask for output folder
$defaultOutput = "$env:USERPROFILE\Desktop\gaea_output"
Write-Host "Default heightmap output folder [$defaultOutput]:" -ForegroundColor Cyan
$outputDir = Read-Host
if (-not $outputDir) { $outputDir = $defaultOutput }
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Write-Host "[OK] Output folder: $outputDir" -ForegroundColor Green

# 5. npm install + build
Write-Host "Installing dependencies..." -ForegroundColor Cyan
Push-Location $ScriptDir
npm install --silent
npm run build
Pop-Location
Write-Host "[OK] Build complete" -ForegroundColor Green

# 6. Write swarmhost.config.json
$config = @{
    execPath    = $buildManagerPath
    port        = 0
    outputDir   = $outputDir
    gaeaExePath = $gaeaExePath
} | ConvertTo-Json -Depth 3
Set-Content -Path "$ScriptDir\swarmhost.config.json" -Value $config -Encoding UTF8
Write-Host "[OK] Config written: $ScriptDir\swarmhost.config.json" -ForegroundColor Green

# 7. Patch Claude Desktop config
$claudeConfig = "$env:APPDATA\Claude\claude_desktop_config.json"
if (Test-Path $claudeConfig)
{
    $cfg = Get-Content $claudeConfig -Raw | ConvertFrom-Json
    if (-not $cfg.mcpServers) { $cfg | Add-Member -Name mcpServers -Value ([PSCustomObject]@{}) -MemberType NoteProperty }
    $cfg.mcpServers | Add-Member -Name "gaea-mcp" -Value ([PSCustomObject]@{
        command = "node"
        args    = @("$ScriptDir\dist\index.js")
    }) -MemberType NoteProperty -Force
    $cfg | ConvertTo-Json -Depth 10 | Set-Content $claudeConfig -Encoding UTF8
    Write-Host "[OK] Claude Desktop config patched" -ForegroundColor Green
}
else
{
    Write-Host "[WARN] Claude Desktop config not found at $claudeConfig" -ForegroundColor Yellow
    Write-Host "  Add manually: {`"gaea-mcp`": { `"command`": `"node`", `"args`": [`"$ScriptDir\dist\index.js`"] }}"
}

Write-Host ""
Write-Host "=== Installation complete ===" -ForegroundColor Green
Write-Host "Restart Claude Desktop and say: 'Open a new terrain session'" -ForegroundColor Cyan
