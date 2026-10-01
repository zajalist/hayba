#!/usr/bin/env pwsh
# This owned read helper has no editor-termination capability. Its parent bounds
# output and lifetime; CIM provider-side cessation is not a cancellation promise.
param([Parameter(Mandatory=$true)][int]$ProcessId,
 [int]$Port=0,[string]$ProjectPath,[string]$SessionToken,[switch]$IncludeListener)
$ErrorActionPreference='Stop'
function Resolve-FullPath([string]$Path){return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar,[IO.Path]::AltDirectorySeparatorChar)}
function Get-SanitizedHash([object]$Value){
 $json=ConvertTo-Json -InputObject $Value -Compress -Depth 30
 return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($json))).ToLowerInvariant()
}
function Test-ExactCommandLineArgument([string]$CommandLine,[string]$Argument){
 $escaped=[regex]::Escape($Argument)
 return [regex]::IsMatch($CommandLine,"(?:^|\s)(?:`"$escaped`"|$escaped)(?=\s|$)",[Text.RegularExpressions.RegexOptions]::CultureInvariant)
}
function ConvertTo-SurvivalProcessRow([object[]]$Rows,[int]$ProcessId){
 $Rows=@($Rows|Where-Object{$null -ne $_})
 if($Rows.Count -eq 0){throw "editor PID $ProcessId does not exist"}
 if($Rows.Count -ne 1){throw 'ambiguous process identity rows'}
 $row=$Rows[0]
 if([int]$row.ProcessId -ne $ProcessId){throw 'queried PID mismatch'}
 if([string]::IsNullOrWhiteSpace([string]$row.ExecutablePath) -or $null -eq $row.CreationDate -or [string]::IsNullOrWhiteSpace([string]$row.CommandLine)){throw 'process identity fields missing'}
 return [pscustomobject]@{
  ProcessId=$ProcessId
  ExecutablePath=Resolve-FullPath ([string]$row.ExecutablePath)
  CreationDate=([datetime]$row.CreationDate).ToUniversalTime().ToString('o')
  CommandLineSha256=Get-SanitizedHash ([string]$row.CommandLine)
  ExactSessionArgument=Test-ExactCommandLineArgument ([string]$row.CommandLine) "-HaybaSurvivalSession=$SessionToken"
  ExactProjectArgument=Test-ExactCommandLineArgument ([string]$row.CommandLine) $ProjectPath
 }
}
function Write-HostProofEvent([object]$Event){[Console]::Out.WriteLine((ConvertTo-Json -InputObject $Event -Compress -Depth 6))}
$phase='identity';$start=[Diagnostics.Stopwatch]::GetTimestamp()
try {
 Write-HostProofEvent @{kind='phase';phase=$phase;state='started';start_tick=$start}
 $process=ConvertTo-SurvivalProcessRow @(Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop) $ProcessId
 Write-HostProofEvent @{kind='phase';phase=$phase;state='completed';start_tick=$start;end_tick=[Diagnostics.Stopwatch]::GetTimestamp()}
 $owners=@()
 if($IncludeListener){
  $phase='listener';$start=[Diagnostics.Stopwatch]::GetTimestamp()
  Write-HostProofEvent @{kind='phase';phase=$phase;state='started';start_tick=$start}
  # Installed NetTCPIP CDXML defines Listen=2 in ROOT/StandardCimv2.
  $listeners=@(Get-CimInstance -Namespace 'root/StandardCimv2' -ClassName MSFT_NetTCPConnection -Filter "LocalPort = $Port AND State = 2" -ErrorAction Stop)
  if(@($listeners|Where-Object{[int]$_.LocalPort -ne $Port -or [int]$_.State -ne 2}).Count){throw 'listener query returned a row outside exact port/listen filter'}
  $owners=@($listeners|Select-Object -ExpandProperty OwningProcess -Unique)
  Write-HostProofEvent @{kind='phase';phase=$phase;state='completed';start_tick=$start;end_tick=[Diagnostics.Stopwatch]::GetTimestamp()}
 }
 Write-HostProofEvent @{kind='result';process=$process;listener_owners=$owners}
 exit 0
}catch {
 Write-HostProofEvent @{kind='phase';phase=$phase;state='failed';start_tick=$start;end_tick=[Diagnostics.Stopwatch]::GetTimestamp();diagnostic_sha256=Get-SanitizedHash $_.Exception.Message}
 exit 1
}
