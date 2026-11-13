param(
    [Parameter(Mandatory=$true)][string]$Project, [string]$Engine,
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$ClaudeCode, [switch]$ClaudeDesktop, [string]$DesktopConfig,
    [switch]$Cursor, [string]$CursorConfig,
    [switch]$ReplaceExisting, [switch]$CheckOnly, [switch]$Uninstall
)
# Entry point used by the Setup .exe (tools/installer/hayba-setup.iss). Prints one
# "HAYBA_OK <server-name>" line on success, or "HAYBA_ERROR <message>" and exits 1.
$ErrorActionPreference = 'Stop'
# A PowerShell 7 parent leaks its module path; Windows PowerShell must autoload its own CimCmdlets.
if ($PSVersionTable.PSEdition -eq 'Desktop') { $env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine') }
. "$PSScriptRoot/Installer.Core.ps1"
try {
    $configs = @{}
    if ($DesktopConfig) { $configs.DesktopConfig = $DesktopConfig }
    if ($CursorConfig) { $configs.CursorConfig = $CursorConfig }
    if ($Uninstall) { Invoke-HaybaUninstall -Project $Project @configs; exit 0 }
    $settings = @{ Project=$Project; Engine=$Engine; PackageRoot=$PackageRoot; ClaudeCode=$ClaudeCode; ClaudeDesktop=$ClaudeDesktop; Cursor=$Cursor; ReplaceExisting=$ReplaceExisting; CheckOnly=$CheckOnly } + $configs
    $result = Invoke-HaybaInstall @settings
    Write-Host "HAYBA_OK $($result.ServerName)"
    exit 0
} catch {
    Write-Host "HAYBA_ERROR $($_.Exception.Message)"
    exit 1
}
